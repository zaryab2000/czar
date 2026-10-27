// T-030 acceptance: Ponder, through the Arc transport and the fault proxy, backfills 50,000 blocks;
// a SIGKILL part-way and a restart resume from the stored checkpoint instead of block 0, and the final
// projection holds every log exactly once.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeChain, type FakeChain } from "./support/fake-chain.ts";
import { startFaultProxy, type FaultProxy } from "./support/fault-rpc-proxy.ts";

const HEAD = 50_000n;
const LOG_EVERY = 500n;
/** Ends the backfill inside Ponder's finalized range so the test needs no live (head) indexing. */
const END_BLOCK = HEAD - 1_000n;
const PORT = 42_000 + Math.floor(Math.random() * 1000);
const ROOT = fileURLToPath(new URL("./fixtures/resume", import.meta.url));
const PONDER = fileURLToPath(new URL("../node_modules/.bin/ponder", import.meta.url));
const TIMEOUT_MS = 120_000;

let chain: FakeChain;
let proxy: FaultProxy;
let pgliteDir: string;
const expectedLogs = () => chain.logBlocks.filter((n) => n <= END_BLOCK).length;

beforeAll(async () => {
  chain = await startFakeChain(HEAD, LOG_EVERY);
  proxy = await startFaultProxy({
    upstreamUrl: chain.url,
    safelyRetryRate: 0.1,
    seed: 7,
    getLogsLatencyMs: 400,
  });
  pgliteDir = mkdtempSync(join(tmpdir(), "czar-indexer-resume-"));
});

afterAll(async () => {
  await proxy.close();
  await chain.close();
  rmSync(pgliteDir, { recursive: true, force: true });
});

function startPonder(): ChildProcess {
  return spawn(
    PONDER,
    ["--root", ROOT, "start", "--port", String(PORT), "--schema", "resume_test"],
    {
      env: {
        ...process.env,
        CZAR_TEST_RPC_URL: proxy.url,
        CZAR_TEST_PGLITE_DIR: pgliteDir,
        CZAR_TEST_END_BLOCK: String(END_BLOCK),
      },
      stdio: "ignore",
    },
  );
}

async function waitFor(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > TIMEOUT_MS) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const maxServedBlock = () =>
  proxy.servedRanges.reduce((max, range) => (range.to > max ? range.to : max), -1n);

async function pingCount(): Promise<number> {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/pings`);
    return response.ok ? ((await response.json()) as { count: number }).count : -1;
  } catch {
    return -1;
  }
}

async function ready(): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${PORT}/ready`)).status === 200;
  } catch {
    return false;
  }
}

describe("kill and resume", () => {
  it(
    "resumes from the checkpoint after SIGKILL and indexes every log once",
    async () => {
      const first = startPonder();
      await waitFor(() => maxServedBlock() >= END_BLOCK / 4n, "a quarter of the backfill");
      first.kill("SIGKILL");
      await new Promise((resolve) => first.once("exit", resolve));
      const servedBeforeKill = proxy.servedRanges.length;
      const reachedBeforeKill = maxServedBlock();
      expect(reachedBeforeKill).toBeLessThan(END_BLOCK);

      const second = startPonder();
      try {
        await waitFor(ready, "the restarted indexer to finish the backfill");
        await waitFor(
          async () => (await pingCount()) === expectedLogs(),
          "every log to be indexed",
        );
        const afterRestart = proxy.servedRanges.slice(servedBeforeKill);
        expect(afterRestart.length).toBeGreaterThan(0);
        // Resumed: the restarted process never asks for the start of the chain again.
        expect(afterRestart.every((range) => range.from > 0n)).toBe(true);
        expect(await pingCount()).toBe(expectedLogs());
        expect(proxy.counts.safelyRetry).toBeGreaterThan(0);
      } finally {
        second.kill("SIGTERM");
        await new Promise((resolve) => second.once("exit", resolve));
      }
    },
    TIMEOUT_MS * 3,
  );
});
