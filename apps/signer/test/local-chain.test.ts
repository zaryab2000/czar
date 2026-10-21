import { execFileSync } from "node:child_process";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  keccak256,
  toBytes,
  type Abi,
  type Address,
} from "viem";
import { foundry } from "viem/chains";
import { loadConfig } from "@czar/config";
import { runGasRefill } from "../src/gas-refill.ts";
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
type LocalDeployment = { chainId: number; OpenEvidenceLog: Address };

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
    await assertK8Commit(t, testClient, publicClient, deployment);
    await assertGasRefill(t, testClient, publicClient);
  }, 180_000);
});

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
