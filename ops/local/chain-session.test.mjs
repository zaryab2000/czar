import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PIN_PATH,
  SESSION_PATH,
  ensureDatabase,
  parseArgs,
  prepare,
  sessionEnvironment,
} from "./chain-session.mjs";
import { forkPinRecord, recordForkPin } from "./fork-anvil.mjs";

const FORK_BLOCK = 69_373_956n;
const START = FORK_BLOCK + 3n;
const HEAD = FORK_BLOCK + 9n;
const HASH_A = `0xabcdef12${"0".repeat(56)}`;
const HASH_B = `0x12345678${"0".repeat(56)}`;
const BASE_DB = "postgres://postgres@127.0.0.1:15433/postgres";

function node({
  fork = FORK_BLOCK,
  chainId = "0x4cef52",
  head = HEAD,
  hash = HASH_A,
  nodeInfoError = false,
} = {}) {
  const calls = [];
  const fetchFn = async (_url, options) => {
    const { method, params } = JSON.parse(options.body);
    calls.push({ method, params });
    if (method === "anvil_nodeInfo" && nodeInfoError) {
      return Response.json({ jsonrpc: "2.0", id: 1, error: { message: "no such method" } });
    }
    const result =
      method === "anvil_nodeInfo"
        ? { forkConfig: fork === null ? {} : { forkBlockNumber: Number(fork) } }
        : method === "eth_chainId"
          ? chainId
          : method === "eth_blockNumber"
            ? `0x${head.toString(16)}`
            : method === "eth_getBlockByNumber"
              ? hash === null
                ? null
                : { hash }
              : null;
    return Response.json({ jsonrpc: "2.0", id: 1, result });
  };
  return { fetchFn, calls };
}

function pinText(overrides = {}) {
  return JSON.stringify({
    chainId: "5042002",
    forkBlock: FORK_BLOCK.toString(),
    pinReason: "initial_pin",
    indexerStartBlock: START.toString(),
    ...overrides,
  });
}

function harness({ pin = pinText(), session = null, databases = new Set() } = {}) {
  const sql = [];
  const writes = [];
  return {
    sql,
    writes,
    databases,
    deps: {
      sql: (query) => {
        sql.push(query);
        const exists = /datname = '([^']+)'/.exec(query);
        if (exists) return databases.has(exists[1]) ? "1\n" : "";
        const create = /^CREATE DATABASE "([^"]+)"$/.exec(query);
        if (create) {
          databases.add(create[1]);
          return "";
        }
        throw new Error(`unexpected SQL ${query}`);
      },
      readText: async (path) => {
        if (path === PIN_PATH) {
          if (pin === null) throw Object.assign(new Error("missing"), { code: "ENOENT" });
          return pin;
        }
        if (path === SESSION_PATH) {
          if (session === null) throw Object.assign(new Error("missing"), { code: "ENOENT" });
          return session;
        }
        throw new Error(`unexpected read ${path}`);
      },
      write: async (path, value) => writes.push({ path, value }),
    },
  };
}

const argv = (role, mode = "fork") => ["--role", role, "--mode", mode, "--", "pnpm", "start"];
const env = { CZAR_DATABASE_URL: BASE_DB, CZAR_ARC_RPC_URL: "http://127.0.0.1:8545" };

async function refuses(t, { nodeOptions, pin, mode = "fork", envOverrides = {}, field }) {
  const h = harness({ pin });
  await assert.rejects(
    prepare({
      argv: argv("indexer", mode),
      env: { ...env, ...envOverrides },
      fetchFn: node(nodeOptions).fetchFn,
      ...h.deps,
    }),
    (error) => {
      assert.match(error.message, field);
      return true;
    },
  );
  assert.deepEqual(h.sql, [], `${t.name}: no SQL before checks pass`);
  assert.deepEqual(h.writes, [], `${t.name}: nothing written before checks pass`);
}

