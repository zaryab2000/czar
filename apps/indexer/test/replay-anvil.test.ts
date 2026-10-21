// Deterministic T-021 handler-action subset, broadcast in order:
// create vault; open envelope; reserve; register/fund pocket; request/confirm pullback;
// grant pocket gas; open/cancel job; write off pocket; finalize reservation; close envelope.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTree, derivedNonce, payeeLeaf, pocketLeaf, PAYEE_KIND } from "@czar/hashing";
import { czarVaultAbi, czarVaultFactoryAbi, withFeeFloor } from "@czar/vault-client";
import { envelopeMirror, jobMirror, pocketMirror, reservationMirror } from "@czar/indexer/mirrors";
import Ajv2020 from "ajv/dist/2020.js";
import {
  type Abi,
  type Address,
  type Hex,
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  getAbiItem,
  http,
  keccak256,
  parseEther,
  parseAbi,
} from "viem";
import { afterAll, expect, it } from "vitest";

const ROOT = new URL("../../../", import.meta.url);
const CONTRACTS = fileURLToPath(new URL("contracts/", ROOT));
const PONDER_ROOT = fileURLToPath(new URL("./fixtures/replay", import.meta.url));
const PONDER = fileURLToPath(new URL("../node_modules/.bin/ponder", import.meta.url));
const KEYS_FILE = "deployments/.indexer-replay-keys.json";
const OUT_FILE = "deployments/.indexer-replay.json";
const RPC_PORT = 18548;
const API_PORT = 18549;
const RPC = `http://127.0.0.1:${RPC_PORT}`;
const API = `http://127.0.0.1:${API_PORT}`;
const CHAIN_ID = 5042002;
const CIRCLE: Address = "0x0747EEf0706327138c69792bF28Cd525089e4583";
const GATEWAY_WALLET: Address = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const GATEWAY_MINTER: Address = "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B";
const USDC: Address = "0x3600000000000000000000000000000000000000";
const SYSTEM_EMITTER: Address = "0xfffffffffffffffffffffffffffffffffffffffe";
const SENDER: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ACTORS = {
  owner: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  agent: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  autonomy: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  guardian: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
  evaluator: "0x9965507D1a55bcC2695C58ba16a1aDd5Ff1B3A8F",
  admin: "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
  pocket: "0x14dc79964d58e7f7f5d5d0a3f9a3a7f97f4c7b8a",
  provider: "0x23618e81e3d64debf74d88a8847e8e3c34b69460",
  payee: "0xa0ee7a142d267c1f36714e4a8f75612f20a79720",
} as const satisfies Record<string, Address>;
const chain = {
  id: CHAIN_ID,
  name: "arc-anvil",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;
const transport = http(RPC);
const pub = createPublicClient({ chain, transport });
const test = createTestClient({ chain, transport, mode: "anvil" });
const HASH = `0x${"a".repeat(64)}` as Hex;
const ZERO = `0x${"0".repeat(64)}` as Hex;
const TEST_TIMEOUT = 180_000;
let replayedReservationId = 0n;
const gatewayAbi = parseAbi(["function addDelegate(address token, address delegate)"]);
const externalEmitterAbi = parseAbi([
  "function emitTransfer(address from,address to,uint256 value)",
  "function emitAuthorizationUsed(address authorizer,bytes32 nonce)",
]);
const ajv = new Ajv2020.default({ strict: false });
const schemaUrl = (name: string) =>
  new URL(`../../../docs/specs/02-data-and-protocol/schemas/${name}.schema.json`, import.meta.url);
for (const name of ["common", "envelope", "reservation", "pocket-record", "job-record"]) {
  ajv.addSchema(JSON.parse(readFileSync(schemaUrl(name), "utf8")) as object, name);
}
const pocketProjectionSchema = JSON.parse(readFileSync(schemaUrl("pocket-record"), "utf8")) as {
  $id: string;
  required: string[];
};
pocketProjectionSchema.$id = "https://czar.dev/schemas/pocket-record-projection.schema.json";
pocketProjectionSchema.required = pocketProjectionSchema.required.filter(
  (field) => field !== "keyRef",
);
ajv.addSchema(pocketProjectionSchema, "pocket-projection");

let anvil: ChildProcess | undefined;
let ponder: ChildProcess | undefined;
let pgliteDir: string | undefined;

afterAll(() => {
  ponder?.kill();
  anvil?.kill();
  if (pgliteDir) rmSync(pgliteDir, { recursive: true, force: true });
  for (const path of [KEYS_FILE, OUT_FILE]) {
    rmSync(fileURLToPath(new URL(path, ROOT)), { force: true });
  }
});

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > TEST_TIMEOUT) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function sendTo(
  who: Address,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
) {
  const wallet = createWalletClient({ chain, transport, account: who });
  const hash = await wallet.writeContract({
    address,
    abi,
    functionName,
    args,
    ...withFeeFloor({ maxFeePerGas: await pub.getGasPrice() }),
  } as never);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe("success");
  return receipt;
}

