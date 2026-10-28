// SCR-151 amendment A1: after a successful FORK deployment, record indexerStartBlock = the minimum
// blockNumber across the successful receipts of this deploy's broadcast run file. On any
// violation it fails and records nothing. On a clean (non-fork) node it records nothing.
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_RPC_URL,
  LOCAL_CHAIN_ID,
  assertLoopbackRpc,
  nodeForkBlock,
} from "./chain-session.mjs";

const ROOT = resolvePath(fileURLToPath(new URL("../..", import.meta.url)));
export const PIN_PATH = resolvePath(ROOT, "deployments/.arc-fork-pin.json");
export const RUN_FILE_PATH = resolvePath(
  ROOT,
  `contracts/broadcast/Deploy.s.sol/${LOCAL_CHAIN_ID}/run-latest.json`,
);
/** Tolerates coarse filesystem timestamps when checking that the run file is from this deploy. */
const MTIME_TOLERANCE_MS = 2_000;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

export class StartBlockError extends Error {}

function quantity(value, field) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) return BigInt(value);
  throw new StartBlockError(`run file ${field} is malformed`);
}

/** Pure A1 computation over the parsed run file. */
export function computeIndexerStartBlock(runFile, forkBlock) {
  if (typeof runFile !== "object" || runFile === null)
    throw new StartBlockError("run file is not an object");
  if (quantity(runFile.chain, "chain") !== LOCAL_CHAIN_ID) {
    throw new StartBlockError("run file chain is not 5042002");
  }
  const receipts = runFile.receipts;
  if (!Array.isArray(receipts) || receipts.length === 0)
    throw new StartBlockError("run file has no receipts");
  let minimum = null;
  for (const receipt of receipts) {
    if (quantity(receipt?.status, "receipt status") !== 1n) {
      throw new StartBlockError("a deployment receipt did not succeed");
    }
    const block = quantity(receipt.blockNumber, "receipt blockNumber");
    if (minimum === null || block < minimum) minimum = block;
  }
  if (minimum <= forkBlock)
    throw new StartBlockError("first deployment block is not after the fork block");
  return minimum;
}

/** Normalises an existing pin to the SCR-151 §1 decimal-string format. */
export function normalisePin(pin) {
  const chainId = typeof pin.chainId === "number" ? String(pin.chainId) : pin.chainId;
  if (chainId !== String(LOCAL_CHAIN_ID)) throw new StartBlockError("pin chainId is not 5042002");
  if (typeof pin.forkBlock !== "string" || !/^[1-9][0-9]*$/.test(pin.forkBlock)) {
    throw new StartBlockError("pin forkBlock is malformed");
  }
  if (typeof pin.pinReason !== "string" || pin.pinReason.length === 0) {
    throw new StartBlockError("pin pinReason is missing");
  }
  return { chainId, forkBlock: pin.forkBlock, pinReason: pin.pinReason };
}

async function rpc(fetchFn, url, method) {
  const response = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new StartBlockError(`${method} returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.error !== undefined) throw new StartBlockError(`${method} returned an error`);
  return payload.result;
}

async function writeAtomic(path, value) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

/**
 * mode "deployed": a deployment just ran in this invocation; compute and record (A1).
 * mode "existing": the deployment already existed on this chain; require a valid recorded value.
 */
export async function recordStartBlock({
  mode,
  deployStartedMs,
  rpcUrl = DEFAULT_RPC_URL,
  fetchFn = fetch,
  readText = (path) => readFile(path, "utf8"),
  mtimeMs = async (path) => (await stat(path)).mtimeMs,
  write = writeAtomic,
}) {
  assertLoopbackRpc(rpcUrl);
  const forkBlock = nodeForkBlock(await rpc(fetchFn, rpcUrl, "anvil_nodeInfo"));
  if (forkBlock === null) return { recorded: false, reason: "clean chain" };
  let pin;
  try {
    pin = JSON.parse(await readText(PIN_PATH));
  } catch {
    throw new StartBlockError("fork pin file is missing or unreadable");
  }
  const base = normalisePin(pin);
  if (BigInt(base.forkBlock) !== forkBlock) {
    throw new StartBlockError("fork pin does not match the running node's fork block");
  }
  if (mode === "existing") {
    const head = BigInt(await rpc(fetchFn, rpcUrl, "eth_blockNumber"));
    const value = pin.indexerStartBlock;
    if (
      typeof value !== "string" ||
      !DECIMAL.test(value) ||
      BigInt(value) <= forkBlock ||
      BigInt(value) > head
    ) {
      throw new StartBlockError(
        "deployment exists but no valid indexerStartBlock is recorded; restart arc-anvil for a fresh fork",
      );
    }
    return { recorded: false, reason: "existing deployment", indexerStartBlock: BigInt(value) };
  }
  if (!Number.isSafeInteger(deployStartedMs))
    throw new StartBlockError("deploy start time is required");
  let runText;
  try {
    if ((await mtimeMs(RUN_FILE_PATH)) < deployStartedMs - MTIME_TOLERANCE_MS) {
      throw new StartBlockError("run file predates this deployment");
    }
    runText = await readText(RUN_FILE_PATH);
  } catch (error) {
    if (error instanceof StartBlockError) throw error;
    throw new StartBlockError("broadcast run file is missing or unreadable");
  }
  let runFile;
  try {
    runFile = JSON.parse(runText);
  } catch {
    throw new StartBlockError("broadcast run file is not valid JSON");
  }
  const indexerStartBlock = computeIndexerStartBlock(runFile, forkBlock);
  await write(PIN_PATH, { ...base, indexerStartBlock: indexerStartBlock.toString() });
  return { recorded: true, indexerStartBlock };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const mode = args.includes("--existing-deployment") ? "existing" : "deployed";
  const startedIndex = args.indexOf("--deploy-started-ms");
  const deployStartedMs = startedIndex === -1 ? Number.NaN : Number(args[startedIndex + 1]);
  try {
    const result = await recordStartBlock({
      mode,
      deployStartedMs,
      rpcUrl: process.env["CZAR_ARC_RPC_URL"] ?? DEFAULT_RPC_URL,
    });
    if (result.recorded)
      process.stdout.write(`indexer start block recorded: ${result.indexerStartBlock}\n`);
    else process.stdout.write(`indexer start block: ${result.reason}\n`);
  } catch (error) {
    process.stderr.write(
      `indexer start block refused: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
