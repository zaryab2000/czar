// `czar-search` vanilla x402 route, `GET /v1/search?q=` (CZ-20 §5.1, §5.2, §6). Lifecycle: 402 challenge →
// `accepted` must equal our offer → payment-identifier replay/409 → Facilitator /verify → handler →
// /settle only after the handler succeeded → 200 with PAYMENT-RESPONSE, body withheld when settle fails.
import { H } from "@czar/hashing";
import {
  buildPaymentRequired,
  encodePaymentRequired,
  encodeSettlement,
  readPaymentSignature,
  type PaymentRequiredV2,
} from "@czar/x402";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { extractAndValidatePaymentIdentifier } from "@x402/extensions/payment-identifier";
import { FacilitatorUnavailable, type Facilitator } from "@czar/merchants/facilitator";
import {
  fingerprint,
  type PaymentIdStore,
  type StoredResponse,
} from "@czar/merchants/payment-id-store";
import { search } from "./index-data.ts";

export const SEARCH_PATH = "/v1/search";
export const MAX_QUERY_CHARS = 200;
const EXAMPLE_QUERY = "x402 payment";
const RETRY_AFTER_SECONDS = "30";

export interface SearchRouteOptions {
  /** Public URL of this resource, `https://merchants.<env>.czar.dev/v1/search`. */
  readonly resourceUrl: string;
  readonly network: string;
  /** K10 payout address for czar-search. */
  readonly payTo: string;
  /** `merchants.searchPriceAtomic`. */
  readonly priceAtomic: string;
  /** `merchants.maxTimeoutSeconds`. */
  readonly maxTimeoutSeconds: number;
  /** `merchants.handlerTimeoutMs`. */
  readonly handlerTimeoutMs: number;
  /** Requests accepted per verified payer in one minute. */
  readonly perPayerPerMin?: number;
  readonly facilitator: Facilitator;
  readonly store: PaymentIdStore;
  /** Application events with allowlisted fields only (CZ-20 §4); inputs appear as hashes. */
  readonly emit?: (
    event: string,
    fields: Readonly<Record<string, string | number | boolean>>,
  ) => void;
  /** Test seam for handler failures. */
  readonly handler?: (q: string) => Promise<unknown>;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const same = (a: unknown, b: unknown) =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * The buyer input as `extensions.bazaar` (CZ-20 §4, 02 §12.2): `GET` with one string query parameter
 * `q`. The SDK's own request-time enrichment adds the fixed method, so it runs once for this route.
 */
function searchInputDeclaration(): unknown {
  const { bazaar } = declareDiscoveryExtension({
    input: { q: EXAMPLE_QUERY },
    inputSchema: {
      properties: { q: { type: "string", minLength: 1, maxLength: MAX_QUERY_CHARS } },
      required: ["q"],
      additionalProperties: false,
    },
  });
  const enrich = bazaarResourceServerExtension.enrichDeclaration;
  if (enrich === undefined) throw new Error("@x402/extensions bazaar has no enrichDeclaration");
  return enrich(bazaar, { method: "GET", adapter: { getPath: () => SEARCH_PATH } });
}

export function createSearchRoute(
  options: SearchRouteOptions,
): (request: Request) => Promise<Response> {
  const offered = buildPaymentRequired({
    url: options.resourceUrl,
    description: "Search a fixed index of protocol documentation",
    serviceName: "czar-search",
    tags: ["search", "web-search"],
    network: options.network,
    amount: options.priceAtomic,
    payTo: options.payTo,
    maxTimeoutSeconds: options.maxTimeoutSeconds,
  });
  const paymentRequired: PaymentRequiredV2 = {
    ...offered,
    extensions: { ...offered.extensions, bazaar: searchInputDeclaration() },
  };
  const offer = paymentRequired.accepts[0] as PaymentRequiredV2["accepts"][number];
  const emit = options.emit ?? (() => undefined);
  const handler = options.handler ?? (async (q: string) => search(q));
  const payerWindows = new Map<string, { start: number; count: number }>();

  const challenge = (error?: string) => {
    const body: PaymentRequiredV2 =
      error === undefined ? paymentRequired : { ...paymentRequired, error };
    return json(402, body, { "payment-required": encodePaymentRequired(body) });
  };

  async function runHandler(q: string): Promise<unknown> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("handler timeout")), options.handlerTimeoutMs);
    });
    try {
      return await Promise.race([handler(q), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  return async (request) => {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== SEARCH_PATH)
      return json(404, { error: "not found" });

    // Input is data: exactly one `q`, bounded (CZ-20 §5.7).
    const keys = [...url.searchParams.keys()];
    const q = url.searchParams.get("q");
    if (
      keys.length !== 1 ||
      keys[0] !== "q" ||
      q === null ||
      q.length === 0 ||
      q.length > MAX_QUERY_CHARS
    )
      return json(400, { error: "expected exactly one query parameter q (1–200 characters)" });
    const inputHash = H({ q });
    emit("merchant.request", { route: SEARCH_PATH, inputHash });

    // Czar sellers are v2-only (A3-03).
    if (request.headers.has("x-payment")) return challenge("x402 v2 required");
    const read = readPaymentSignature(request.headers);
    if (!read.ok)
      return challenge(read.reason === "missing" ? undefined : `payment-signature ${read.reason}`);
    const payload = read.payload;

    // A buyer cannot pay a different payee or price for this resource.
    const accepted = payload.accepted as unknown as Record<string, unknown>;
    if (
      accepted["scheme"] !== offer.scheme ||
      accepted["network"] !== offer.network ||
      accepted["amount"] !== offer.amount ||
      !same(accepted["asset"], offer.asset) ||
      !same(accepted["payTo"], offer.payTo)
    )
      return challenge("accepted does not match this resource's offer");

    const { id, validation } = extractAndValidatePaymentIdentifier(payload as never);
    if (!validation.valid) return json(400, { error: "invalid payment-identifier" });
    const fp = fingerprint({
      scheme: offer.scheme,
      network: offer.network,
      asset: offer.asset.toLowerCase(),
      amount: offer.amount,
      payTo: offer.payTo.toLowerCase(),
      route: SEARCH_PATH,
      method: "GET",
      inputHash,
    });
    if (id !== null) {
      const claim = await options.store.claim(SEARCH_PATH, id, fp);
      if (claim.kind === "conflict")
        return json(409, { error: "payment-identifier reused for a different request" });
      if (claim.kind === "in-flight")
        return json(409, { error: "payment-identifier request in progress" });
      if (claim.kind === "replay") {
        emit("merchant.served", { route: SEARCH_PATH, inputHash, replay: true });
        return new Response(claim.response.body, {
          status: claim.response.status,
          headers: {
            "content-type": "application/json",
            "payment-response": claim.response.paymentResponse,
          },
        });
      }
    }
    const release = async () => {
      if (id !== null) await options.store.release(SEARCH_PATH, id);
    };

    try {
      const verified = await options.facilitator.verify(payload, offer);
      if (!verified.isValid) {
        await release();
        return challenge(verified.invalidReason ?? "verify-rejected");
      }
      if (options.perPayerPerMin !== undefined) {
        const payer = verified.payer?.toLowerCase();
        if (payer === undefined) {
          await release();
          return json(502, { error: "payment facilitator omitted verified payer" });
        }
        const now = Date.now();
        for (const [key, entry] of payerWindows)
          if (now - entry.start >= 60_000) payerWindows.delete(key);
        const window = payerWindows.get(payer);
        if (window === undefined || now - window.start >= 60_000) {
          payerWindows.set(payer, { start: now, count: 1 });
        } else if (window.count >= options.perPayerPerMin) {
          await release();
          return json(429, { error: "payer rate limit exceeded" }, { "retry-after": "60" });
        } else {
          window.count += 1;
        }
      }
      emit("merchant.verified", { route: SEARCH_PATH, inputHash });

      let result: unknown;
      try {
        result = await runHandler(q);
      } catch {
        // No settle: the buyer is not charged (A3-09).
        await release();
        emit("merchant.served", { route: SEARCH_PATH, inputHash, served: false });
        return json(500, { error: "handler failed; payment not settled" });
      }

      const settled = await options.facilitator.settle(payload, offer);
      const pending = !settled.success && settled.errorReason === "settlement_pending";
      if (!settled.success && !pending) {
        await release();
        emit("merchant.settle_failed", { route: SEARCH_PATH, inputHash });
        return challenge(settled.errorReason ?? "settle-failed");
      }
      const paymentResponse = encodeSettlement({
        success: settled.success,
        transaction: settled.transaction ?? "",
        network: settled.network ?? offer.network,
        ...(settled.payer === undefined ? {} : { payer: settled.payer }),
        amount: offer.amount,
        ...(pending ? { errorReason: "settlement_pending" } : {}),
      });
      const stored: StoredResponse = { status: 200, body: JSON.stringify(result), paymentResponse };
      if (id !== null) await options.store.complete(SEARCH_PATH, id, stored);
      emit("merchant.settled", { route: SEARCH_PATH, inputHash, pending });
      return new Response(stored.body, {
        status: 200,
        headers: { "content-type": "application/json", "payment-response": paymentResponse },
      });
    } catch (error) {
      await release();
      if (error instanceof FacilitatorUnavailable)
        return json(
          503,
          { error: "payment facilitator unavailable" },
          { "retry-after": RETRY_AFTER_SECONDS },
        );
      throw error;
    }
  };
}