const send = (who: Address, abi: Abi, functionName: string, args: readonly unknown[]) =>
  sendTo(who, functionName === "createVault" ? factory : vault, abi, functionName, args);

let factory: Address;
let vault: Address;
let openEvidenceAddress: Address;

async function deploy(): Promise<void> {
  anvil = spawn(
    "arc-anvil",
    ["--network", "arc", "--chain-id", String(CHAIN_ID), "--port", String(RPC_PORT)],
    { stdio: "ignore" },
  );
  await waitFor(async () => {
    try {
      return (await pub.getChainId()) === CHAIN_ID;
    } catch {
      return false;
    }
  }, "arc-anvil");
  const keys = Object.fromEntries(
    [
      ["K3", ACTORS.agent],
      ["K5", ACTORS.autonomy],
      ["K6", ACTORS.guardian],
      ["K7", ACTORS.evaluator],
      ["K20", ACTORS.admin],
    ].map(([id, address]) => [id, { address, ref: `indexer-replay-${id}` }]),
  );
  writeFileSync(fileURLToPath(new URL(KEYS_FILE, ROOT)), `${JSON.stringify(keys)}\n`);
  execFileSync(
    "script/deploy.sh",
    [RPC, `../${KEYS_FILE}`, `../${OUT_FILE}`, "--broadcast", "--unlocked", "--sender", SENDER],
    {
      cwd: CONTRACTS,
      stdio: "ignore",
      env: { ...process.env, ARC_FORGE: "arc-forge" },
    },
  );
  const output = JSON.parse(readFileSync(fileURLToPath(new URL(OUT_FILE, ROOT)), "utf8")) as {
    CzarVaultFactory: Address;
    OpenEvidenceLog: Address;
  };
  factory = output.CzarVaultFactory;
  openEvidenceAddress = output.OpenEvidenceLog;
  await send(ACTORS.owner, czarVaultFactoryAbi, "createVault", [ACTORS.owner]);
  vault = await pub.readContract({
    address: factory,
    abi: czarVaultFactoryAbi,
    functionName: "vaultOf",
    args: [ACTORS.owner],
  });
  await test.setBalance({ address: vault, value: parseEther("10") });
}

async function installCircleMock(): Promise<void> {
  const bytecode = execFileSync(
    "arc-forge",
    ["inspect", "MockCircleAgenticCommerce", "deployedBytecode"],
    { cwd: CONTRACTS, encoding: "utf8" },
  ).trim() as Hex;
  await test.setCode({ address: CIRCLE, bytecode });
  const whitelistSlot = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      ["0x0000000000000000000000000000000000000000", 7n],
    ),
  );
  await test.setStorageAt({ address: CIRCLE, index: whitelistSlot, value: `0x${"0".repeat(63)}1` });
}

async function installGatewayMocks(): Promise<void> {
  for (const [name, address] of [
    ["MockGatewayWallet", GATEWAY_WALLET],
    ["MockGatewayMinter", GATEWAY_MINTER],
  ] as const) {
    const bytecode = execFileSync("arc-forge", ["inspect", name, "deployedBytecode"], {
      cwd: CONTRACTS,
      encoding: "utf8",
    }).trim() as Hex;
    await test.setCode({ address, bytecode });
  }
  const supportedSlot = keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [USDC, 1n]),
  );
  await test.setStorageAt({
    address: GATEWAY_WALLET,
    index: supportedSlot,
    value: `0x${"0".repeat(63)}1`,
  });
  await test.impersonateAccount({ address: ACTORS.pocket });
  await test.setBalance({ address: ACTORS.pocket, value: parseEther("1") });
}

