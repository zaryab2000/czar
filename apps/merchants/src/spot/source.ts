// `czar-spot`'s price source (CZ-20 §5.1 "Testnet honesty", D49). One public free source, cached and
// refreshed every `merchants.spotRefreshSeconds`; when that source is unreachable or answers something
// this module cannot read, a deterministic synthetic series flagged `source: "synthetic-testnet"`.
// `source` is always present, so an acceptance check or a user is never misled about where a price came from.
//
// The source URL comes from `merchants.spotSourceUrl` (the PM-041 ruling: Coinbase's keyless public spot
// endpoint) and is fetched through `safeFetch`: https only, no private ranges, bounded bytes and time.
// The request carries nothing that identifies Czar or a user beyond safeFetch's own `User-Agent` — no API
// key, no contact address, no query of ours.
import { H } from "@czar/hashing";
import type { SafeFetch } from "@czar/x402";

/** The flag D49 requires on every price Czar generated itself. */
export const SYNTHETIC_SOURCE = "synthetic-testnet";

/** USDC-style 6-decimal rendering, so `price` is a plain decimal string CZ-16 can check structurally. */
const PRICE_DECIMALS = 6;
const MICRO = 1_000_000n;
/** The synthetic band, in micro-units: a value in [1.000000, 1000.999999]. Unmistakably synthetic. */
const SYNTHETIC_BAND_MICRO = 1_000_000_000n;
/** Bytes a price answer may take; a public spot answer is a few hundred bytes. */
const SOURCE_MAX_BYTES = 64 * 1024;
/** One refresh must not hold a buyer longer than the route's own handler budget allows. */
const SOURCE_TIMEOUT_MS = 4_000;

export interface SpotQuote {
  readonly pair: string;
  /** Decimal string, six places (CZ-20 §5.1: `price` is a decimal string). */
  readonly price: string;
  /** RFC 3339 instant the quote is as of (CZ-20 §5.1). */
  readonly asOf: string;
  /** The source host, or `synthetic-testnet` (D49: always present). */
  readonly source: string;
}

export interface SpotCacheOptions {
  /** `merchants.spotSourceUrl`; `{pair}` is replaced by the pair id. */
  readonly sourceUrlTemplate: string;
  /** `merchants.spotPairs`: the pairs the cache refreshes. */
  readonly pairs: readonly string[];
  /** `merchants.spotRefreshSeconds`. */
  readonly refreshSeconds: number;
  readonly safeFetch: SafeFetch;
  readonly now?: () => number;
}

export interface SpotCache {
  /** The cached quote for `pair`, refreshed from the public source when it is older than the interval. */
  quote(pair: string): Promise<SpotQuote>;
}

const rfc3339 = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

const microToDecimal = (micro: bigint) => {
  const whole = micro / MICRO;
  const fraction = (micro % MICRO).toString().padStart(PRICE_DECIMALS, "0");
  return `${whole}.${fraction}`;
};

/** The source URL for one pair. `{pair}`, `{BASE}` and `{QUOTE}` are the placeholders the ruling writes. */
export function spotSourceUrl(template: string, pair: string): string {
  const [base = "", quote = ""] = pair.split("-");
  return template
    .replaceAll("{pair}", pair)
    .replaceAll("{BASE}", base)
    .replaceAll("{QUOTE}", quote);
}

/**
 * The deterministic synthetic series: a function of the pair and the refresh bucket only, so the same pair
 * in the same bucket always gives the same price, on any machine, with no state and no network.
 */
