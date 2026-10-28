import assert from "node:assert/strict";
import test from "node:test";
import {
  PIN_PATH,
  RUN_FILE_PATH,
  computeIndexerStartBlock,
  recordStartBlock,
} from "./record-start-block.mjs";

const FORK_BLOCK = 1_000n;
const STARTED = 1_700_000_000_000;

const receipt = (block, status = "0x1") => ({ blockNumber: `0x${block.toString(16)}`, status });
const runFile = (receipts, chainId = 5042002) => ({ chain: chainId, receipts });

test("A1 computation: minimum successful receipt block after the fork block", () => {
  assert.equal(
    computeIndexerStartBlock(
      runFile([receipt(1_005n), receipt(1_002n), receipt(1_009n)]),
      FORK_BLOCK,
    ),
    1_002n,
  );
  assert.equal(
    computeIndexerStartBlock(runFile([{ blockNumber: 1_001, status: 1 }]), FORK_BLOCK),
    1_001n,
  );
});

test("A1 computation refuses empty, failed, early and wrong-chain run files", () => {
  assert.throws(() => computeIndexerStartBlock(runFile([]), FORK_BLOCK), /no receipts/);
  assert.throws(() => computeIndexerStartBlock({ chain: 5042002 }, FORK_BLOCK), /no receipts/);
  assert.throws(
    () => computeIndexerStartBlock(runFile([receipt(1_002n), receipt(1_003n, "0x0")]), FORK_BLOCK),
    /did not succeed/,
  );
  assert.throws(
    () => computeIndexerStartBlock(runFile([receipt(FORK_BLOCK)]), FORK_BLOCK),
    /not after the fork block/,
  );
  assert.throws(
    () => computeIndexerStartBlock(runFile([receipt(1_002n)], 31337), FORK_BLOCK),
    /chain is not 5042002/,
  );
});

function chain({ fork = FORK_BLOCK, head = FORK_BLOCK + 20n } = {}) {
  return async (_url, options) => {
    const { method } = JSON.parse(options.body);
    const result =
      method === "anvil_nodeInfo"
        ? { forkConfig: fork === null ? {} : { forkBlockNumber: Number(fork) } }
        : `0x${head.toString(16)}`;
    return Response.json({ jsonrpc: "2.0", id: 1, result });
  };
}

function files({ pin, run, mtime = STARTED + 5 }) {
  const writes = [];
  return {
    writes,
    deps: {
      readText: async (path) => {
        const value = path === PIN_PATH ? pin : path === RUN_FILE_PATH ? run : undefined;
        if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return value;
      },
      mtimeMs: async (path) => {
        if (path !== RUN_FILE_PATH || run === undefined)
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return mtime;
      },
      write: async (path, value) => writes.push({ path, value }),
    },
  };
}

const pinJson = (extra = {}) =>
  JSON.stringify({
    chainId: 5042002,
    forkBlock: FORK_BLOCK.toString(),
    pinReason: "initial_pin",
    ...extra,
  });

test("records the start block atomically into the normalised pin after a fork deploy", async () => {
  const f = files({
    pin: pinJson(),
    run: JSON.stringify(runFile([receipt(1_004n), receipt(1_003n)])),
  });
  const result = await recordStartBlock({
    mode: "deployed",
    deployStartedMs: STARTED,
    fetchFn: chain(),
    ...f.deps,
  });
  assert.equal(result.indexerStartBlock, 1_003n);
  assert.deepEqual(f.writes, [
    {
      path: PIN_PATH,
      value: {
        chainId: "5042002",
        forkBlock: FORK_BLOCK.toString(),
        pinReason: "initial_pin",
        indexerStartBlock: "1003",
      },
    },
  ]);
});

test("records nothing on a clean chain", async () => {
  const f = files({ pin: undefined, run: undefined });
  const result = await recordStartBlock({
    mode: "deployed",
    deployStartedMs: STARTED,
    fetchFn: chain({ fork: null }),
    ...f.deps,
  });
  assert.equal(result.recorded, false);
  assert.deepEqual(f.writes, []);
});

test("fails and records nothing for a missing, stale, empty or failed run file, or a pin mismatch", async () => {
  const cases = [
    {
      name: "missing run file",
      files: { pin: pinJson(), run: undefined },
      error: /missing or unreadable/,
    },
    {
      name: "run file older than this deploy",
      files: {
        pin: pinJson(),
        run: JSON.stringify(runFile([receipt(1_003n)])),
        mtime: STARTED - 10_000,
      },
      error: /predates this deployment/,
    },
    {
      name: "empty receipts",
      files: { pin: pinJson(), run: JSON.stringify(runFile([])) },
      error: /no receipts/,
    },
    {
      name: "failed receipt",
      files: { pin: pinJson(), run: JSON.stringify(runFile([receipt(1_003n, "0x0")])) },
      error: /did not succeed/,
    },
    {
      name: "pin does not match the node",
      files: {
        pin: pinJson({ forkBlock: "999" }),
        run: JSON.stringify(runFile([receipt(1_003n)])),
      },
      error: /does not match the running node/,
    },
    { name: "missing pin", files: { pin: undefined, run: "{}" }, error: /pin file is missing/ },
  ];
  for (const c of cases) {
    const f = files(c.files);
    await assert.rejects(
      recordStartBlock({ mode: "deployed", deployStartedMs: STARTED, fetchFn: chain(), ...f.deps }),
      c.error,
      c.name,
    );
    assert.deepEqual(f.writes, [], `${c.name}: nothing recorded`);
  }
});

test("an existing fork deployment needs a valid recorded start block", async () => {
  const ok = files({ pin: pinJson({ indexerStartBlock: "1003" }) });
  const result = await recordStartBlock({ mode: "existing", fetchFn: chain(), ...ok.deps });
  assert.equal(result.indexerStartBlock, 1_003n);
  assert.deepEqual(ok.writes, []);
  for (const value of [undefined, "1000", "99999", "abc"]) {
    const f = files({ pin: pinJson(value === undefined ? {} : { indexerStartBlock: value }) });
    await assert.rejects(
      recordStartBlock({ mode: "existing", fetchFn: chain(), ...f.deps }),
      /no valid indexerStartBlock/,
    );
    assert.deepEqual(f.writes, []);
  }
});