async function emitExternalTransfers(reservationId: bigint): Promise<void> {
  const bytecode = execFileSync(
    "arc-forge",
    ["inspect", "MockExternalEventEmitter", "deployedBytecode"],
    {
      cwd: CONTRACTS,
      encoding: "utf8",
    },
  ).trim() as Hex;
  await test.setCode({ address: USDC, bytecode });
  await test.setCode({ address: SYSTEM_EMITTER, bytecode });
  // The derived nonce of authorization index 0, so the authorizations projection marks it used.
  const nonce = derivedNonce(vault, reservationId, 0);
  const authorizationReceipt = await sendTo(
    SENDER,
    USDC,
    externalEmitterAbi,
    "emitAuthorizationUsed",
    [vault, nonce],
  );
  const usdcTransferReceipt = await sendTo(SENDER, USDC, externalEmitterAbi, "emitTransfer", [
    vault,
    ACTORS.payee,
    1_234_567n,
  ]);
  const nativeTransferReceipt = await sendTo(
    SENDER,
    SYSTEM_EMITTER,
    externalEmitterAbi,
    "emitTransfer",
    [vault, ACTORS.payee, 1_234_567_000_000_000_000n],
  );
  expect(authorizationReceipt.logs).toHaveLength(1);
  expect(usdcTransferReceipt.logs).toHaveLength(1);
  expect(nativeTransferReceipt.logs).toHaveLength(1);
  expect(authorizationReceipt.logs[0]?.address.toLowerCase()).toBe(USDC.toLowerCase());
  expect(usdcTransferReceipt.logs[0]?.address.toLowerCase()).toBe(USDC.toLowerCase());
  expect(nativeTransferReceipt.logs[0]?.address.toLowerCase()).toBe(SYSTEM_EMITTER.toLowerCase());
}

async function replayPocket(envelopeId: bigint, proof: Hex[]): Promise<bigint> {
  await send(ACTORS.agent, czarVaultAbi, "registerPocket", [envelopeId, ACTORS.pocket, proof]);
  await send(ACTORS.agent, czarVaultAbi, "grantPocketGas", [ACTORS.pocket, 100n]);
  await sendTo(ACTORS.pocket, GATEWAY_WALLET, gatewayAbi, "addDelegate", [USDC, vault]);
  await send(ACTORS.agent, czarVaultAbi, "fundPocket", [ACTORS.pocket, 100_000n]);
  const maxBlockHeight = (await pub.getBlockNumber()) + 100n;
  await send(ACTORS.agent, czarVaultAbi, "requestPullback", [
    ACTORS.pocket,
    50_000n,
    0n,
    maxBlockHeight,
  ]);
  const pullbackId = await pub.readContract({
    address: vault,
    abi: czarVaultAbi,
    functionName: "pullbackCount",
  });
  const pullback = await pub.readContract({
    address: vault,
    abi: czarVaultAbi,
    functionName: "getPullback",
    args: [pullbackId],
  });
  const usedSlot = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }],
      [pullback.transferSpecHash, 0n],
    ),
  );
  await test.setStorageAt({
    address: GATEWAY_MINTER,
    index: usedSlot,
    value: `0x${"0".repeat(63)}1`,
  });
  await test.setBalance({
    address: vault,
    value: (await pub.getBalance({ address: vault })) + 50_000n * 1_000_000_000_000n,
  });
  await send(ACTORS.owner, czarVaultAbi, "confirmPullback", [pullbackId]);
  return pullbackId;
}