export function syntheticQuote(options: {
  readonly pair: string;
  readonly nowMs: number;
  readonly refreshSeconds: number;
}): SpotQuote {
  const bucketMs = Math.max(1, options.refreshSeconds) * 1000;
  const bucket = Math.floor(options.nowMs / bucketMs);
  const digest = H({ kind: "czar-spot-synthetic", pair: options.pair, bucket });
  const micro = (BigInt(digest) % SYNTHETIC_BAND_MICRO) + MICRO;
  return {
    pair: options.pair,
    price: microToDecimal(micro),
    asOf: rfc3339(bucket * bucketMs),
    source: SYNTHETIC_SOURCE,
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/**
 * Reads a price out of a public spot answer. Both shapes the PM-041 ruling names are accepted, so the
 * `merchants.spotSourceUrl` key can be switched between them without a code change:
 *   Coinbase `GET /v2/prices/{pair}/spot` → `{"data":{"amount":"<decimal>","base":…,"currency":…}}`
 *   Kraken   `GET /0/public/Ticker?pair=` → `{"error":[],"result":{"<pair>":{"c":["<decimal>", …]}}}`
 * Anything else is treated exactly like an unreachable source: the synthetic series answers instead.
 */
export function readSourcePrice(body: unknown): string | null {
  if (!isObject(body)) return null;
  const data = body["data"];
  if (isObject(data) && typeof data["amount"] === "string" && DECIMAL.test(data["amount"]))
    return data["amount"];
  const result = body["result"];
  if (isObject(result)) {
    for (const entry of Object.values(result)) {
      if (!isObject(entry)) continue;
      const close = entry["c"];
      const last = Array.isArray(close) ? close[0] : undefined;
      if (typeof last === "string" && DECIMAL.test(last)) return last;
    }
  }
  return null;
}

/** Normalizes a source price to six decimals, so every answer has the same shape. */
export function normalizePrice(decimal: string): string | null {
  const [whole = "", fraction = ""] = decimal.split(".");
  if (!/^[0-9]+$/.test(whole)) return null;
  const micro = BigInt(whole) * MICRO + BigInt(fraction.padEnd(PRICE_DECIMALS, "0").slice(0, 6));
  return microToDecimal(micro);
}

export function createSpotCache(options: SpotCacheOptions): SpotCache {
  const now = options.now ?? Date.now;
  const refreshMs = Math.max(1, options.refreshSeconds) * 1000;
  const refreshed = new Set(options.pairs);
  const fresh = new Map<string, { readonly quote: SpotQuote; readonly fetchedAt: number }>();
  const inFlight = new Map<string, Promise<SpotQuote>>();

  async function fromSource(pair: string): Promise<SpotQuote | null> {
    const url = spotSourceUrl(options.sourceUrlTemplate, pair);
    let body: unknown;
    try {
      const response = await options.safeFetch(url, {
        method: "GET",
        headers: { accept: "application/json" },
        maxBytes: SOURCE_MAX_BYTES,
        timeoutMs: SOURCE_TIMEOUT_MS,
      });
      if (response.status !== 200) return null;
      body = JSON.parse(new TextDecoder().decode(response.body));
    } catch {
      return null;
    }
    const raw = readSourcePrice(body);
    if (raw === null) return null;
    const price = normalizePrice(raw);
    if (price === null) return null;
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return null;
    }
    return { pair, price, asOf: rfc3339(now()), source: host };
  }

  async function refresh(pair: string): Promise<SpotQuote> {
    const quote =
      (await fromSource(pair)) ??
      syntheticQuote({ pair, nowMs: now(), refreshSeconds: options.refreshSeconds });
    fresh.set(pair, { quote, fetchedAt: now() });
    return quote;
  }

  return {
    async quote(pair) {
      // The route already rejects an unlisted pair as bad input; this keeps the cache itself bounded
      // to `merchants.spotPairs` whatever calls it.
      if (!refreshed.has(pair)) throw new Error("pair is not in merchants.spotPairs");
      const cached = fresh.get(pair);
      if (cached !== undefined && now() - cached.fetchedAt < refreshMs) return cached.quote;
      const active = inFlight.get(pair);
      if (active !== undefined) return active;
      const request = refresh(pair).finally(() => inFlight.delete(pair));
      inFlight.set(pair, request);
      return request;
    },
  };
}
