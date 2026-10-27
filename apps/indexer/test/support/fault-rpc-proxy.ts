// Fault-injecting JSON-RPC proxy for tests (T-010, reused by T-030; RV-057). It sits in front of
// `arc-anvil` (which has no log-range cap) or the in-process fake chain and reproduces the Arc public RPC
// errors (A9-06): -32012 for eth_getLogs wider than 10,000 blocks, and -32014 at a seeded random rate.
// It records every eth_getLogs range it forwarded so tests can check coverage.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const ARC_LOG_RANGE_CAP = 10_000n;

export interface FaultProxyOptions {
  readonly upstreamUrl: string;
  /** Probability in [0, 1) that any request is answered with -32014 instead of being forwarded. */
  readonly safelyRetryRate: number;
  readonly seed: number;
  readonly logRangeCap?: bigint;
  /** Delay before forwarding each eth_getLogs call, so a test can stop a sync part-way. */
  readonly getLogsLatencyMs?: number;
}

export interface FaultProxy {
  readonly url: string;
  /** eth_getLogs ranges forwarded upstream and answered without error, in order. */
  readonly servedRanges: { from: bigint; to: bigint }[];
  readonly counts: { forwarded: number; rangeTooWide: number; safelyRetry: number };
  close(): Promise<void>;
}

/** Mulberry32: small deterministic PRNG so fault patterns are reproducible from a seed. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

interface RpcCall {
  readonly id: unknown;
  readonly method: string;
  readonly params?: unknown[];
}

export async function startFaultProxy(options: FaultProxyOptions): Promise<FaultProxy> {
  const random = prng(options.seed);
  const cap = options.logRangeCap ?? ARC_LOG_RANGE_CAP;
  const servedRanges: { from: bigint; to: bigint }[] = [];
  const counts = { forwarded: 0, rangeTooWide: 0, safelyRetry: 0 };

  const answerOne = async (call: RpcCall): Promise<unknown> => {
    if (random() < options.safelyRetryRate) {
      counts.safelyRetry += 1;
      return {
        jsonrpc: "2.0",
        id: call.id,
        error: { code: -32014, message: "Request failed, please safely retry" },
      };
    }
    let range: { from: bigint; to: bigint } | undefined;
    if (call.method === "eth_getLogs") {
      const filter = (call.params?.[0] ?? {}) as { fromBlock?: string; toBlock?: string };
      if (typeof filter.fromBlock === "string" && typeof filter.toBlock === "string") {
        range = { from: BigInt(filter.fromBlock), to: BigInt(filter.toBlock) };
        if (range.to - range.from + 1n > cap) {
          counts.rangeTooWide += 1;
          return {
            jsonrpc: "2.0",
            id: call.id,
            error: { code: -32012, message: "Block range limit exceeded" },
          };
        }
      }
    }
    counts.forwarded += 1;
    if (range !== undefined && options.getLogsLatencyMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, options.getLogsLatencyMs));
    }
    const upstream = await fetch(options.upstreamUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(call),
    });
    const answer = (await upstream.json()) as { error?: unknown };
    if (range !== undefined && answer.error === undefined) servedRanges.push(range);
    return answer;
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const parsed = JSON.parse(await readBody(req)) as RpcCall | RpcCall[];
        const answer = Array.isArray(parsed)
          ? await Promise.all(parsed.map(answerOne))
          : await answerOne(parsed);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(answer));
      } catch {
        res.writeHead(500);
        res.end();
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    servedRanges,
    counts,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