test("FORK fail-fast cases exit before any SQL or write", async (t) => {
  const cases = [
    { name: "missing pin", pin: null, field: /^pin: .*missing/ },
    { name: "pin not JSON", pin: "{", field: /^pin: .*JSON/ },
    { name: "chainId missing", pin: pinText({ chainId: undefined }), field: /^pin\.chainId/ },
    { name: "chainId numeric", pin: pinText({ chainId: 5042002 }), field: /^pin\.chainId/ },
    {
      name: "chainId wrong",
      pin: pinText({ chainId: "1" }),
      field: /^pin\.chainId: must be 5042002/,
    },
    { name: "forkBlock negative", pin: pinText({ forkBlock: "-1" }), field: /^pin\.forkBlock/ },
    { name: "forkBlock hex", pin: pinText({ forkBlock: "0x10" }), field: /^pin\.forkBlock/ },
    { name: "forkBlock zero", pin: pinText({ forkBlock: "0" }), field: /^pin\.forkBlock/ },
    { name: "pinReason missing", pin: pinText({ pinReason: "" }), field: /^pin\.pinReason/ },
    {
      name: "start missing",
      pin: pinText({ indexerStartBlock: undefined }),
      field: /^pin\.indexerStartBlock/,
    },
    {
      name: "start decimal fraction",
      pin: pinText({ indexerStartBlock: "1.5" }),
      field: /^pin\.indexerStartBlock/,
    },
    {
      name: "pin fork differs from node",
      nodeOptions: { fork: FORK_BLOCK + 1n },
      field: /^pin\.forkBlock: .*does not match/,
    },
    {
      name: "start equals fork",
      pin: pinText({ indexerStartBlock: FORK_BLOCK.toString() }),
      field: /greater than forkBlock/,
    },
    {
      name: "start above head",
      pin: pinText({ indexerStartBlock: (HEAD + 1n).toString() }),
      field: /must not exceed the node head/,
    },
    { name: "eth_chainId wrong", nodeOptions: { chainId: "0x1" }, field: /^node\.chainId/ },
    {
      name: "anvil_nodeInfo missing",
      nodeOptions: { nodeInfoError: true },
      field: /^rpc: anvil_nodeInfo/,
    },
    {
      name: "node is not a fork",
      nodeOptions: { fork: null },
      field: /^mode: fork mode requested/,
    },
    { name: "start hash unreadable", nodeOptions: { hash: null }, field: /^startBlock\.hash/ },
    {
      name: "non-loopback RPC",
      envOverrides: { CZAR_ARC_RPC_URL: "https://rpc.testnet.arc.io" },
      field: /^rpc: local RPC must be loopback/,
    },
  ];
  for (const c of cases) {
    await t.test(c.name, (st) => refuses(st, c));
  }
});

test("CLEAN mode refuses a fork node and starts at block 0 otherwise", async () => {
  const fork = harness({ pin: null });
  await assert.rejects(
    prepare({ argv: argv("indexer", "clean"), env, fetchFn: node().fetchFn, ...fork.deps }),
    /CZAR_LOCAL_MODE=fork/,
  );
  assert.deepEqual(fork.sql, []);

  const clean = harness({ pin: null });
  const chain = node({ fork: null, head: 12n });
  const prepared = await prepare({
    argv: argv("indexer", "clean"),
    env,
    fetchFn: chain.fetchFn,
    ...clean.deps,
  });
  assert.equal(prepared.live.startBlock, 0n);
  assert.equal(prepared.childEnv.CZAR_INDEXER_START_BLOCK, "0");
  assert.equal(prepared.live.database, "czar_clean_abcdef12");
  const blockRead = chain.calls.find((call) => call.method === "eth_getBlockByNumber");
  assert.deepEqual(blockRead.params, ["0x0", false]);
});

test("FORK mode starts at the pin's indexerStartBlock and routes to czar_fork_<S>", async () => {
  const h = harness();
  const chain = node();
  const prepared = await prepare({ argv: argv("indexer"), env, fetchFn: chain.fetchFn, ...h.deps });
  assert.equal(prepared.live.startBlock, START);
  assert.equal(prepared.childEnv.CZAR_INDEXER_START_BLOCK, START.toString());
  assert.equal(prepared.childEnv.DATABASE_SCHEMA, "czar_fork_abcdef12");
  assert.equal(
    prepared.childEnv.CZAR_DATABASE_URL,
    "postgres://postgres@127.0.0.1:15433/czar_fork_abcdef12",
  );
  assert.equal(prepared.childEnv.DATABASE_URL, prepared.childEnv.CZAR_DATABASE_URL);
  const blockRead = chain.calls.find((call) => call.method === "eth_getBlockByNumber");
  assert.deepEqual(blockRead.params, [`0x${START.toString(16)}`, false]);
  assert.equal(prepared.database, "created");
  assert.deepEqual(h.writes, [
    {
      path: SESSION_PATH,
      value: {
        mode: "fork",
        S: "abcdef12",
        startBlock: START.toString(),
        database: "czar_fork_abcdef12",
        indexerStartBlock: START.toString(),
      },
    },
  ]);
});

test("the same chain reuses its names; a new start-block hash gives new names", async () => {
  const databases = new Set();
  const first = harness({ databases });
  const a = await prepare({ argv: argv("indexer"), env, fetchFn: node().fetchFn, ...first.deps });
  const session = JSON.stringify(first.writes[0].value);
  const again = harness({ databases, session });
  const b = await prepare({ argv: argv("indexer"), env, fetchFn: node().fetchFn, ...again.deps });
  assert.equal(b.live.database, a.live.database);
  assert.equal(b.database, "reused");
  assert.deepEqual(again.writes, [], "same session is not rewritten");

  const fresh = harness({ databases, session });
  const c = await prepare({
    argv: argv("indexer"),
    env,
    fetchFn: node({ hash: HASH_B }).fetchFn,
    ...fresh.deps,
  });
  assert.equal(c.live.database, "czar_fork_12345678");
  assert.equal(c.database, "created");
  assert.equal(fresh.writes[0].value.S, "12345678");
  assert.ok(databases.has("czar_fork_abcdef12"), "old session database is kept");
});

