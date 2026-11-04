// The vanilla x402 lifecycle every Czar service route shares (CZ-20 §5.2, §6). One place for:
// 402 challenge → `accepted` must equal our own offer → payment-identifier replay/409 → Facilitator
// /verify → per-payer limit → handler → /settle only after the handler succeeded → 200 with
// PAYMENT-RESPONSE, body withheld when settle fails. A handler failure means no /settle, so the buyer is
// never charged for a request Czar did not serve (A3-09).
//
// Buyer input is data, never an instruction (CZ-20 §5.7): each service supplies a `parse` that accepts
// exactly its declared input and returns the `inputHash` preimage, and only hashes reach the log.
import { H } from "@czar/hashing";
import {
  buildPaymentRequired,
  encodePaymentRequired,
  encodeSettlement,
  readPaymentSignature,
  type PaymentRequiredV2,
} from "@czar/x402";
import { extractAndValidatePaymentIdentifier } from "@x402/extensions/payment-identifier";
import { FacilitatorUnavailable, type Facilitator } from "@czar/merchants/facilitator";
import {
  fingerprint,
  type PaymentIdStore,
  type StoredResponse,
} from "@czar/merchants/payment-id-store";

const RETRY_AFTER_SECONDS = "30";

export type RouteMethod = "GET" | "POST";

/** One route this merchant process serves, as the runtime registers it (CZ-20 §5.8 startup). */
export interface MerchantService {
  readonly serviceName: string;
  readonly path: string;
  readonly method: RouteMethod;
  /** The live 402 this route answers an unpaid request with; index entries are derived from it (p1-D7). */
  readonly paymentRequired: PaymentRequiredV2;
  handle(request: Request): Promise<Response>;
}

export type EmitEvent = (
  event: string,
  fields: Readonly<Record<string, string | number | boolean>>,
) => void;

/** Input accepted, with the canonical preimage the `inputHash` is taken over. */
export type ParsedInput<I> =
  | { readonly ok: true; readonly input: I; readonly hashed: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly error: string };

export interface VanillaRouteOptions<I> {
  readonly serviceName: string;
  readonly path: string;
  readonly method: RouteMethod;
  readonly description: string;
  readonly tags: readonly string[];
  /** The sanitized `extensions.bazaar` declaration for this route's input (02 §12.2). */
  readonly bazaar: unknown;
  /** Public URL of this resource, `merchants.publicOrigin` + the route path (CZ-20 §5.8). */
  readonly resourceUrl: string;
  readonly network: string;
  /** This service's K10 payout address, from the signer (CZ-20 §5.8). */
  readonly payTo: string;
  readonly priceAtomic: string;
  /** `merchants.maxTimeoutSeconds`. */
  readonly maxTimeoutSeconds: number;
  /** `merchants.handlerTimeoutMs`. */
  readonly handlerTimeoutMs: number;
  /** `merchants.perPayerPerMin`; left out, no per-payer limit is applied. */
  readonly perPayerPerMin?: number;
  readonly facilitator: Facilitator;
  readonly store: PaymentIdStore;
  /** Application events with allowlisted fields only (CZ-20 §4); inputs appear as hashes. */
  readonly emit?: EmitEvent;
  parse(request: Request): Promise<ParsedInput<I>>;
  handle(input: I): Promise<unknown>;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const same = (a: unknown, b: unknown) =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

export function createVanillaRoute<I>(options: VanillaRouteOptions<I>): MerchantService {
  const offered = buildPaymentRequired({
    url: options.resourceUrl,
    description: options.description,
    serviceName: options.serviceName,
    tags: options.tags,
    network: options.network,
    amount: options.priceAtomic,
    payTo: options.payTo,
    maxTimeoutSeconds: options.maxTimeoutSeconds,
  });
  const paymentRequired: PaymentRequiredV2 = {
    ...offered,
    extensions: { ...offered.extensions, bazaar: options.bazaar },
  };
  const offer = paymentRequired.accepts[0] as PaymentRequiredV2["accepts"][number];
  const emit = options.emit ?? (() => undefined);
  const payerWindows = new Map<string, { start: number; count: number }>();

  const challenge = (error?: string) => {
    const body: PaymentRequiredV2 =
      error === undefined ? paymentRequired : { ...paymentRequired, error };
    return json(402, body, { "payment-required": encodePaymentRequired(body) });
  };

  async function runHandler(input: I): Promise<unknown> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("handler timeout")), options.handlerTimeoutMs);
    });
    try {
      return await Promise.race([options.handle(input), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== options.method || url.pathname !== options.path)
      return json(404, { error: "not found" });

    const parsed = await options.parse(request);
    if (!parsed.ok) return json(400, { error: parsed.error });
    const inputHash = H(parsed.hashed);
    emit("merchant.request", { route: options.path, inputHash });

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
      route: options.path,
      method: options.method,
      inputHash,
    });
    if (id !== null) {
      const claim = await options.store.claim(options.path, id, fp);
      if (claim.kind === "conflict")
        return json(409, { error: "payment-identifier reused for a different request" });
      if (claim.kind === "in-flight")
        return json(409, { error: "payment-identifier request in progress" });
      if (claim.kind === "replay") {
        emit("merchant.served", { route: options.path, inputHash, replay: true });
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
      if (id !== null) await options.store.release(options.path, id);
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
      emit("merchant.verified", { route: options.path, inputHash });

      let result: unknown;
      try {
        result = await runHandler(parsed.input);
      } catch {
        // No settle: the buyer is not charged (A3-09).
        await release();
        emit("merchant.served", { route: options.path, inputHash, served: false });
        return json(500, { error: "handler failed; payment not settled" });
      }

      const settled = await options.facilitator.settle(payload, offer);
      const pending = !settled.success && settled.errorReason === "settlement_pending";
      if (!settled.success && !pending) {
        await release();
        emit("merchant.settle_failed", { route: options.path, inputHash });
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
      if (id !== null) await options.store.complete(options.path, id, stored);
      emit("merchant.settled", { route: options.path, inputHash, pending });
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
  }

  return {
    serviceName: options.serviceName,
    path: options.path,
    method: options.method,
    paymentRequired,
    handle,
  };
}

/** Reads a JSON request body with a hard byte bound, so a large body is refused before parsing. */
export async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false }> {
  let text: string;
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > maxBytes) return { ok: false };
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}