async function replay(): Promise<{
  envelopeId: bigint;
  reservationId: bigint;
  pullbackId: bigint;
  jobKey: Hex;
  approvalTx: Hex;
}> {
  const one = 1_000_000n;
  const payee = payeeLeaf(ACTORS.payee, PAYEE_KIND.X402_PAY_TO, 0, one);
  const provider = payeeLeaf(ACTORS.provider, PAYEE_KIND.ERC8183_PROVIDER, 1, one);
  const pocket = pocketLeaf(ACTORS.pocket);
  const tree = buildTree([payee, provider, pocket]);
  const now = (await pub.getBlock()).timestamp;
  const openedEnvelope = await send(ACTORS.owner, czarVaultAbi, "openEnvelope", [
    {
      cap: 3n * one,
      maxStepAmount: one,
      pocketCapBps: 2500,
      expiresAt: now + 86_400n,
      categoryId: HASH,
      objectiveHash: HASH,
      planHash: HASH,
      payeeRoot: tree.root,
    },
  ]);
  const envelopeId = await pub.readContract({
    address: vault,
    abi: czarVaultAbi,
    functionName: "envelopeCount",
  });
  await send(ACTORS.agent, czarVaultAbi, "reserve", [
    envelopeId,
    0,
    ACTORS.payee,
    one,
    tree.proof(payee),
    1_000n,
    2,
    now + 300n,
  ]);
  const reservationId = await pub.readContract({
    address: vault,
    abi: czarVaultAbi,
    functionName: "reservationCount",
  });
  const pullbackId = await replayPocket(envelopeId, tree.proof(pocket));
  await send(ACTORS.agent, czarVaultAbi, "openJob", [
    envelopeId,
    1,
    ACTORS.provider,
    one,
    tree.proof(provider),
    now + 3_600n,
    ZERO,
  ]);
  const opened = await pub.getLogs({
    address: vault,
    fromBlock: 0n,
    event: getAbiItem({ abi: czarVaultAbi, name: "JobOpened" }),
  });
  const latest = opened.at(-1);
  if (!latest || !latest.args || !("jobKey" in latest.args)) {
    throw new Error("JobOpened event missing after openJob");
  }
  const jobKey = latest.args.jobKey as Hex;
  await send(ACTORS.owner, czarVaultAbi, "cancelJob", [jobKey]);
  await send(ACTORS.agent, czarVaultAbi, "writeOffPocket", [ACTORS.pocket]);
  await test.setNextBlockTimestamp({ timestamp: now + 301n });
  await send(ACTORS.owner, czarVaultAbi, "finalize", [reservationId, 0, 2]);
  await send(ACTORS.owner, czarVaultAbi, "closeEnvelope", [envelopeId]);
  await test.mine({ blocks: 1050 });
  return {
    envelopeId,
    reservationId,
    pullbackId,
    jobKey,
    approvalTx: openedEnvelope.transactionHash,
  };
}

async function indexedMirrors(): Promise<{
  vaults: string[];
  envelopes: Record<string, unknown>[];
  reservations: Record<string, unknown>[];
  pockets: Record<string, unknown>[];
  jobs: Record<string, unknown>[];
  steps: Record<string, unknown>[];
}> {
  pgliteDir = mkdtempSync(join(tmpdir(), "czar-t031-replay-"));
  ponder = spawn(
    PONDER,
    ["--root", PONDER_ROOT, "start", "--port", String(API_PORT), "--schema", "t031_replay"],
    {
      env: {
        ...process.env,
        CZAR_TEST_RPC_URL: RPC,
        CZAR_TEST_FACTORY: factory,
        CZAR_TEST_OPEN_EVIDENCE: openEvidenceAddress,
        CZAR_TEST_PGLITE_DIR: pgliteDir,
        CZAR_TEST_GATEWAY_POLL_DISABLED: "1",
      },
      stdio: "ignore",
    },
  );
  await waitFor(async () => {
    try {
      return (await fetch(`${API}/health`)).ok;
    } catch {
      return false;
    }
  }, "Ponder HTTP server");
  await test.mine({ blocks: 10 });
  let mirrors: Awaited<ReturnType<typeof indexedMirrors>> | undefined;
  await waitFor(async () => {
    try {
      const response = await fetch(`${API}/mirrors`);
      if (!response.ok) return false;
      mirrors = (await response.json()) as Awaited<ReturnType<typeof indexedMirrors>>;
      const eventResponse = await fetch(`${API}/external-events`);
      if (!eventResponse.ok) return false;
      const events = (await eventResponse.json()) as {
        name: string;
        emitter: string;
        payload: Record<string, unknown>;
      }[];
      const relevant = (name: string, emitter: Address, payload: Record<string, unknown>) =>
        events.some(
          (event) =>
            event.name === name &&
            event.emitter === emitter.toLowerCase() &&
            Object.entries(payload).every(([key, value]) => event.payload[key] === value),
        );
      if (
        !relevant("AuthorizationUsed", USDC, {
          authorizer: vault.toLowerCase(),
          nonce: derivedNonce(vault, replayedReservationId, 0),
        }) ||
        !relevant("Transfer", USDC, {
          from: vault.toLowerCase(),
          to: ACTORS.payee.toLowerCase(),
          amount: "1234567",
        }) ||
        !relevant("Transfer", SYSTEM_EMITTER, {
          from: vault.toLowerCase(),
          to: ACTORS.payee.toLowerCase(),
          amount: "1234567",
        })
      ) {
        return false;
      }
      return (
        mirrors.envelopes.length === 1 &&
        mirrors.reservations.length === 1 &&
        mirrors.pockets.length === 1 &&
        mirrors.jobs.length === 1 &&
        mirrors.envelopes[0]?.["state"] === "Closed" &&
        mirrors.reservations[0]?.["state"] === "Final" &&
        mirrors.jobs[0]?.["state"] === "Released" &&
        Array.isArray(mirrors.pockets[0]?.["pullbacks"])
      );
    } catch {
      return false;
    }
  }, "four indexed mirrors");
  if (!mirrors) throw new Error("Ponder returned no mirror data");
  return mirrors;
}

