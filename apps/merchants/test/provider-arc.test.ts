// PM-046 on the pinned `arc-anvil --network arc` (skipped unless CZAR_LOCAL_CHAIN=1): every CZ-20 §5.11
// behaviour mode run against `MockCzarJobEscrow`, signed through the real signer's `provider-call` policy behind
// the real signer socket, with the caller wiring from `createLocalSignerPolicy()` (czar-provider-a → K21a,
// czar-provider-b → K21b). Each case asserts the mode's on-chain effect. Needs `arc-anvil` on PATH (or ARC_ANVIL)
// and the Foundry artifacts (`cd contracts && FOUNDRY_PROFILE=arc arc-forge build`).
//
// The signer runs in this process on an in-memory keystore: throwaway keys generated per run, never on disk.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  parseAbi,
  zeroAddress,
  type Abi,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { loadConfig } from "@czar/config";
import { jobKey, type Hash32 } from "@czar/hashing";
import {
  createLocalSignerPolicy,
  createRpcTransactionPreparer,
  createSigner,
  createSignerClient,
  memoryAudit,
  openLocalKeystore,
  startSignerSocket,
  type KeystoreFs,
  type Projection,
  type SignerBackend,
  type SignerClient,
  type SignerNetwork,
} from "@czar/signer";
import {
  createHttpJobServer,
  createProviderInstance,
  createRpcProviderChain,
  type BehaviourMode,
  type JobOutcome,
  type ProviderInstanceId,
  type ProviderSigner,
} from "#src/provider/index";
import { makeBrief, serverDouble, type ServerDouble } from "#test/provider-fixtures";

const enabled = process.env["CZAR_LOCAL_CHAIN"] === "1";
const REPO_ROOT = new URL("../../../", import.meta.url);
const PORT = 18_650;
const CHAIN_ID = 31_337;
const USDC: Address = "0x3600000000000000000000000000000000000000";
const BUDGET_CAP = 250_000n;
const TARGET = 200_000n;
const POLL_MS = 50;
const JOB_LIFETIME_SEC = 3_600;
const EVALUATION_WINDOW_SEC = 600;
const ONE_USDC_NATIVE = 10n ** 18n;
const RPC_READY_ATTEMPTS = 100;
const TEST_TIMEOUT_MS = 120_000;
const FAST_KDF = { N: 1024, r: 8, p: 1 };
const STATUS = { Open: 0, Funded: 1, Submitted: 2 } as const;

const USDC_ABI = parseAbi(["function approve(address spender, uint256 value) returns (bool)"]);
const ESCROW_EVENTS = parseAbi([
  "event BudgetSet(uint256 indexed jobId, address indexed token, uint256 amount)",
  "event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable)",
]);
const CIRCLE_EVENTS = parseAbi(["event BudgetSet(uint256 indexed jobId, uint256 amount)"]);

type Artifact = { abi: Abi; bytecode: { object: Hex } };
const artifact = (name: string): Artifact =>
  JSON.parse(
    readFileSync(new URL(`contracts/out/${name}.sol/${name}.json`, REPO_ROOT), "utf8"),
  ) as Artifact;

/** An in-memory keystore filesystem: the throwaway keys of this run never touch the disk. */
function memoryFs(): KeystoreFs {
  const files = new Map<string, { data: string; mode: number }>();
  const dirs = new Map<string, number>();
  return {
    async stat(path) {
      if (dirs.has(path)) return { mode: dirs.get(path) as number, isDirectory: true };
      const file = files.get(path);
      return file === undefined ? undefined : { mode: file.mode, isDirectory: false };
    },
    async mkdir(path, mode) {
      dirs.set(path, mode);
    },
    async list(path) {
      return [...files.keys()]
        .filter((name) => dirname(name) === path)
        .map((name) => name.slice(path.length + 1));
    },
    async read(path) {
      const file = files.get(path);
      if (file === undefined) throw new Error("ENOENT");
      return file.data;
    },
    async create(path, data, mode) {
      if (files.has(path)) throw new Error("EEXIST");
      files.set(path, { data, mode });
    },
    async remove(path) {
      files.delete(path);
    },
  };
}

