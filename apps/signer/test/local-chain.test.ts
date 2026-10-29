import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  parseAbi,
  toBytes,
  type Abi,
  type Address,
} from "viem";
import { foundry } from "viem/chains";
import { loadConfig } from "@czar/config";
import { runGasRefill } from "../src/gas-refill.ts";
import { returnableAtomic } from "../src/policy.ts";
import { createRpcTransactionPreparer } from "../src/runtime-adapters.ts";
import { pocketReturnGasReserve } from "../src/service.ts";
import { harness, NETWORK } from "./helpers.ts";

const enabled = process.env["CZAR_LOCAL_CHAIN"] === "1";
const localRpc = process.env["CZAR_LOCAL_CHAIN_RPC"] ?? "http://127.0.0.1:8545";
const deployments = resolve(process.cwd(), "../../deployments");
const outputPath = join(deployments, "arc-local.json");
const temporaryFiles: string[] = [];
let ownsDeploymentOutput = false;
type PublicRpc = ReturnType<typeof createPublicClient>;
type AnvilRpc = ReturnType<typeof createTestClient>;
type LocalSigner = Awaited<ReturnType<typeof harness>>;
type LocalSignerWithNetwork = LocalSigner & { network: { openEvidenceLog: Address } };
type LocalDeployment = {
  chainId: number;
  OpenEvidenceLog: Address;
  usdc: Address;
  gatewayWallet: Address;
  gatewayMinter: Address;
  gatewayDomain: number;
  jobEscrow: Address;
};

/** Circle's ERC-8183 job escrow, the deployment's `jobEscrow` (contracts/script/Deploy.s.sol:23, A4-01). */
const CIRCLE_JOB_ESCROW = "0x0747eef0706327138c69792bf28cd525089e4583";

afterAll(async () => {
  await Promise.all(temporaryFiles.map((path) => rm(path, { force: true })));
  if (ownsDeploymentOutput) await rm(outputPath, { force: true });
});

describe.skipIf(!enabled)("K8 local arc-anvil acceptance", () => {
  it("deploys locally, commits a zero test root, and pays gas from K8", async () => {
    const publicClient = createPublicClient({ chain: foundry, transport: http(localRpc) });
    const testClient = createTestClient({
      chain: foundry,
      mode: "anvil",
      transport: http(localRpc),
    });
    const deployer = createWalletClient({ chain: foundry, transport: http(localRpc) });
    const [sender] = await deployer.getAddresses();
    if (sender === undefined) throw new Error("arc-anvil returned no local sender address");
    const t = await createLocalSigner(publicClient);
    const deployment = await deployLocalContracts(t, sender);
    expect(deployment.chainId).toBe(31337);
    expect({
      usdc: deployment.usdc.toLowerCase(),
      gatewayWallet: deployment.gatewayWallet.toLowerCase(),
      gatewayMinter: deployment.gatewayMinter.toLowerCase(),
      gatewayDomain: deployment.gatewayDomain,
      jobEscrow: deployment.jobEscrow.toLowerCase(),
    }).toEqual({
      usdc: NETWORK.usdc,
      gatewayWallet: NETWORK.gatewayWallet,
      gatewayMinter: NETWORK.gatewayMinter,
      gatewayDomain: NETWORK.gatewayDomain,
      jobEscrow: CIRCLE_JOB_ESCROW,
    });
    await assertK8Commit(t, testClient, publicClient, deployment);
    await assertGasRefill(t, testClient, publicClient);
  }, 180_000);
});

/** Port of this case's own node (18610-18619 belong to the signer local-chain cases). */
const POCKET_RETURN_PORT = 18615;
const ARC_CHAIN_ID = 5_042_002;
const RETURN_VAULT: Address = "0x00000000000000000000000000000000000c2a21";
const POCKET_START_NATIVE = 1_234_567_891_234_567_891n;
/** Returns CZ-15 may need when the fee falls between them; each round can only shrink the remainder. */
const MAX_RETURN_ROUNDS = 5;
const ARC_USDC_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 value) returns (bool)",
]);

