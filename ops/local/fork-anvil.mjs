import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FORK_RPC_URL = "https://rpc.testnet.arc.io";
export const FORK_CHAIN_ID = 5042002;
export const FORK_BLOCK_OFFSET = 100n;
export const FORK_CODE_ADDRESSES = Object.freeze({
  entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  circleModularWalletsFactory: "0x0000000DF7E6c9Dc387cAFc5eCBfa6c3a6179AdD",
  usdc: "0x3600000000000000000000000000000000000000",
});

export async function resolveForkBlock(fetchFn = fetch, rpcUrl = FORK_RPC_URL) {
  return (await resolveForkPin(fetchFn, rpcUrl)).block;
}

export async function resolveForkPin(fetchFn = fetch, rpcUrl = FORK_RPC_URL, previousPin = null) {
  const chainId = BigInt(await rpc(fetchFn, rpcUrl, "eth_chainId", []));
  if (chainId !== BigInt(FORK_CHAIN_ID)) {
    throw new Error(`Arc testnet RPC returned chain id ${chainId}; expected ${FORK_CHAIN_ID}`);
  }
  const repinReason =
    previousPin === null
      ? "initial_pin"
      : await savedPinFailureReason(fetchFn, rpcUrl, previousPin);
  if (previousPin !== null && repinReason === null) {
    return {
      block: BigInt(previousPin.forkBlock),
      reason: previousPin.pinReason ?? "reused_saved_pin",
    };
  }
  const latest = BigInt(await rpc(fetchFn, rpcUrl, "eth_blockNumber", []));
  const pinned = latest - FORK_BLOCK_OFFSET;
  if (pinned <= 0n) throw new Error("Arc testnet head is too low to pin a fork");
  await checkContractCode(fetchFn, rpcUrl, pinned);
  return { block: pinned, reason: repinReason };
}

async function savedPinFailureReason(fetchFn, rpcUrl, previousPin) {
  // Accepts the SCR-151 decimal-string chain ID and the earlier numeric form.
  const savedChainId = String(previousPin.chainId);
  if (savedChainId !== String(FORK_CHAIN_ID) || !/^[1-9][0-9]*$/.test(previousPin.forkBlock)) {
    throw new Error("saved Arc fork pin metadata is invalid");
  }
  const savedBlock = BigInt(previousPin.forkBlock);
  const savedTag = `0x${savedBlock.toString(16)}`;
  if ((await rpc(fetchFn, rpcUrl, "eth_getBlockByNumber", [savedTag, false])) === null) {
    return "historical_state_unavailable";
  }
  const latestTag = `0x${BigInt(await rpc(fetchFn, rpcUrl, "eth_blockNumber", [])).toString(16)}`;
  for (const address of Object.values(FORK_CODE_ADDRESSES)) {
    const savedCode = await savedCodeAtPin(fetchFn, rpcUrl, address, savedTag);
    if (!isCode(savedCode)) return "historical_state_unavailable";
    const latestCode = await rpc(fetchFn, rpcUrl, "eth_getCode", [address, latestTag]);
    if (savedCode !== latestCode) return "required_contract_code_changed";
  }
  return null;
}

async function savedCodeAtPin(fetchFn, rpcUrl, address, blockTag) {
  try {
    return await rpc(fetchFn, rpcUrl, "eth_getCode", [address, blockTag]);
  } catch (error) {
    if (isPrunedStateError(error)) return "0x";
    throw error;
  }
}

function isPrunedStateError(error) {
  if (!(error instanceof ArcRpcError) || error.method !== "eth_getCode") return false;
  return /missing trie node|(?:historical )?state.{0,20}(unavailable|not available|pruned)|pruned state/i.test(
    error.message,
  );
}

async function checkContractCode(fetchFn, rpcUrl, block) {
  const tag = `0x${block.toString(16)}`;
  for (const [name, address] of Object.entries(FORK_CODE_ADDRESSES)) {
    const code = await rpc(fetchFn, rpcUrl, "eth_getCode", [address, tag]);
    if (!isCode(code)) throw new Error(`Arc testnet has no ${name} code at pinned block ${block}`);
  }
}

function isCode(code) {
  return typeof code === "string" && /^0x[\da-fA-F]+$/.test(code) && code !== "0x";
}

async function loadForkPin() {
  try {
    return JSON.parse(await readFile(forkPinPath(), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`could not read saved Arc fork pin: ${error.message}`, { cause: error });
  }
}

function forkPinPath() {
  return resolvePath(
    fileURLToPath(new URL("../../deployments/.arc-fork-pin.json", import.meta.url)),
  );
}

export async function runForkAnvil(options = {}) {
  const fetchFn = options.fetchFn ?? fetch;
  const rpcUrl = options.rpcUrl ?? FORK_RPC_URL;
  const previousPin = options.previousPin ?? (await loadForkPin());
  const pin = await resolveForkPin(fetchFn, rpcUrl, previousPin);
  const executable = options.executable ?? "arc-anvil";
  await recordForkPin(pin);
  const args = forkAnvilArguments(pin.block, rpcUrl);
  process.stdout.write(`Arc fork pinned at testnet block ${pin.block} (${pin.reason})\n`);
  return runChild(executable, args);
}

/**
 * SCR-151 §1: decimal strings, written atomically with mode 0600. Every arc-anvil start is a
 * fresh chain (--mnemonic-random, no state load), so any indexerStartBlock from an earlier chain
 * is dropped here; the FORK deploy step records the new one (ops/local/record-start-block.mjs).
 */
export function forkPinRecord(pin) {
  return { chainId: String(FORK_CHAIN_ID), forkBlock: pin.block.toString(), pinReason: pin.reason };
}

async function recordForkPin(pin, path = forkPinPath()) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(forkPinRecord(pin), null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

export { recordForkPin };

export function forkAnvilArguments(block, rpcUrl = FORK_RPC_URL) {
  const args = [
    "--network",
    "arc",
    "--chain-id",
    String(FORK_CHAIN_ID),
    "--fork-url",
    rpcUrl,
    "--fork-block-number",
    String(block),
    "--host",
    "127.0.0.1",
    "--mnemonic-random",
    "--block-time",
    "1",
    "--quiet",
    "--port",
    "8545",
  ];
  return args;
}

async function rpc(fetchFn, url, method, params) {
  const response = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Arc RPC ${method} failed with HTTP ${response.status}`);
  const payload = await response.json();
  if (typeof payload !== "object" || payload === null) {
    throw new Error(`Arc RPC ${method} returned an invalid response`);
  }
  if ("error" in payload) throw new ArcRpcError(method, payload.error);
  return payload.result;
}

class ArcRpcError extends Error {
  constructor(method, error) {
    const message =
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof error.message === "string"
        ? error.message
        : "unknown JSON-RPC error";
    super(`Arc RPC ${method} returned an error: ${message}`);
    this.method = method;
  }
}

function runChild(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: "inherit" });
    const forward = (signal) => child.kill(signal);
    const onInterrupt = () => forward("SIGINT");
    const onTerminate = () => forward("SIGTERM");
    const cleanup = () => {
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onTerminate);
    };
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (signal !== null) process.kill(process.pid, signal);
      else if (code !== 0) reject(new Error(`arc-anvil exited with status ${code}`));
      else resolve();
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href) {
  runForkAnvil().catch((error) => {
    process.stderr.write(`local fork startup refused: ${error.message}\n`);
    process.exitCode = 1;
  });
}
