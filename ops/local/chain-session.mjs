// SCR-151 §2 and amendment A2: one chain session per local stack run.
// Every local process that reads CZAR_DATABASE_URL or DATABASE_URL (indexer, server, signer,
// merchants) starts through this launcher. It validates the local node (and, in FORK mode, the
// pin file) before it writes anything or spawns anything, derives the session key S from the
// hash of the indexer start block, routes the process to database czar_<mode>_<S> (created only
// when absent; never dropped), sets the Ponder schema and start block, then runs the command.
import { spawn, spawnSync } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const LOCAL_CHAIN_ID = 5042002n;
export const LOCAL_CHAIN_ID_HEX = "0x4cef52";
export const DEFAULT_RPC_URL = "http://127.0.0.1:8545";
export const MODES = Object.freeze(["fork", "clean"]);
export const ROLES = Object.freeze(["indexer", "server", "signer", "merchants"]);
/** The indexer starts first in the process graph, so it establishes the session (A2). */
export const ESTABLISHING_ROLE = "indexer";
const SESSION_KEY_HEX_CHARS = 8;
const RPC_TIMEOUT_MS = 5_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const BLOCK_HASH = /^0x[0-9a-fA-F]{64}$/;

const ROOT = resolvePath(fileURLToPath(new URL("../..", import.meta.url)));
export const PIN_PATH = resolvePath(ROOT, "deployments/.arc-fork-pin.json");
export const SESSION_PATH = resolvePath(ROOT, "deployments/.arc-chain-session.json");

export class ChainSessionError extends Error {
  constructor(field, message) {
    super(`${field}: ${message}`);
    this.field = field;
  }
}

export function parseArgs(argv, env = process.env) {
  const separator = argv.indexOf("--");
  if (separator === -1 || separator === argv.length - 1) {
    throw new ChainSessionError(
      "command",
      "usage: chain-session.mjs --role <role> [--mode fork|clean] -- <command...>",
    );
  }
  const options = argv.slice(0, separator);
  const command = argv.slice(separator + 1);
  let mode = env["CZAR_LOCAL_MODE"] ?? "clean";
  let role = null;
  for (let index = 0; index < options.length; index += 2) {
    const flag = options[index];
    const value = options[index + 1];
    if (value === undefined) throw new ChainSessionError(flag, "missing value");
    if (flag === "--mode") mode = value;
    else if (flag === "--role") role = value;
    else throw new ChainSessionError(flag, "unknown option");
  }
  if (!MODES.includes(mode))
    throw new ChainSessionError("mode", `must be fork or clean, got ${mode}`);
  if (!ROLES.includes(role))
    throw new ChainSessionError("role", `must be one of ${ROLES.join(", ")}`);
  return { mode, role, command };
}

export function assertLoopbackRpc(rpcUrl) {
  let url;
  try {
    url = new URL(rpcUrl);
  } catch {
    throw new ChainSessionError("rpc", "local RPC URL is invalid");
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new ChainSessionError("rpc", "local RPC must be loopback http");
  }
}

function decimal(pin, field) {
  const value = pin[field];
  if (typeof value !== "string" || !DECIMAL.test(value)) {
    throw new ChainSessionError(`pin.${field}`, "must be a non-negative decimal string");
  }
  return BigInt(value);
}

/** Validates the SCR-151 §1 pin file format (decimal strings, chain 5042002). */
export function parsePin(text) {
  let pin;
  try {
    pin = JSON.parse(text);
  } catch {
    throw new ChainSessionError("pin", "pin file is not valid JSON");
  }
  if (typeof pin !== "object" || pin === null)
    throw new ChainSessionError("pin", "pin file is not an object");
  const chainId = decimal(pin, "chainId");
  if (chainId !== LOCAL_CHAIN_ID) throw new ChainSessionError("pin.chainId", "must be 5042002");
  const forkBlock = decimal(pin, "forkBlock");
  if (forkBlock === 0n) throw new ChainSessionError("pin.forkBlock", "must be greater than zero");
  if (typeof pin.pinReason !== "string" || pin.pinReason.length === 0) {
    throw new ChainSessionError("pin.pinReason", "must be a non-empty string");
  }
  const indexerStartBlock = decimal(pin, "indexerStartBlock");
  return { forkBlock, indexerStartBlock };
}