test("no DROP is ever issued", async () => {
  const runs = [harness(), harness({ databases: new Set(["czar_fork_abcdef12"]) })];
  for (const h of runs) {
    await prepare({ argv: argv("indexer"), env, fetchFn: node().fetchFn, ...h.deps });
    for (const query of h.sql) assert.doesNotMatch(query, /\bDROP\b/i);
  }
  assert.throws(
    () => ensureDatabase("czar_fork_abcdef12; DROP DATABASE x", () => ""),
    /unexpected database name/,
  );
});

test("server, signer and merchants require the recorded session and get identical database URLs", async () => {
  const databases = new Set();
  const first = harness({ databases });
  await prepare({ argv: argv("indexer"), env, fetchFn: node().fetchFn, ...first.deps });
  const session = JSON.stringify(first.writes[0].value);
  const urls = [];
  for (const role of ["server", "signer", "merchants"]) {
    const h = harness({ databases, session });
    const prepared = await prepare({ argv: argv(role), env, fetchFn: node().fetchFn, ...h.deps });
    urls.push(prepared.childEnv.CZAR_DATABASE_URL);
    assert.deepEqual(h.writes, [], `${role} never writes the session`);
  }
  assert.equal(new Set(urls).size, 1);
  assert.equal(urls[0], "postgres://postgres@127.0.0.1:15433/czar_fork_abcdef12");
});

test("a session mismatch exits naming both values; a missing session refuses non-indexer roles", async () => {
  const stale = JSON.stringify({
    mode: "fork",
    S: "deadbeef",
    startBlock: START.toString(),
    database: "czar_fork_deadbeef",
  });
  const h = harness({ session: stale });
  await assert.rejects(
    prepare({ argv: argv("signer"), env, fetchFn: node().fetchFn, ...h.deps }),
    /recorded fork\/deadbeef does not match live fork\/abcdef12/,
  );
  assert.deepEqual(h.sql, []);
  const missing = harness();
  await assert.rejects(
    prepare({ argv: argv("server"), env, fetchFn: node().fetchFn, ...missing.deps }),
    /start the indexer first/,
  );
  assert.deepEqual(missing.sql, []);
});

test("argument and environment validation", () => {
  assert.throws(() => parseArgs(["--role", "server"]), /usage/);
  assert.throws(() => parseArgs(["--role", "web", "--", "x"]), /role/);
  assert.throws(() => parseArgs(["--role", "server", "--mode", "testnet", "--", "x"]), /mode/);
  assert.equal(parseArgs(["--role", "server", "--", "x"], {}).mode, "clean");
  assert.equal(
    parseArgs(["--role", "server", "--", "x"], { CZAR_LOCAL_MODE: "fork" }).mode,
    "fork",
  );
  assert.throws(
    () =>
      sessionEnvironment(
        {},
        {
          database: "czar_fork_abcdef12",
          schema: "czar_fork_abcdef12",
          startBlock: 1n,
          S: "abcdef12",
        },
      ),
    /CZAR_DATABASE_URL or DATABASE_URL is required/,
  );
});

test("the fork pin is written atomically with mode 0600 and decimal strings, dropping any start block", async () => {
  const directory = await mkdtemp(join(tmpdir(), "czar-pin-"));
  const path = join(directory, ".arc-fork-pin.json");
  await recordForkPin({ block: FORK_BLOCK, reason: "initial_pin" }, path);
  const written = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(written, {
    chainId: "5042002",
    forkBlock: FORK_BLOCK.toString(),
    pinReason: "initial_pin",
  });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(directory), [".arc-fork-pin.json"], "no temporary file is left");
  assert.equal("indexerStartBlock" in forkPinRecord({ block: 1n, reason: "x" }), false);
});

test("only the signer, which reads Ponder tables by SQL, gets the session schema on its search path", () => {
  const live = {
    database: "czar_clean_abcdef12",
    schema: "czar_clean_abcdef12",
    startBlock: 0n,
    S: "abcdef12",
  };
  const base = { CZAR_DATABASE_URL: "postgres://postgres@127.0.0.1:15433/postgres" };
  const signer = sessionEnvironment(base, live, "signer");
  assert.equal(signer.PGOPTIONS, "-c search_path=czar_clean_abcdef12,public");
  for (const role of ["indexer", "server", "merchants"]) {
    const other = sessionEnvironment(base, live, role);
    assert.equal(other.PGOPTIONS, undefined, role);
    // A2: every role gets the identical session database URL.
    assert.equal(other.CZAR_DATABASE_URL, signer.CZAR_DATABASE_URL, role);
  }
});
