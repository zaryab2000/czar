// A pinned `arc-anvil --network arc` node per suite, the T-027 deploy helper, and small chain utilities for the
// CZAR_LOCAL_CHAIN signer suite (SCR-146 §3.3 run 2). Every node listens on loopback only.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type TransactionReceipt,
} from "viem";

export const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
export const CONTRACTS_DIR = `${REPO_ROOT}contracts`;
const DEPLOYMENTS_DIR = `${REPO_ROOT}deployments`;
const RPC_READY_ATTEMPTS = 100;
const POLL_MS = 100;

export type ArcNode = {
  readonly rpcUrl: string;
  readonly chain: Chain;
  readonly publicClient: ReturnType<typeof createPublicClient>;
  readonly testClient: ReturnType<typeof createTestClient>;
  /** The node's first unlocked account (Anvil account 0). */
  readonly sender: Address;
  stop(): void;
};

/** Spawns the pinned `arc-anvil` (or `ARC_ANVIL`) on a loopback port and waits for its RPC. */
export async function startArcNode(options: {
  readonly port: number;
  readonly chainId?: number;
}): Promise<ArcNode> {
  const args = ["--network", "arc", "--port", String(options.port)];
  if (options.chainId !== undefined) args.push("--chain-id", String(options.chainId));
  const child: ChildProcess = spawn(process.env["ARC_ANVIL"] ?? "arc-anvil", args, {
    stdio: "ignore",
  });
  const rpcUrl = `http://127.0.0.1:${options.port}`;
  const probe = createPublicClient({ transport: http(rpcUrl) });
  let chainId: number | undefined;
  await waitFor("arc-anvil RPC", RPC_READY_ATTEMPTS, async () => {
    if (child.exitCode !== null) throw new Error(`arc-anvil exited with ${child.exitCode}`);
    try {
      chainId = await probe.getChainId();
      return true;
    } catch {
      return false;
    }
  });
  const chain = defineChain({
    id: chainId as number,
    name: "arc-anvil",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const transport = http(rpcUrl);
  const testClient = createTestClient({ chain, transport, mode: "anvil" });
  const [sender] = await createWalletClient({ chain, transport }).getAddresses();
  if (sender === undefined) throw new Error("arc-anvil returned no unlocked account");
  return {
    rpcUrl,
    chain,
    publicClient: createPublicClient({ chain, transport }),
    testClient,
    sender,
    stop: () => {
      child.kill("SIGTERM");
    },
  };
}

/** Polls `check` until it returns true; `check` may throw to abort. */
export async function waitFor(
  label: string,
  attempts: number,
  check: () => Promise<boolean>,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`timed out waiting for ${label}`);
}

export type CzarDeployment = {
  readonly chainId: number;
  readonly CzarVaultFactory: Address;
  readonly OpenEvidenceLog: Address;
  readonly usdc: Address;
  readonly gatewayWallet: Address;
  readonly gatewayMinter: Address;
  readonly gatewayDomain: number;
  readonly jobEscrow: Address;
  /** Absolute path of the manifest; removed by `remove`. */
  readonly manifestPath: string;
  remove(): Promise<void>;
};

/**
 * Runs `contracts/script/deploy.sh` (T-027) against the node with the given public key addresses. The keys file
 * holds addresses only; the manifest is written under `deployments/` with a dot-prefixed per-run name.
 */
export async function deployCzar(
  node: ArcNode,
  tag: string,
  keyAddresses: Readonly<Record<"K3" | "K5" | "K6" | "K7" | "K20", Address>>,
): Promise<CzarDeployment> {
  const keysName = `.${tag}-keys.json`;
  const outName = `.${tag}.json`;
  const keysPath = `${DEPLOYMENTS_DIR}/${keysName}`;
  const manifestPath = `${DEPLOYMENTS_DIR}/${outName}`;
  const keys = Object.fromEntries(
    Object.entries(keyAddresses).map(([id, address]) => [id, { address, ref: `${tag}-${id}` }]),
  );
  await writeFile(keysPath, `${JSON.stringify(keys)}\n`, { mode: 0o600 });
  try {
    execFileSync(
      "bash",
      [
        "script/deploy.sh",
        node.rpcUrl,
        `../deployments/${keysName}`,
        `../deployments/${outName}`,
        "--offline",
        "--broadcast",
        "--unlocked",
        "--sender",
        node.sender,
      ],
      {
        cwd: CONTRACTS_DIR,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ARC_FORGE: process.env["ARC_FORGE"] ?? "arc-forge" },
      },
    );
  } catch (error) {
    const detail = error as NodeJS.ErrnoException & { stderr?: string };
    throw new Error(`local deploy helper failed: ${detail.stderr ?? detail.message}`, {
      cause: error,
    });
  } finally {
    await rm(keysPath, { force: true });
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Omit<
    CzarDeployment,
    "manifestPath" | "remove"
  >;
  return { ...manifest, manifestPath, remove: () => rm(manifestPath, { force: true }) };
}

/** Sends a signed raw transaction and requires a successful receipt. */
export async function submitSigned(node: ArcNode, transaction: Hex): Promise<TransactionReceipt> {
  const hash: Hash = await node.publicClient.sendRawTransaction({
    serializedTransaction: transaction,
  });
  const receipt = await node.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
  return receipt;
}

/** Unix seconds of the latest block. */
export async function chainNow(node: ArcNode): Promise<number> {
  const block = await node.publicClient.getBlock({ blockTag: "latest" });
  return Number(block.timestamp);
}
