import { describe, expect, it } from "vitest";
import { createArcRequester, RpcResponseError } from "@czar/indexer/rpc";

type Handler = (
  url: string,
  body: { method: string; params: unknown[] },
) => Response | Promise<Response>;

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const ok = (result: unknown) => json({ jsonrpc: "2.0", id: 1, result });
const rpcError = (code: number) =>
  json({ jsonrpc: "2.0", id: 1, error: { code, message: `error ${code}` } });

function harness(
  handler: Handler,
  urls: [string, ...string[]] = ["https://primary", "https://keyed"],
) {
  const calls: { url: string; method: string; params: unknown[] }[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  const requester = createArcRequester({
    urls,
    getLogsBlockRange: 9999,
    retryBaseMs: 250,
    retryMax: 6,
    failoverHoldMs: 300_000,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    fetchFn: (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
      calls.push({ url, method: body.method, params: body.params });
      return handler(url, body);
    }) as typeof fetch,
  });
  return { requester, calls, sleeps, advance: (ms: number) => (clock += ms) };
}

const range = (call: { params: unknown[] }) => {
  const filter = call.params[0] as { fromBlock: string; toBlock: string };
  return [Number(BigInt(filter.fromBlock)), Number(BigInt(filter.toBlock))];
};

describe("arc transport", () => {
  it("pages eth_getLogs in ranges of at most 9,999 blocks", async () => {
    const { requester, calls } = harness(() => ok([]));
    await requester.request({
      method: "eth_getLogs",
      params: [{ fromBlock: "0x0", toBlock: "0x61a8" }],
    });
    expect(calls.map(range)).toEqual([
      [0, 9998],
      [9999, 19997],
      [19998, 25000],
    ]);
  });

  it("halves a page on -32012 until the endpoint accepts it", async () => {
    const { requester, calls } = harness((_, body) => {
      const [from, to] = range(body);
      return (to as number) - (from as number) + 1 > 2500 ? rpcError(-32012) : ok([{ from }]);
    });
    const logs = await requester.request({
      method: "eth_getLogs",
      params: [{ fromBlock: "0x0", toBlock: "0x270e" }],
    });
    expect((logs as unknown[]).length).toBe(4);
    expect(calls.filter((call) => call.method === "eth_getLogs").length).toBe(7);
  });

  it("retries -32014 with exponential backoff from 250 ms", async () => {
    let failures = 3;
    const { requester, sleeps } = harness(() => (failures-- > 0 ? rpcError(-32014) : ok("0x1")));
    expect(await requester.request({ method: "eth_blockNumber" })).toBe("0x1");
    expect(sleeps).toEqual([250, 500, 1000]);
  });

  it("fails over to the keyed provider after 6 retries and holds it for 300 s", async () => {
    const { requester, calls, advance } = harness((url) =>
      url === "https://primary" ? rpcError(-32014) : ok("0x2"),
    );
    expect(await requester.request({ method: "eth_blockNumber" })).toBe("0x2");
    expect(calls.filter((call) => call.url === "https://primary")).toHaveLength(7);
    await requester.request({ method: "eth_blockNumber" });
    expect(calls.at(-1)?.url).toBe("https://keyed");
    advance(300_000);
    await requester.request({ method: "eth_blockNumber" }).catch(() => undefined);
    expect(calls.some((call, i) => i > 8 && call.url === "https://primary")).toBe(true);
  });

  it("gives up with the RPC error when there is no fallback", async () => {
    const { requester } = harness(() => rpcError(-32014), ["https://primary"]);
    await expect(requester.request({ method: "eth_blockNumber" })).rejects.toBeInstanceOf(
      RpcResponseError,
    );
  });

  it("returns non-retryable RPC errors at once", async () => {
    const { requester, calls } = harness(() => rpcError(-32602));
    await expect(requester.request({ method: "eth_call", params: [] })).rejects.toMatchObject({
      code: -32602,
    });
    expect(calls).toHaveLength(1);
  });

  it("retries HTTP 429 and 5xx answers", async () => {
    let failures = 2;
    const { requester } = harness(() => (failures-- > 0 ? json({}, 503) : ok("0x3")));
    expect(await requester.request({ method: "eth_blockNumber" })).toBe("0x3");
  });

  it("passes block-hash and tag filters through unpaged", async () => {
    const { requester, calls } = harness(() => ok([]));
    await requester.request({ method: "eth_getLogs", params: [{ blockHash: "0xabc" }] });
    await requester.request({
      method: "eth_getLogs",
      params: [{ fromBlock: "latest", toBlock: "latest" }],
    });
    expect(calls).toHaveLength(2);
  });
});