async function rpc(fetchFn, rpcUrl, method, params) {
  let response;
  try {
    response = await fetchFn(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
  } catch {
    throw new ChainSessionError("rpc", `${method} did not answer`);
  }
  if (!response.ok)
    throw new ChainSessionError("rpc", `${method} returned HTTP ${response.status}`);
  const payload = await response.json();
  if (typeof payload !== "object" || payload === null || "error" in payload) {
    throw new ChainSessionError("rpc", `${method} returned an error`);
  }
  return payload.result;
}

/** Reads the fork block from anvil_nodeInfo; null on a non-fork (clean) node. */
export function nodeForkBlock(nodeInfo) {
  const value = nodeInfo?.forkConfig?.forkBlockNumber;
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) return BigInt(value);
  throw new ChainSessionError("node.forkBlock", "anvil_nodeInfo fork block is malformed");
}

/**
 * All §2 checks. Reads only: nothing is written and nothing is spawned here.
 * Returns the session descriptor { mode, S, startBlock, database, schema }.
 */
export async function resolveSession({ mode, rpcUrl, fetchFn = fetch, readPinText }) {
  assertLoopbackRpc(rpcUrl);
  const nodeInfo = await rpc(fetchFn, rpcUrl, "anvil_nodeInfo", []);
  if (typeof nodeInfo !== "object" || nodeInfo === null) {
    throw new ChainSessionError("rpc", "anvil_nodeInfo did not answer");
  }
  const chainId = await rpc(fetchFn, rpcUrl, "eth_chainId", []);
  if (typeof chainId !== "string" || BigInt(chainId) !== LOCAL_CHAIN_ID) {
    throw new ChainSessionError("node.chainId", "eth_chainId must be 5042002");
  }
  const liveForkBlock = nodeForkBlock(nodeInfo);
  const head = BigInt(await rpc(fetchFn, rpcUrl, "eth_blockNumber", []));
  let startBlock;
  if (mode === "fork") {
    if (liveForkBlock === null) {
      throw new ChainSessionError("mode", "fork mode requested but the local node is not a fork");
    }
    let text;
    try {
      text = await readPinText();
    } catch {
      throw new ChainSessionError("pin", "deployments/.arc-fork-pin.json is missing or unreadable");
    }
    const pin = parsePin(text);
    if (pin.forkBlock !== liveForkBlock) {
      throw new ChainSessionError(
        "pin.forkBlock",
        `pin ${pin.forkBlock} does not match the node fork block ${liveForkBlock}`,
      );
    }
    if (pin.indexerStartBlock <= pin.forkBlock) {
      throw new ChainSessionError("pin.indexerStartBlock", "must be greater than forkBlock");
    }
    if (pin.indexerStartBlock > head) {
      throw new ChainSessionError("pin.indexerStartBlock", `must not exceed the node head ${head}`);
    }
    startBlock = pin.indexerStartBlock;
  } else {
    if (liveForkBlock !== null) {
      throw new ChainSessionError(
        "mode",
        "clean mode requested but the local node is a fork; set CZAR_LOCAL_MODE=fork",
      );
    }
    startBlock = 0n;
  }
  const block = await rpc(fetchFn, rpcUrl, "eth_getBlockByNumber", [
    `0x${startBlock.toString(16)}`,
    false,
  ]);
  if (typeof block?.hash !== "string" || !BLOCK_HASH.test(block.hash)) {
    throw new ChainSessionError("startBlock.hash", `block ${startBlock} hash is unreadable`);
  }
  const S = block.hash.slice(2, 2 + SESSION_KEY_HEX_CHARS).toLowerCase();
  const name = `czar_${mode}_${S}`;
  return { mode, S, startBlock, database: name, schema: name };
}

/** Rewrites only the database name of a postgres URL; credentials and host stay as given. */
export function sessionDatabaseUrl(baseUrl, database) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ChainSessionError("databaseUrl", "base database URL is invalid");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new ChainSessionError("databaseUrl", "base database URL must be postgres");
  }
  url.pathname = `/${database}`;
  return url.toString();
}

const SAFE_DATABASE = /^czar_(fork|clean)_[0-9a-f]{8}$/;

/** CREATE DATABASE only when absent. This module never issues DROP. */
export function ensureDatabase(database, sql) {
  if (!SAFE_DATABASE.test(database))
    throw new ChainSessionError("database", "unexpected database name");
  const exists = sql(`SELECT 1 FROM pg_database WHERE datname = '${database}'`);
  if (exists.trim() === "1") return "reused";
  try {
    sql(`CREATE DATABASE "${database}"`);
  } catch (error) {
    // A concurrent launcher may have created it between the check and the create.
    if (sql(`SELECT 1 FROM pg_database WHERE datname = '${database}'`).trim() === "1")
      return "reused";
    throw error;
  }
  return "created";
}

