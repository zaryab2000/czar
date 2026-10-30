// SCR-150 §1: places the Gateway test doubles at Circle's canonical GatewayWallet and GatewayMinter addresses on a
// CLEAN local Arc Anvil chain. Test and harness use only: it refuses a fork, a non-loopback RPC, a node that is not
// Arc Anvil, and canonical addresses that already hold code, so it can never overwrite Circle's contracts.
//
// Placement: deploy each mock normally (so immutables such as `controller` are baked into its runtime code), copy
// the runtime code to the canonical address with `anvil_setCode`, then call the one-time `initializeDouble` from the
// same deployer (the mock's `controller`), because `anvil_setCode` runs no constructor.
//
// Import from tests: `import { placeGatewayDoubles } from "<repo>/ops/local/gateway-doubles.ts"`.
// CLI: node --disable-warning=ExperimentalWarning --experimental-strip-types ops/local/gateway-doubles.ts
//        [--rpc http://127.0.0.1:8545] [--usdc 0x3600…0000]
// Requires the Foundry artifacts: `cd contracts && FOUNDRY_PROFILE=arc arc-forge build`.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isLoopbackHttpUrl } from "../../packages/config/src/index.ts";

/** contracts/script/Deploy.s.sol:21 (A2-01). */
export const CANONICAL_GATEWAY_WALLET = "0x0077777d7eba4688bdef3e311b846f25870a19b9";
/** contracts/script/Deploy.s.sol:22 (A2-01). */
export const CANONICAL_GATEWAY_MINTER = "0x0022222abe238cc2c7bb1f21003f0a260052475b";
/** Arc USDC (A1-01). */
export const ARC_USDC = "0x3600000000000000000000000000000000000000";

const DEFAULT_ARTIFACTS_DIR = fileURLToPath(new URL("../../contracts/out", import.meta.url));
const INITIALIZE_SIGNATURE = "initializeDouble(address)";
const RECEIPT_ATTEMPTS = 40;
const RECEIPT_RETRY_MS = 250;
const RPC_TIMEOUT_MS = 10_000;

export type RpcCall = (method: string, params: readonly unknown[]) => Promise<unknown>;

export type PlaceGatewayDoublesOptions = {
  /** Loopback JSON-RPC URL of the CLEAN Arc Anvil node. */
  readonly rpcUrl: string;
  /** USDC token the doubles accept; defaults to Arc USDC. */
  readonly usdc?: string;
  /** Foundry `out/` directory holding the compiled mocks. */
  readonly artifactsDir?: string;
  /** Injected for tests; defaults to a JSON-RPC client over `fetch`. */
  readonly rpc?: RpcCall;
  readonly fetchFn?: typeof fetch;
};

export type PlacedGatewayDoubles = {
  readonly gatewayWallet: string;
  readonly gatewayMinter: string;
  /** The node's first unlocked account: the doubles' `controller`, used by the stand-in for `testBurn`. */
  readonly controller: string;
};

export class GatewayDoublesRefused extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "GatewayDoublesRefused";
    this.reason = reason;
  }
}

type Artifact = {
  readonly bytecode: string;
  readonly methodIdentifiers: Readonly<Record<string, string>>;
};

/** SCR-150 §1: deploys, copies and initializes both doubles; refuses every case where that could be unsafe. */
export async function placeGatewayDoubles(
  options: PlaceGatewayDoublesOptions,
): Promise<PlacedGatewayDoubles> {
  if (!isLoopbackHttpUrl(options.rpcUrl)) {
    throw new GatewayDoublesRefused(
      "rpc-not-loopback",
      "Gateway doubles need a loopback Arc Anvil RPC.",
    );
  }
  const rpc = options.rpc ?? createRpcCall(options.rpcUrl, options.fetchFn ?? fetch);
  const usdc = (options.usdc ?? ARC_USDC).toLowerCase();
  if (!isAddress(usdc)) throw new GatewayDoublesRefused("invalid-usdc", "USDC address is invalid.");

  await requireCleanArcAnvil(rpc);
  for (const address of [CANONICAL_GATEWAY_WALLET, CANONICAL_GATEWAY_MINTER]) {
    const code = await rpc("eth_getCode", [address, "latest"]);
    if (typeof code !== "string" || code !== "0x") {
      throw new GatewayDoublesRefused(
        "canonical-code-present",
        `Refusing to overwrite existing code at ${address}.`,
      );
    }
  }
  const accounts = await rpc("eth_accounts", []);
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string" || !isAddress(accounts[0])) {
    throw new GatewayDoublesRefused("no-unlocked-account", "Arc Anvil has no unlocked account.");
  }
  const controller = accounts[0].toLowerCase();
  const artifactsDir = options.artifactsDir ?? DEFAULT_ARTIFACTS_DIR;
  const wallet = await readArtifact(artifactsDir, "MockGatewayWallet");
  const minter = await readArtifact(artifactsDir, "MockGatewayMinter");

  await placeOne(
    rpc,
    controller,
    wallet,
    `${wallet.bytecode}${word(usdc)}`,
    CANONICAL_GATEWAY_WALLET,
    usdc,
  );
  await placeOne(rpc, controller, minter, minter.bytecode, CANONICAL_GATEWAY_MINTER, usdc);
  return {
    gatewayWallet: CANONICAL_GATEWAY_WALLET,
    gatewayMinter: CANONICAL_GATEWAY_MINTER,
    controller,
  };
}