it(
  "replays T-021 handler action types on arc-anvil into four on-chain mirrors",
  async () => {
    await deploy();
    await installCircleMock();
    await installGatewayMocks();
    const { envelopeId, reservationId, pullbackId, jobKey, approvalTx } = await replay();
    replayedReservationId = reservationId;
    await emitExternalTransfers(reservationId);
    const mirrors = await indexedMirrors();
    expect(mirrors.vaults).toEqual([vault.toLowerCase()]);
    const envelopeEventBlock = BigInt(String(mirrors.envelopes[0]?.["lastEventBlock"]));
    const envelope = await pub.readContract({
      address: vault,
      abi: czarVaultAbi,
      functionName: "getEnvelope",
      args: [envelopeId],
      blockNumber: envelopeEventBlock,
    });
    const reservation = await pub.readContract({
      address: vault,
      abi: czarVaultAbi,
      functionName: "getReservation",
      args: [reservationId],
    });
    const pocket = await pub.readContract({
      address: vault,
      abi: czarVaultAbi,
      functionName: "getPocket",
      args: [ACTORS.pocket],
    });
    const job = await pub.readContract({
      address: vault,
      abi: czarVaultAbi,
      functionName: "getJob",
      args: [jobKey],
    });
    const pullback = await pub.readContract({
      address: vault,
      abi: czarVaultAbi,
      functionName: "getPullback",
      args: [pullbackId],
    });
    const finalBlock = await pub.getBlock({ blockNumber: envelopeEventBlock });
    expect(mirrors.envelopes[0]).toEqual(
      envelopeMirror({
        vault,
        envelopeId,
        view: envelope,
        approvalTx,
        block: envelopeEventBlock,
        timestamp: finalBlock.timestamp,
        closeStarted: true,
      }),
    );
    expect(mirrors.reservations[0]).toEqual(reservationMirror(vault, reservationId, reservation));
    expect(mirrors.pockets[0]).toEqual(
      pocketMirror({
        vault,
        pocket: ACTORS.pocket,
        view: pocket,
        delegateReady: false,
        pullbacks: [
          {
            pullbackId: Number(pullbackId),
            value: pullback.value.toString(),
            salt: pullback.salt.toLowerCase() as Hex,
            maxFee: pullback.maxFee.toString(),
            maxBlockHeight: Number(pullback.maxBlockHeight),
            transferSpecHash: pullback.transferSpecHash.toLowerCase() as Hex,
            requestedAtBlock: Number(pullback.requestedAtBlock),
            state: "Confirmed",
            recovery: pullback.recovery,
            creditedToEnvelope: true,
          },
        ],
      }),
    );
    expect(mirrors.jobs[0]).toEqual(
      jobMirror({
        vault,
        jobKey,
        view: job,
        jobEscrow: CIRCLE,
        evaluator: ACTORS.evaluator,
        descriptionHash: ZERO,
      }),
    );
    expect(mirrors.steps).toEqual(
      expect.arrayContaining([
        { envelopeId: String(envelopeId), stepIndex: 0, used: "0" },
        { envelopeId: String(envelopeId), stepIndex: 1, used: "0" },
      ]),
    );
    expect(ajv.getSchema("envelope")?.(mirrors.envelopes[0])).toBe(true);
    expect(ajv.getSchema("reservation")?.(mirrors.reservations[0])).toBe(true);
    expect(ajv.getSchema("job-record")?.(mirrors.jobs[0])).toBe(true);
    expect(mirrors.pockets[0]).not.toHaveProperty("keyRef");
    expect(ajv.getSchema("pocket-projection")?.(mirrors.pockets[0])).toBe(true);
    const externalResponse = await fetch(`${API}/external-events`);
    expect(externalResponse.ok).toBe(true);
    const externalEvents = (await externalResponse.json()) as {
      name: string;
      emitter: string;
      payload: Record<string, unknown>;
    }[];
    const transfers = externalEvents.filter((event) => event.name === "Transfer");
    expect(transfers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          emitter: USDC.toLowerCase(),
          payload: expect.objectContaining({
            from: vault.toLowerCase(),
            to: ACTORS.payee.toLowerCase(),
            amount: "1234567",
          }),
        }),
        expect.objectContaining({
          emitter: SYSTEM_EMITTER.toLowerCase(),
          payload: expect.objectContaining({
            from: vault.toLowerCase(),
            to: ACTORS.payee.toLowerCase(),
            amount: "1234567",
          }),
        }),
      ]),
    );
    expect(
      externalEvents.find((event) => event.name === "AuthorizationUsed")?.payload,
    ).toMatchObject({
      authorizer: vault.toLowerCase(),
      nonce: derivedNonce(vault, reservationId, 0),
    });

    // T-034: every CZ-19 §5.4 query through the real Ponder/Postgres API process.
    const query = async (path: string) => {
      const response = await fetch(`${API}/q${path}`);
      expect(response.status, path).toBe(200);
      return (await response.json()) as Record<string, unknown>;
    };
    const envelopeRef = String(mirrors.envelopes[0]?.["envelopeRef"]);
    const byRef = await query(`/envelopes/${encodeURIComponent(envelopeRef)}`);
    expect(byRef).toEqual({
      envelope: mirrors.envelopes[0],
      reservations: mirrors.reservations,
      pockets: mirrors.pockets,
      jobs: mirrors.jobs,
    });
    const receipts = (await query(`/receipts?vault=${vault.toLowerCase()}`)) as {
      items: { rail: string; status: string; reservationId: string | null; index: number | null }[];
      nextCursor: string | null;
    };
    // Two authorizations, finalized unsettled (index 0 was used but never settled); one job,
    // cancelled before funding.
    expect(receipts.items.map((item) => [item.rail, item.status, item.index])).toEqual([
      ["x402-exact", "released", 0],
      ["x402-exact", "released", 1],
      ["erc8183-job", "released", null],
    ]);
    expect(receipts.nextCursor).toBeNull();
    const vaultQuery = `vault=${vault.toLowerCase()}`;
    const head = await pub.getBlockNumber();
    for (const path of [
      `/reservations/needing-settle?${vaultQuery}`,
      `/reservations/needing-finalize?now=${(await pub.getBlock()).timestamp}`,
      "/pullbacks/to-confirm",
      `/pullbacks/to-cancel?block=${head}`,
      "/jobs/to-sync",
      "/jobs/awaiting-evaluation",
    ]) {
      expect(await query(path), path).toEqual({ items: [], nextCursor: null });
    }
    expect(
      await query(`/anchors/latest?publisher=${ACTORS.admin.toLowerCase()}&kind=1`),
    ).toBeNull();
  },
  TEST_TIMEOUT,
);
