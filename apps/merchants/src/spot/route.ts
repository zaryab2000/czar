// `czar-spot` vanilla x402 route, `GET /v1/spot?pair=` → `{pair, price, asOf, source}` (CZ-20 §5.1).
// The lifecycle itself lives in `vanilla-route.ts`; this file is the service's input rule, its 402
// wording and its handler.
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import type { Facilitator } from "@czar/merchants/facilitator";
import type { PaymentIdStore } from "@czar/merchants/payment-id-store";
import type { SafeFetch } from "@czar/x402";
import {
  createVanillaRoute,
  type EmitEvent,
  type MerchantService,
  type ParsedInput,
} from "@czar/merchants/vanilla-route";
import { createSpotCache, type SpotQuote } from "./source.ts";

export const SPOT_PATH = "/v1/spot";
/** A pair id is short and from `merchants.spotPairs`; this bounds the input before the list check. */
export const MAX_PAIR_CHARS = 32;

export interface SpotRouteOptions {
  /** Public URL of this resource, `https://merchants.<env>.czar.dev/v1/spot`. */
  readonly resourceUrl: string;
  readonly network: string;
  /** K10 payout address for czar-spot. */
  readonly payTo: string;
  /** `merchants.spotPriceAtomic`. */
  readonly priceAtomic: string;
  /** `merchants.maxTimeoutSeconds`. */
  readonly maxTimeoutSeconds: number;
  /** `merchants.handlerTimeoutMs`. */
  readonly handlerTimeoutMs: number;
  readonly perPayerPerMin?: number;
  readonly facilitator: Facilitator;
  readonly store: PaymentIdStore;
  readonly emit?: EmitEvent;
  /** `merchants.spotSourceUrl`. */
  readonly sourceUrlTemplate: string;
  /** `merchants.spotPairs`. */
  readonly pairs: readonly string[];
  /** `merchants.spotRefreshSeconds`. */
  readonly refreshSeconds: number;
  readonly safeFetch: SafeFetch;
  readonly now?: () => number;
  /** Test seam for handler failures; the cache is used when this is left out. */
  readonly quote?: (pair: string) => Promise<SpotQuote>;
}

/** The buyer input as `extensions.bazaar` (CZ-20 §4, 02 §12.2): `GET` with one query parameter `pair`. */
function spotInputDeclaration(pairs: readonly string[]): unknown {
  const { bazaar } = declareDiscoveryExtension({
    input: { pair: pairs[0] ?? "" },
    inputSchema: {
      properties: { pair: { type: "string", enum: [...pairs] } },
      required: ["pair"],
      additionalProperties: false,
    },
  });
  const enrich = bazaarResourceServerExtension.enrichDeclaration;
  if (enrich === undefined) throw new Error("@x402/extensions bazaar has no enrichDeclaration");
  return enrich(bazaar, { method: "GET", adapter: { getPath: () => SPOT_PATH } });
}

export function createSpotRoute(options: SpotRouteOptions): MerchantService {
  const pairs = new Set(options.pairs);
  const cache = createSpotCache({
    sourceUrlTemplate: options.sourceUrlTemplate,
    pairs: options.pairs,
    refreshSeconds: options.refreshSeconds,
    safeFetch: options.safeFetch,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const quote = options.quote ?? ((pair: string) => cache.quote(pair));

  // Input is data: exactly one `pair`, bounded, and one of `merchants.spotPairs` (CZ-20 §5.7).
  async function parse(request: Request): Promise<ParsedInput<string>> {
    const url = new URL(request.url);
    const keys = [...url.searchParams.keys()];
    const pair = url.searchParams.get("pair");
    if (keys.length !== 1 || keys[0] !== "pair" || pair === null || pair.length === 0)
      return { ok: false, error: "expected exactly one query parameter pair" };
    if (pair.length > MAX_PAIR_CHARS || !pairs.has(pair))
      return { ok: false, error: "pair is not one of the pairs this service serves" };
    return { ok: true, input: pair, hashed: { pair } };
  }

  return createVanillaRoute<string>({
    serviceName: "czar-spot",
    path: SPOT_PATH,
    method: "GET",
    description: "Spot price for one asset pair as JSON",
    tags: ["price", "json"],
    bazaar: spotInputDeclaration(options.pairs),
    resourceUrl: options.resourceUrl,
    network: options.network,
    payTo: options.payTo,
    priceAtomic: options.priceAtomic,
    maxTimeoutSeconds: options.maxTimeoutSeconds,
    handlerTimeoutMs: options.handlerTimeoutMs,
    ...(options.perPayerPerMin === undefined ? {} : { perPayerPerMin: options.perPayerPerMin }),
    facilitator: options.facilitator,
    store: options.store,
    ...(options.emit === undefined ? {} : { emit: options.emit }),
    parse,
    handle: (pair) => quote(pair),
  });
}