describe.skipIf(!enabled)("SCR-152 pocket return on a real arc-anvil", () => {
  let node: ChildProcess | undefined;
  afterAll(() => {
    node?.kill("SIGTERM");
  });

  it("signs only balance - gasReserve; the return mines and leaves an empty remainder", async () => {
    node = spawn(
      process.env["ARC_ANVIL"] ?? "arc-anvil",
      [
        "--network",
        "arc",
        "--chain-id",
        String(ARC_CHAIN_ID),
        "--port",
        String(POCKET_RETURN_PORT),
      ],
      { stdio: "ignore" },
    );
    const rpcUrl = `http://127.0.0.1:${POCKET_RETURN_PORT}`;
    const chain = defineChain({
      id: ARC_CHAIN_ID,
      name: "arc-anvil",
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const client = createPublicClient({ chain, transport: http(rpcUrl) });
    const testClient = createTestClient({ chain, mode: "anvil", transport: http(rpcUrl) });
    await waitForRpc(client);
    const usdcOf = (address: Address) =>
      client.readContract({
        address: NETWORK.usdc,
        abi: ARC_USDC_ABI,
        functionName: "balanceOf",
        args: [address],
      });
    const prepare = createRpcTransactionPreparer({ chainId: ARC_CHAIN_ID, rpcUrl, client });
    const t = await harness({
      prepareTransaction: prepare,
      projection: {
        pocket: async () => ({
          vault: RETURN_VAULT,
          envelopeId: 1n,
          state: "Funded",
          funded: 0n,
          pendingPullback: 0n,
          slowWithdrawalOpen: false,
        }),
        pocketBalances: async (pocket) => ({
          ...t.state.balances,
          usdc: await usdcOf(pocket),
          native: await client.getBalance({ address: pocket }),
        }),
      },
    });
    await testClient.setBalance({ address: t.pocket, value: POCKET_START_NATIVE });
    const sign = (amount: bigint) =>
      t.signer.sign("cz-15", {
        keyId: "K4",
        kind: "pocket-return",
        payload: { pocket: t.pocket, kind: "usdc", amount: amount.toString() },
      });

    // What CZ-15 computes from fresh reads, with the same preparer the signer signs with.
    const reserveFor = (amount: bigint) =>
      pocketReturnGasReserve(prepare, {
        usdc: NETWORK.usdc,
        pocket: t.pocket,
        vault: RETURN_VAULT,
        amount,
      });
    const balance = await usdcOf(t.pocket);
    const first = await returnableAtomic(balance, reserveFor);
    expect(first.returnable).toBeGreaterThan(0n);
    for (const amount of [balance, first.returnable + 1n, first.returnable - 1n]) {
      await expect(sign(amount)).rejects.toMatchObject({ rule: "pocket-return-value-mismatch" });
    }

    // Each signed return mines and leaves at most its gasReserve. The fee can fall after a block, which makes part
    // of that remainder returnable again (SCR-152 §2: "empty" is judged at the current fee), so CZ-15 returns
    // until nothing is returnable.
    let returned = 0n;
    for (let round = 0; round < MAX_RETURN_ROUNDS; round += 1) {
      const before = await usdcOf(t.pocket);
      const { returnable } = await returnableAtomic(before, reserveFor);
      if (returnable <= 0n) break;
      const signed = await sign(returnable);
      if (!("signedTransaction" in signed))
        throw new Error("pocket-return returned no transaction");
      const hash = await client.sendRawTransaction({
        serializedTransaction: signed.signedTransaction,
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      expect(receipt.status).toBe("success");
      returned += returnable;
      expect(await usdcOf(RETURN_VAULT)).toBe(returned);
      expect(await usdcOf(t.pocket)).toBeLessThanOrEqual(before - returnable);
    }
    const remainder = await usdcOf(t.pocket);
    expect((await returnableAtomic(remainder, reserveFor)).returnable).toBeLessThanOrEqual(0n);
    expect(remainder + returned).toBeLessThanOrEqual(balance);
    await expect(sign(1n)).rejects.toMatchObject({ rule: "pocket-empty" });
  }, 120_000);
});

async function waitForRpc(client: PublicRpc): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await client.getChainId();
      return;
    } catch {
      await new Promise((wake) => setTimeout(wake, 100));
    }
  }
  throw new Error("arc-anvil RPC did not start");
}

async function createLocalSigner(publicClient: PublicRpc): Promise<LocalSignerWithNetwork> {
  const network = {
    ...NETWORK,
    chainId: 31337,
    openEvidenceLog: "0x0000000000000000000000000000000000000001" as Address,
    nanoDomain: { ...NETWORK.nanoDomain, chainId: 31337 },
  };
  const signer = await harness({
    network,
    prepareTransaction: async (from, call) => ({
      type: "eip1559",
      chainId: 31337,
      nonce: await publicClient.getTransactionCount({ address: from }),
      gas: await publicClient.estimateGas({
        account: from,
        to: call.to,
        data: call.data,
        value: call.value,
      }),
      maxFeePerGas: (await publicClient.getGasPrice()) * 2n,
      maxPriorityFeePerGas: 1_000_000_000n,
      to: call.to,
      data: call.data,
      value: call.value,
    }),
    projection: {
      latestEvidenceRoot: async () => `0x${"0".repeat(64)}`,
      evidenceBatchExists: async (root) => root === `0x${"0".repeat(64)}`,
      nativeBalance: (address) => publicClient.getBalance({ address }),
    },
  });
  return Object.assign(signer, { network });
}

async function deployLocalContracts(
  signer: LocalSignerWithNetwork,
  sender: Address,
): Promise<LocalDeployment> {
  await ensureOutputPathIsUnused();
  const keysPath = join(deployments, ".arc-local-test-addresses.json");
  temporaryFiles.push(keysPath);
  await writeFile(keysPath, JSON.stringify(localDeploymentKeyAddresses(signer)), { mode: 0o600 });
  try {
    ownsDeploymentOutput = true;
    execFileSync(
      "bash",
      [
        "script/deploy.sh",
        localRpc,
        "../deployments/.arc-local-test-addresses.json",
        "../deployments/arc-local.json",
        "--broadcast",
        "--unlocked",
        "--sender",
        sender,
      ],
      { cwd: resolve(process.cwd(), "../../contracts"), encoding: "utf8" },
    );
  } catch (error) {
    const detail = error as NodeJS.ErrnoException & { stderr?: string };
    throw new Error(`local deploy helper failed: ${detail.stderr ?? detail.message}`, {
      cause: error,
    });
  }
  const deployment = JSON.parse(await readFile(outputPath, "utf8")) as LocalDeployment;
  signer.network.openEvidenceLog = deployment.OpenEvidenceLog;
  return deployment;
}

function localDeploymentKeyAddresses(signer: LocalSigner) {
  return Object.fromEntries(
    (["K3", "K5", "K6", "K7", "K20"] as const).map((key) => [
      key,
      { address: signer.address(key) },
    ]),
  );
}

async function ensureOutputPathIsUnused(): Promise<void> {
  try {
    await access(outputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("refusing to overwrite an existing deployments/arc-local.json");
}

async function assertK8Commit(
  signer: LocalSigner,
  testClient: AnvilRpc,
  publicClient: PublicRpc,
  deployment: LocalDeployment,
): Promise<void> {
  const address = signer.address("K8");
  await testClient.setBalance({ address, value: 1_000_000_000_000_000_000n });
  const before = await publicClient.getBalance({ address });
  const uri = `czar-archive:0x${"0".repeat(64)}`;
  const signed = await signer.signer.sign("cz-17", {
    keyId: "K8",
    kind: "oel-commit",
    payload: {
      kind: "1",
      root: `0x${"0".repeat(64)}`,
      prev: `0x${"0".repeat(64)}`,
      uriHash: keccak256(toBytes(uri)),
      uri,
    },
  });
  if (!("signedTransaction" in signed)) throw new Error("K8 did not produce a transaction");
  const hash = await publicClient.sendRawTransaction({
    serializedTransaction: signed.signedTransaction,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const after = await publicClient.getBalance({ address });
  const artifact = JSON.parse(
    await readFile(
      resolve(process.cwd(), "../../contracts/out/OpenEvidenceLog.sol/OpenEvidenceLog.json"),
      "utf8",
    ),
  ) as { abi: Abi };
  const count = await publicClient.readContract({
    address: deployment.OpenEvidenceLog,
    abi: artifact.abi,
    functionName: "count",
    args: [address, 1],
  });
  expect(receipt.status).toBe("success");
  expect(receipt.from.toLowerCase()).toBe(address.toLowerCase());
  expect(after).toBeLessThan(before);
  expect(count).toBe(1n);
}

async function assertGasRefill(
  signer: LocalSigner,
  testClient: AnvilRpc,
  publicClient: PublicRpc,
): Promise<void> {
  const keys = ["K3", "K7", "K8"] as const;
  for (const key of keys) await testClient.setBalance({ address: signer.address(key), value: 0n });
  const relayer = signer.address("relayer");
  await testClient.setBalance({ address: relayer, value: 1_000_000_000_000_000_000n });
  const alerts: string[] = [];
  const results = await runGasRefill(localGasRefillOptions(signer, publicClient, alerts));
  expect(results.map(({ key, status }) => [key, status])).toEqual(
    keys.map((key) => [key, "refilled"]),
  );
  expect(alerts).toEqual([]);

  await testClient.setBalance({ address: signer.address("K3"), value: 0n });
  await testClient.setBalance({ address: relayer, value: 0n });
  const failed = await runGasRefill(localGasRefillOptions(signer, publicClient, alerts));
  expect(failed[0]).toMatchObject({ key: "K3", status: "failed" });
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toContain("relayer");
}

function localGasRefillOptions(signer: LocalSigner, publicClient: PublicRpc, alerts: string[]) {
  return {
    config: loadConfig(),
    signer: signer.signer,
    keyAddress: (key: "K3" | "K7" | "K8") => signer.address(key),
    getNativeBalance: (address: Address) => publicClient.getBalance({ address }),
    submitTransaction: async (transaction: `0x${string}`) => {
      const hash = await publicClient.sendRawTransaction({ serializedTransaction: transaction });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("gas refill reverted on arc-anvil");
    },
    alert: async (message: string) => {
      alerts.push(message);
    },
  };
}