function network(jobEscrow: Address): SignerNetwork {
  return {
    chainId: CHAIN_ID,
    usdc: USDC,
    gatewayWallet: "0x0077777d7eba4688bdef3e311b846f25870a19b9",
    gatewayMinter: "0x0022222abe238cc2c7bb1f21003f0a260052475b",
    gatewayDomain: 26,
    jobEscrow,
    openEvidenceLog: zeroAddress,
    nanoDomain: {
      name: "GatewayWalletBatched",
      version: "1",
      chainId: CHAIN_ID,
      verifyingContract: "0x0077777d7eba4688bdef3e311b846f25870a19b9",
    },
    merchantServices: [],
  };
}

/** The first event's named argument (undefined when there is no event). */
function eventArg(logs: readonly { args: unknown }[], name: string): unknown {
  const first = logs[0];
  return first === undefined ? undefined : (first.args as Record<string, unknown>)[name];
}

type Node = {
  chain: Chain;
  publicClient: ReturnType<typeof createPublicClient>;
  testClient: ReturnType<typeof createTestClient>;
  wallet: ReturnType<typeof createWalletClient>;
  sender: Address;
  stop(): void;
};

async function startNode(): Promise<Node> {
  const child: ChildProcess = spawn(
    process.env["ARC_ANVIL"] ?? "arc-anvil",
    ["--network", "arc", "--port", String(PORT)],
    { stdio: "ignore" },
  );
  const rpcUrl = `http://127.0.0.1:${PORT}`;
  const probe = createPublicClient({ transport: http(rpcUrl) });
  let chainId: number | undefined;
  for (let attempt = 0; attempt < RPC_READY_ATTEMPTS && chainId === undefined; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`arc-anvil exited with ${child.exitCode}`);
    chainId = await probe.getChainId().catch(() => undefined);
    if (chainId === undefined) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (chainId !== CHAIN_ID) throw new Error(`arc-anvil chain id ${chainId}; expected ${CHAIN_ID}`);
  const chain = defineChain({
    id: CHAIN_ID,
    name: "arc-anvil",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const transport = http(rpcUrl);
  const wallet = createWalletClient({ chain, transport });
  const [sender] = await wallet.getAddresses();
  if (sender === undefined) throw new Error("arc-anvil returned no unlocked account");
  return {
    chain,
    publicClient: createPublicClient({ chain, transport }),
    testClient: createTestClient({ chain, transport, mode: "anvil" }),
    wallet,
    sender,
    stop: () => child.kill("SIGTERM"),
  };
}

describe.skipIf(!enabled)(
  "PM-046 on arc-anvil: behaviour modes signed through provider-call",
  () => {
    let node: Node;
    let backend: SignerBackend;
    let escrow: Address;
    let circle: Address;
    let escrowAbi: Abi;
    let circleAbi: Abi;
    let server: ServerDouble;
    let client: SignerClient;
    let audit: ReturnType<typeof memoryAudit>;
    let stopSocket: () => Promise<void>;
    let socketDir: string;
    const address = (ref: string) => backend.address(ref) as Address;

    const send = async (to: Address, abi: Abi, functionName: string, args: readonly unknown[]) => {
      const hash = await node.wallet.writeContract({
        account: node.sender,
        chain: node.chain,
        address: to,
        abi,
        functionName,
        args,
      });
      const receipt = await node.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
    };
    const deploy = async (name: string, args: readonly unknown[]) => {
      const { abi, bytecode } = artifact(name);
      const hash = await node.wallet.deployContract({
        account: node.sender,
        chain: node.chain,
        abi,
        bytecode: bytecode.object,
        args,
      });
      const receipt = await node.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.contractAddress === null || receipt.contractAddress === undefined)
        throw new Error(`${name} not deployed`);
      return { address: receipt.contractAddress, abi };
    };
    const chainNow = async () =>
      Number((await node.publicClient.getBlock({ blockTag: "latest" })).timestamp);
    const warpPast = async (target: number) => {
      const now = await chainNow();
      if (now <= target) await node.testClient.increaseTime({ seconds: target - now + 1 });
      await node.testClient.mine({ blocks: 1 });
    };

    /** The signer's projection reads, from the chain (the indexer's job mirror in production) and the server double. */
    function chainProjection(at: Address, abi: Abi, kind: "czar" | "circle"): Projection {
      return {
        async job(_escrow: Address, jobId: bigint) {
          const job = (await node.publicClient.readContract({
            address: at,
            abi,
            functionName: "getJob",
            args: [jobId],
          })) as { client: Address; provider: Address; evaluator: Address };
          if (job.client === zeroAddress) return undefined;
          return { evaluator: job.evaluator, clientVault: job.client, provider: job.provider };
        },
        deliverableAccepted: async (key: Hash32, contentHash: Hash32) =>
          server.accepted.has(`${key.toLowerCase()}:${contentHash.toLowerCase()}`),
        kind,
      } as unknown as Projection;
    }

    beforeAll(async () => {
      node = await startNode();
      backend = await openLocalKeystore({
        path: "/keystore",
        passphrase: { kind: "prompt", read: async () => randomBytes(24).toString("hex") },
        fs: memoryFs(),
        git: async () => undefined,
        kdf: FAST_KDF,
      });
      for (const id of ["K7", "K21a", "K21b"] as const) await backend.createKey(id);
      for (const id of ["K21a", "K21b"])
        await node.testClient.setBalance({ address: address(id), value: ONE_USDC_NATIVE });

      const czar = await deploy("MockCzarJobEscrow", [node.sender, node.sender]);
      escrow = czar.address;
      escrowAbi = czar.abi;
      await send(escrow, escrowAbi, "setPaymentTokenAllowed", [USDC, true]);
      const circleMock = await deploy("MockCircleAgenticCommerce", [USDC, node.sender]);
      circle = circleMock.address;
      circleAbi = circleMock.abi;
      await send(USDC, USDC_ABI as Abi, "approve", [escrow, 2n ** 255n]);
      await send(USDC, USDC_ABI as Abi, "approve", [circle, 2n ** 255n]);

      server = serverDouble({
        chainId: CHAIN_ID,
        verify: true,
        nowSeconds: () => Math.floor(Date.now() / 1000),
      });
      audit = memoryAudit();
      const policy = createLocalSignerPolicy();
      const signer = createSigner({
        backend,
        projection: chainProjection(escrow, escrowAbi, "czar"),
        network: network(escrow),
        config: loadConfig(),
        audit,
        callers: policy.callers,
        prepareTransaction: createRpcTransactionPreparer({
          chainId: CHAIN_ID,
          client: node.publicClient,
        }),
      });
      socketDir = await mkdtemp(join(tmpdir(), "pm-046-"));
      const token = randomBytes(32).toString("hex");
      const identity = {
        tokenFor: async (service: string) => (service === "merchants" ? token : undefined),
      };
      const socketPath = join(socketDir, "run", "signer.sock");
      stopSocket = await startSignerSocket({
        socketPath,
        signer,
        audit,
        identity,
        allowedCallers: policy.allowedCallers,
      });
      client = await createSignerClient({ socketPath, service: "merchants", identity });
    }, TEST_TIMEOUT_MS);

    afterAll(async () => {
      await stopSocket?.();
      node?.stop();
      if (socketDir !== undefined) await rm(socketDir, { recursive: true, force: true });
    });

    /**
     * Opens one job for `instance` on `at`, runs the instance's watch step to the job's end, and plays the client:
     * funds a budget at or below the cap; with `warpAfterFunding` moves chain time past `submitBy` once funded; with
     * `warpAfterBudget` moves it past `submitBy` once any budget is set.
     */
    async function runJob(options: {
      instance: ProviderInstanceId;
      behaviour: BehaviourMode;
      at?: { address: Address; abi: Abi; kind: "czar" | "circle" };
      signer?: ProviderSigner;
      warpAfterFunding?: boolean;
      warpAfterBudget?: boolean;
    }) {
      const at = options.at ?? { address: escrow, abi: escrowAbi, kind: "czar" as const };
      const keyId = options.instance === "czar-provider-a" ? "K21a" : "K21b";
      const provider = address(keyId);
      const instance = createProviderInstance({
        instance: options.instance,
        modes: ["placeholder", options.behaviour],
        minWorkSeconds: 60,
        pollMs: POLL_MS,
        chainId: CHAIN_ID,
        evaluator: address("K7"),
        signer: options.signer ?? client,
        chain: createRpcProviderChain({ client: node.publicClient, escrow: at.address }),
        server: createHttpJobServer({ baseUrl: "http://127.0.0.1:3000", fetch: server.fetch }),
        providerAddress: provider,
      });
      await instance.start();
      const now = await chainNow();
      const expiredAt = now + JOB_LIFETIME_SEC;
      const submitBy = expiredAt - EVALUATION_WINDOW_SEC;
      const jobId =
        ((await node.publicClient.readContract({
          address: at.address,
          abi: at.abi,
          functionName: "jobCounter",
        })) as bigint) + 1n;
      const { brief, description } = makeBrief({
        escrow: at.address,
        jobId,
        chainId: CHAIN_ID,
        evaluator: address("K7"),
        expiredAt,
        submitBy,
        budgetCap: BUDGET_CAP,
        targetBudget: TARGET,
      });
      server.briefs.set(jobKey(at.address, jobId), { brief, provider });
      await send(
        at.address,
        at.abi,
        "createJob",
        at.kind === "czar"
          ? [provider, address("K7"), expiredAt, description, zeroAddress, 0n]
          : [provider, address("K7"), BigInt(expiredAt), description, zeroAddress],
      );
      const progress = { done: false };
      const playClient = async () => {
        let funded = false;
        let warped = false;
        while (!progress.done) {
          const job = (await node.publicClient.readContract({
            address: at.address,
            abi: at.abi,
            functionName: "getJob",
            args: [jobId],
          })) as { status: number; budget: bigint };
          if (!funded && job.status === STATUS.Open && job.budget > 0n) {
            if (job.budget <= BUDGET_CAP) {
              await send(
                at.address,
                at.abi,
                "fund",
                at.kind === "czar" ? [jobId, USDC, job.budget, "0x"] : [jobId, "0x"],
              );
              funded = true;
            } else if (options.warpAfterBudget && !warped) {
              await warpPast(submitBy);
              warped = true;
            }
          }
          if (funded && options.warpAfterFunding && !warped) {
            await warpPast(submitBy);
            warped = true;
          }
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
      };
      const clientLoop = playClient();
      let outcomes: readonly JobOutcome[] = [];
      try {
        // The watch step runs until it has seen and finished this job (a step may run before the block is visible).
        for (let attempt = 0; attempt < RPC_READY_ATTEMPTS && outcomes.length === 0; attempt += 1) {
          outcomes = await instance.tick();
          if (outcomes.length === 0) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
      } finally {
        progress.done = true;
        await clientLoop;
      }
      expect(outcomes).toHaveLength(1);
      const job = (await node.publicClient.readContract({
        address: at.address,
        abi: at.abi,
        functionName: "getJob",
        args: [jobId],
      })) as { status: number; budget: bigint; submittedAt?: number | bigint };
      const events = await node.publicClient.getContractEvents({
        address: at.address,
        abi: at.kind === "czar" ? ESCROW_EVENTS : CIRCLE_EVENTS,
        fromBlock: 0n,
        toBlock: "latest",
      });
      const mine = events.filter((log) => (log.args as { jobId?: bigint }).jobId === jobId);
      return {
        outcome: outcomes[0] as JobOutcome,
        job,
        jobId,
        brief,
        submitBy,
        budgetSet: mine.filter((log) => log.eventName === "BudgetSet"),
        submitted: mine.filter((log) => log.eventName === "JobSubmitted"),
      };
    }

    it("the caller wiring: each instance signs only with its own key, through the merchants socket service", async () => {
      await expect(
        client.sign("czar-provider-a", {
          keyId: "K21b",
          kind: "provider-call",
          payload: { escrow, jobId: "1", action: "brief-request", args: { issuedAt: "1" } },
        }),
      ).rejects.toMatchObject({ rule: "caller-not-owner" });
      await expect(
        client.sign("cz-20", {
          keyId: "K21a",
          kind: "provider-call",
          payload: { escrow, jobId: "1", action: "brief-request", args: { issuedAt: "1" } },
        }),
      ).rejects.toMatchObject({ rule: "caller-not-owner" });
      // CZ-27's keyAddress row (SCR-129) does not name K21a/K21b: the provider address is injected (PM-046 SCR).
      await expect(client.keyAddress("czar-provider-a", "K21a")).rejects.toMatchObject({
        rule: "key-not-allowed",
      });
    });

    it(
      "honest (K21a): budget = targetBudget, funded, upload accepted, submitted before submitBy",
      async () => {
        const r = await runJob({ instance: "czar-provider-a", behaviour: "honest" });
        expect(r.outcome).toMatchObject({ outcome: "submitted", budget: TARGET });
        expect(r.job.status).toBe(STATUS.Submitted);
        expect(r.job.budget).toBe(TARGET);
        expect(Number(r.job.submittedAt)).toBeLessThan(r.submitBy);
        const upload = server.uploads.find((u) => u.jobKey === r.outcome.jobKey);
        expect(upload?.contentHash).toBe(keccak256(upload?.bytes as Uint8Array));
        expect(eventArg(r.submitted, "deliverable")).toBe(upload?.contentHash);
        expect(
          audit.rows.filter((row) => row.outcome === "signed" && row.keyRef === "K21a").length,
        ).toBeGreaterThanOrEqual(4);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "honest (K21b): instance b signs its own job the same way",
      async () => {
        const r = await runJob({ instance: "czar-provider-b", behaviour: "honest" });
        expect(r.outcome.outcome).toBe("submitted");
        expect(r.job.status).toBe(STATUS.Submitted);
        expect(audit.rows.at(-1)).toMatchObject({
          outcome: "signed",
          keyRef: "K21b",
          caller: "czar-provider-b",
        });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "junk: submitted with the hash of well-formed bytes that fail the requirement check",
      async () => {
        const r = await runJob({ instance: "czar-provider-a", behaviour: "junk" });
        expect(r.outcome.outcome).toBe("submitted");
        expect(r.job.status).toBe(STATUS.Submitted);
        const upload = server.uploads.find((u) => u.jobKey === r.outcome.jobKey);
        const body = JSON.parse(new TextDecoder().decode(upload?.bytes)) as Record<string, string>;
        expect(Object.values(body).every((value) => value === "")).toBe(true);
        expect(eventArg(r.submitted, "deliverable")).toBe(upload?.contentHash);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "silent: no budget is ever set; the job stays Open with budget 0",
      async () => {
        const r = await runJob({ instance: "czar-provider-a", behaviour: "silent" });
        expect(r.outcome).toMatchObject({ outcome: "stopped", rule: "silent-no-budget" });
        expect(r.budgetSet).toEqual([]);
        expect(r.job.status).toBe(STATUS.Open);
        expect(r.job.budget).toBe(0n);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "early-submit: a zero-budget submit; the job is Submitted with budget 0 and was never funded",
      async () => {
        const r = await runJob({ instance: "czar-provider-a", behaviour: "early-submit" });
        expect(r.outcome.outcome).toBe("submitted");
        expect(r.budgetSet).toEqual([]);
        expect(r.job.status).toBe(STATUS.Submitted);
        expect(r.job.budget).toBe(0n);
        expect(r.submitted).toHaveLength(1);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "over-budget: budget set to budgetCap + 1, never funded, never submitted",
      async () => {
        const r = await runJob({
          instance: "czar-provider-a",
          behaviour: "over-budget",
          warpAfterBudget: true,
        });
        expect(r.outcome).toMatchObject({ outcome: "abandoned", rule: "not-funded" });
        expect(eventArg(r.budgetSet, "amount")).toBe(BUDGET_CAP + 1n);
        expect(r.job.budget).toBe(BUDGET_CAP + 1n);
        expect(r.job.status).toBe(STATUS.Open);
        expect(r.submitted).toEqual([]);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "late: funded, then submitted after submitBy (and before expiredAt)",
      async () => {
        const r = await runJob({
          instance: "czar-provider-a",
          behaviour: "late",
          warpAfterFunding: true,
        });
        expect(r.outcome.outcome).toBe("submitted");
        expect(r.job.status).toBe(STATUS.Submitted);
        expect(Number(r.job.submittedAt)).toBeGreaterThan(r.submitBy);
        expect(Number(r.job.submittedAt)).toBeLessThan(r.brief.expiredAt);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "no-upload: the signer refuses the submit (deliverable-not-accepted); the job stays Funded, never submitted",
      async () => {
        const uploadsBefore = server.uploads.length;
        const r = await runJob({ instance: "czar-provider-a", behaviour: "no-upload" });
        expect(r.outcome).toMatchObject({ outcome: "refused", rule: "deliverable-not-accepted" });
        expect(server.uploads.length).toBe(uploadsBefore);
        expect(r.job.status).toBe(STATUS.Funded);
        expect(r.submitted).toEqual([]);
        expect(audit.rows.at(-1)).toMatchObject({
          outcome: "kms_denied",
          rule: "deliverable-not-accepted",
          keyRef: "K21a",
          kind: "provider-call",
        });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "MockCircleAgenticCommerce is not the configured escrow: the signer refuses (unknown-escrow), nothing moves",
      async () => {
        const r = await runJob({
          instance: "czar-provider-a",
          behaviour: "honest",
          at: { address: circle, abi: circleAbi, kind: "circle" },
        });
        expect(r.outcome).toMatchObject({ outcome: "refused", rule: "unknown-escrow" });
        expect(r.budgetSet).toEqual([]);
        expect(r.job.status).toBe(STATUS.Open);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "open issue: with Circle's mock as the configured escrow, provider-call's setBudget does not match Circle's ABI",
      async () => {
        // CZ-20 §5.11 step 4 is `setBudget(jobId, targetBudget, "")` (Circle's 3-argument form, the testnet instance);
        // PM-058 encodes ICzarJobEscrow's `setBudget(jobId, token, amount, optParams)`. Circle's instance has no such
        // function, so the transaction cannot be prepared and no budget is set. Recorded for the architect (PM-046).
        const policy = createLocalSignerPolicy();
        const circleSigner = createSigner({
          backend,
          projection: chainProjection(circle, circleAbi, "circle"),
          network: network(circle),
          config: loadConfig(),
          audit: memoryAudit(),
          callers: policy.callers,
          prepareTransaction: createRpcTransactionPreparer({
            chainId: CHAIN_ID,
            client: node.publicClient,
          }),
        });
        const r = await runJob({
          instance: "czar-provider-a",
          behaviour: "honest",
          at: { address: circle, abi: circleAbi, kind: "circle" },
          signer: circleSigner,
        });
        // The signer's transaction preparer cannot estimate a call Circle's instance does not have.
        expect(r.outcome).toMatchObject({ outcome: "failed", rule: "provider-error" });
        expect(r.budgetSet).toEqual([]);
        expect(r.job.status).toBe(STATUS.Open);
        expect(r.job.budget).toBe(0n);
      },
      TEST_TIMEOUT_MS,
    );
  },
);