async function requireCleanArcAnvil(rpc: RpcCall): Promise<void> {
  let info: unknown;
  try {
    info = await rpc("anvil_nodeInfo", []);
  } catch {
    throw new GatewayDoublesRefused("not-anvil", "The RPC does not answer anvil_nodeInfo.");
  }
  if (!isRecord(info)) {
    throw new GatewayDoublesRefused("not-anvil", "anvil_nodeInfo returned no node information.");
  }
  const forkConfig = info["forkConfig"];
  if (
    isRecord(forkConfig) &&
    typeof forkConfig["forkUrl"] === "string" &&
    forkConfig["forkUrl"] !== ""
  ) {
    throw new GatewayDoublesRefused(
      "fork",
      "Gateway doubles are CLEAN mode only; this node is a fork.",
    );
  }
}

async function placeOne(
  rpc: RpcCall,
  controller: string,
  artifact: Artifact,
  deployData: string,
  canonical: string,
  usdc: string,
): Promise<void> {
  const deployHash = await rpc("eth_sendTransaction", [{ from: controller, data: deployData }]);
  const deployReceipt = await waitForSuccess(rpc, deployHash);
  const deployed = deployReceipt["contractAddress"];
  if (typeof deployed !== "string" || !isAddress(deployed)) {
    throw new Error("Mock deployment returned no contract address.");
  }
  const runtime = await rpc("eth_getCode", [deployed, "latest"]);
  if (typeof runtime !== "string" || runtime === "0x")
    throw new Error("Deployed mock has no runtime code.");
  await rpc("anvil_setCode", [canonical, runtime]);
  const selector = artifact.methodIdentifiers[INITIALIZE_SIGNATURE];
  if (typeof selector !== "string" || !/^[\da-f]{8}$/.test(selector)) {
    throw new Error(`Mock artifact has no ${INITIALIZE_SIGNATURE}.`);
  }
  const initHash = await rpc("eth_sendTransaction", [
    { from: controller, to: canonical, data: `0x${selector}${word(usdc)}` },
  ]);
  await waitForSuccess(rpc, initHash);
}

async function readArtifact(artifactsDir: string, name: string): Promise<Artifact> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(`${artifactsDir}/${name}.sol/${name}.json`, "utf8"));
  } catch {
    throw new GatewayDoublesRefused(
      "artifact-missing",
      `${name} artifact not found; run \`FOUNDRY_PROFILE=arc arc-forge build\` in contracts/ first.`,
    );
  }
  if (
    !isRecord(parsed) ||
    !isRecord(parsed["bytecode"]) ||
    !isRecord(parsed["methodIdentifiers"])
  ) {
    throw new GatewayDoublesRefused("artifact-invalid", `${name} artifact is malformed.`);
  }
  const bytecode = parsed["bytecode"]["object"];
  if (typeof bytecode !== "string" || !/^0x[\da-fA-F]+$/.test(bytecode)) {
    throw new GatewayDoublesRefused("artifact-invalid", `${name} artifact has no bytecode.`);
  }
  return {
    bytecode,
    methodIdentifiers: parsed["methodIdentifiers"] as Record<string, string>,
  };
}

async function waitForSuccess(rpc: RpcCall, hash: unknown): Promise<Record<string, unknown>> {
  if (typeof hash !== "string" || !/^0x[\da-fA-F]{64}$/.test(hash)) {
    throw new Error("Arc Anvil returned no transaction hash.");
  }
  for (let attempt = 0; attempt < RECEIPT_ATTEMPTS; attempt += 1) {
    const receipt = await rpc("eth_getTransactionReceipt", [hash]);
    if (isRecord(receipt)) {
      if (receipt["status"] !== "0x1") throw new Error("Gateway double transaction reverted.");
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, RECEIPT_RETRY_MS));
  }
  throw new Error("Gateway double transaction was not mined.");
}

function createRpcCall(url: string, fetchFn: typeof fetch): RpcCall {
  return async (method, params) => {
    const response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    const result: unknown = await response.json();
    if (!response.ok || !isRecord(result) || "error" in result || !("result" in result)) {
      throw new Error(`Arc Anvil RPC ${method} failed`);
    }
    return result["result"];
  };
}

function word(address: string): string {
  return address.slice(2).toLowerCase().padStart(64, "0");
}

function isAddress(value: string): boolean {
  return /^0x[\da-fA-F]{40}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  placeGatewayDoubles({
    rpcUrl: argument("--rpc") ?? process.env["CZAR_ARC_RPC_URL"] ?? "http://127.0.0.1:8545",
    usdc: argument("--usdc") ?? ARC_USDC,
  })
    .then((placed) => {
      process.stdout.write(
        `gateway doubles placed: wallet=${placed.gatewayWallet} minter=${placed.gatewayMinter}\n`,
      );
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : "gateway double placement failed"}\n`,
      );
      process.exitCode = 1;
    });
}