/** Default SQL runner: psql inside the local Postgres container (same path health.sh uses). */
export function dockerPsql(query) {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "-f",
      "ops/local/compose.yaml",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-Atc",
      query,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (result.status !== 0) throw new ChainSessionError("database", "psql failed");
  return result.stdout;
}

export function parseSessionFile(text) {
  const session = JSON.parse(text);
  if (
    !MODES.includes(session.mode) ||
    typeof session.S !== "string" ||
    !/^[0-9a-f]{8}$/.test(session.S) ||
    typeof session.startBlock !== "string" ||
    !DECIMAL.test(session.startBlock)
  ) {
    throw new ChainSessionError("session", "session file is malformed");
  }
  return session;
}

/**
 * A2: the indexer (first consumer) records the session for this chain; every other consumer
 * must find the same mode and S as the live node gives, or it exits naming both values.
 * Returns the session JSON to write, or null when the recorded session is already current.
 */
export function reconcileSession({ role, live, recordedText }) {
  let recorded = null;
  if (recordedText !== null) {
    try {
      recorded = parseSessionFile(recordedText);
    } catch {
      if (role !== ESTABLISHING_ROLE)
        throw new ChainSessionError("session", "session file is malformed");
    }
  }
  const current =
    recorded !== null &&
    recorded.mode === live.mode &&
    recorded.S === live.S &&
    recorded.startBlock === live.startBlock.toString();
  if (role === ESTABLISHING_ROLE) {
    if (current) return null;
    return {
      mode: live.mode,
      S: live.S,
      startBlock: live.startBlock.toString(),
      database: live.database,
      indexerStartBlock: live.startBlock.toString(),
    };
  }
  if (recorded === null) {
    throw new ChainSessionError("session", "no chain session recorded; start the indexer first");
  }
  if (!current) {
    throw new ChainSessionError(
      "session",
      `recorded ${recorded.mode}/${recorded.S} does not match live ${live.mode}/${live.S}`,
    );
  }
  return null;
}

async function writeAtomic(path, value) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

export function sessionEnvironment(env, live) {
  const base = env["CZAR_DATABASE_URL"] ?? env["DATABASE_URL"];
  if (base === undefined)
    throw new ChainSessionError("databaseUrl", "CZAR_DATABASE_URL or DATABASE_URL is required");
  const url = sessionDatabaseUrl(base, live.database);
  return {
    ...env,
    CZAR_DATABASE_URL: url,
    DATABASE_URL: url,
    // Ponder 0.18.2 reads the schema from DATABASE_SCHEMA (bin/commands/dev.js:359,
    // build/index.js:283) when --schema is not given.
    DATABASE_SCHEMA: live.schema,
    CZAR_INDEXER_START_BLOCK: live.startBlock.toString(),
    CZAR_CHAIN_SESSION: live.S,
  };
}

export async function prepare({
  argv,
  env = process.env,
  fetchFn = fetch,
  sql = dockerPsql,
  readText = (path) => readFile(path, "utf8"),
  write = writeAtomic,
}) {
  const { mode, role, command } = parseArgs(argv, env);
  const rpcUrl = env["CZAR_ARC_RPC_URL"] ?? DEFAULT_RPC_URL;
  const live = await resolveSession({
    mode,
    rpcUrl,
    fetchFn,
    readPinText: () => readText(PIN_PATH),
  });
  let recordedText = null;
  try {
    recordedText = await readText(SESSION_PATH);
  } catch (error) {
    if (error?.code !== "ENOENT")
      throw new ChainSessionError("session", "session file is unreadable");
  }
  const update = reconcileSession({ role, live, recordedText });
  const childEnv = sessionEnvironment(env, live);
  // Writes happen only after every check above has passed.
  const database = ensureDatabase(live.database, sql);
  if (update !== null) await write(SESSION_PATH, update);
  return { live, role, command, childEnv, database };
}

function run(command, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { stdio: "inherit", env });
    const forward = (signal) => child.kill(signal);
    const onInterrupt = () => forward("SIGINT");
    const onTerminate = () => forward("SIGTERM");
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onTerminate);
      resolve({ code, signal });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href) {
  try {
    const prepared = await prepare({ argv: process.argv.slice(2) });
    process.stdout.write(
      `chain session: mode=${prepared.live.mode} S=${prepared.live.S} startBlock=${prepared.live.startBlock} ` +
        `database=${prepared.live.database} (${prepared.database}) role=${prepared.role}\n`,
    );
    const { code, signal } = await run(prepared.command, prepared.childEnv);
    if (signal !== null) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  } catch (error) {
    process.stderr.write(
      `chain session refused: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
