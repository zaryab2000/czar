// JSON-RPC transport for Arc (CZ-19 §5.1, §5.2). Ponder calls the chain only through it.
// - eth_getLogs ranges wider than `getLogsBlockRange` (9,999) are paged; Arc caps them at 10,000 (A9-06).
// - -32012 (range too wide) → halve the page and retry (A9-06).
// - -32014 ("safely retry") and transport failures → exponential backoff from `retryBaseMs`, up to
//   `retryMax` retries, then fail over to the keyed provider for `failoverHoldMs` (A9-06, A9-07).
import { custom, type EIP1193RequestFn, type Transport } from "viem";

export const RANGE_TOO_WIDE = -32012;
export const SAFELY_RETRY = -32014;

export interface ArcTransportOptions {
  /** Primary endpoint, then the keyed fallback (A9-07, A9-08). */
  readonly urls: readonly [string, ...string[]];
  readonly getLogsBlockRange: number;
  readonly retryBaseMs: number;
  readonly retryMax: number;
  readonly failoverHoldMs: number;
  readonly fetchFn?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly requestTimeoutMs?: number;
}

/** A JSON-RPC error the endpoint answered with; viem and Ponder read `code` and `message`. */
export class RpcResponseError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcResponseError";
    this.code = code;
    this.data = data;
  }
}

class RetryableTransportError extends Error {}

interface JsonRpcResponse {
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

interface LogFilter {
  readonly fromBlock?: unknown;
  readonly toBlock?: unknown;
  readonly [key: string]: unknown;
}

const isQuantity = (value: unknown): value is `0x${string}` =>
  typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value);
const toHex = (value: bigint) => `0x${value.toString(16)}` as const;

export function createArcRequester(options: ArcTransportOptions) {
  const fetchFn = options.fetchFn ?? fetch;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  let failoverUntil = 0;
  let nextId = 1;

  const endpoint = () => {
    const [primary, fallback] = options.urls;
    return fallback !== undefined && now() < failoverUntil ? fallback : primary;
  };

  async function send(url: string, method: string, params: unknown): Promise<unknown> {
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    };
    if (options.requestTimeoutMs !== undefined)
      init.signal = AbortSignal.timeout(options.requestTimeoutMs);
    let response: Response;
    try {
      response = await fetchFn(url, init);
    } catch {
      throw new RetryableTransportError("rpc transport failure");
    }
    if (response.status === 429 || response.status >= 500)
      throw new RetryableTransportError(`rpc http ${response.status}`);
    const body = (await response.json()) as JsonRpcResponse;
    if (body.error !== undefined)
      throw new RpcResponseError(body.error.code, body.error.message, body.error.data);
    return body.result;
  }

  /** One call with -32014 / transport retries and failover. Other JSON-RPC errors are returned to the caller. */
  async function call(method: string, params: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await send(endpoint(), method, params);
      } catch (error) {
        const retryable =
          error instanceof RetryableTransportError ||
          (error instanceof RpcResponseError && error.code === SAFELY_RETRY);
        if (!retryable) throw error;
        if (attempt >= options.retryMax) {
          const onFallback = now() < failoverUntil;
          if (options.urls.length > 1 && !onFallback) {
            failoverUntil = now() + options.failoverHoldMs;
            attempt = -1;
            continue;
          }
          throw error;
        }
        await sleep(options.retryBaseMs * 2 ** attempt);
      }
    }
  }

  /** Fetches logs for [from, to], halving on -32012 until a single block. */
  async function getLogsRange(filter: LogFilter, from: bigint, to: bigint): Promise<unknown[]> {
    try {
      const logs = await call("eth_getLogs", [
        { ...filter, fromBlock: toHex(from), toBlock: toHex(to) },
      ]);
      return Array.isArray(logs) ? logs : [];
    } catch (error) {
      if (error instanceof RpcResponseError && error.code === RANGE_TOO_WIDE && to > from) {
        const mid = from + (to - from) / 2n;
        return [
          ...(await getLogsRange(filter, from, mid)),
          ...(await getLogsRange(filter, mid + 1n, to)),
        ];
      }
      throw error;
    }
  }

  async function getLogs(filter: LogFilter): Promise<unknown> {
    if (!isQuantity(filter.fromBlock) || !isQuantity(filter.toBlock))
      return call("eth_getLogs", [filter]);
    const from = BigInt(filter.fromBlock);
    const to = BigInt(filter.toBlock);
    const page = BigInt(options.getLogsBlockRange);
    const logs: unknown[] = [];
    for (let start = from; start <= to; start += page) {
      const end = start + page - 1n < to ? start + page - 1n : to;
      logs.push(...(await getLogsRange(filter, start, end)));
    }
    return logs;
  }

  const request = async ({ method, params }: { method: string; params?: unknown }) => {
    if (
      method === "eth_getLogs" &&
      Array.isArray(params) &&
      typeof params[0] === "object" &&
      params[0] !== null
    ) {
      return getLogs(params[0] as LogFilter);
    }
    return call(method, params ?? []);
  };

  return { request };
}

/** The viem transport handed to Ponder's `chains.<name>.rpc`. */
export function arcTransport(options: ArcTransportOptions): Transport {
  const { request } = createArcRequester(options);
  return custom({ request: request as unknown as EIP1193RequestFn }, { retryCount: 0 });
}
