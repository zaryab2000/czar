// T-030 acceptance: behind an RPC that returns -32012 for wide ranges and -32014 at random, a 50,000-block
// backfill through the Arc transport covers every block exactly once. Upstream is `arc-anvil` when
// ARC_ANVIL_URL is set (CI), otherwise the in-process fake chain.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createArcRequester } from "@czar/indexer/rpc";
import { startFakeChain, type FakeChain } from "./support/fake-chain.ts";
import { startFaultProxy, type FaultProxy } from "./support/fault-rpc-proxy.ts";

const BLOCKS = 50_000n;
let chain: FakeChain | undefined;
let proxy: FaultProxy;

beforeAll(async () => {
  const anvil = process.env["ARC_ANVIL_URL"];
  let upstreamUrl: string;
  if (anvil === undefined || anvil === "") {
    chain = await startFakeChain(BLOCKS, 1_000n);
    upstreamUrl = chain.url;
  } else {
    upstreamUrl = anvil;
  }
  proxy = await startFaultProxy({ upstreamUrl, safelyRetryRate: 0.2, seed: 42 });
});

afterAll(async () => {
  await proxy.close();
  await chain?.close();
});

describe("50,000-block backfill through the fault proxy", () => {
  it("covers every block range once, with no gaps", async () => {
    const requester = createArcRequester({
      urls: [proxy.url],
      // Wider than Arc's cap on purpose, so the -32012 halving path is exercised as well as paging.
      getLogsBlockRange: 12_000,
      retryBaseMs: 1,
      retryMax: 50,
      failoverHoldMs: 0,
    });
    const head = BigInt((await requester.request({ method: "eth_blockNumber" })) as string);
    expect(head).toBeGreaterThanOrEqual(BLOCKS);

    const logs = (await requester.request({
      method: "eth_getLogs",
      params: [{ fromBlock: "0x0", toBlock: `0x${BLOCKS.toString(16)}` }],
    })) as unknown[];

    const ranges = proxy.servedRanges.toSorted((a, b) => (a.from < b.from ? -1 : 1));
    let next = 0n;
    for (const { from, to } of ranges) {
      expect(from, "gap or overlap").toBe(next);
      expect(to - from + 1n).toBeLessThanOrEqual(10_000n);
      next = to + 1n;
    }
    expect(next).toBe(BLOCKS + 1n);
    expect(proxy.counts.rangeTooWide).toBeGreaterThan(0);
    expect(proxy.counts.safelyRetry).toBeGreaterThan(0);
    if (chain !== undefined) expect(logs).toHaveLength(chain.logBlocks.length);
  });
});
