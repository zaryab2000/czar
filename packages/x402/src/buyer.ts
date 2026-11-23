// Buyer side (02 §11.2, CZ-15): read the 402, validate, pick one offer, build the payload, read settlement.
import { decodeBase64Json, encodeBase64Json, header, type HeaderBag } from "./codec.ts";
import type { Config } from "@czar/config";
import {
  sanitizeExtensions,
  sanitizeResource,
  type SanitizedExtensions,
  type SanitizedResource,
} from "./extensions.ts";

export const USDC_ADDRESS = "0x3600000000000000000000000000000000000000";
export const GATEWAY_EXTRA_NAME = "GatewayWalletBatched";

export interface PaymentRequirements {
  readonly scheme: string;
  readonly network: string;
  readonly amount: string;
  readonly asset: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
  readonly extra: Readonly<Record<string, unknown>>;
}

export interface PaymentRequired {
  readonly x402Version: 1 | 2;
  readonly error?: string;
  readonly accepts: readonly PaymentRequirements[];
}

export type ReadResult =
  | {
      readonly ok: true;
      readonly version: 1 | 2;
      readonly paymentRequired: PaymentRequired;
      readonly resource: SanitizedResource;
      readonly extensions: SanitizedExtensions;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "not-402"
        | "missing"
        | "oversized"
        | "malformed"
        | "unsupported-version"
        | "invalid-shape";
    };

const AMOUNT6 = /^(0|[1-9][0-9]*)$/;
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function requirement(entry: unknown, version: 1 | 2): PaymentRequirements | null {
  if (!isObject(entry)) return null;
  const amount = version === 1 ? entry["maxAmountRequired"] : entry["amount"];
  const { scheme, network, asset, payTo, maxTimeoutSeconds } = entry;
  if (typeof scheme !== "string" || typeof network !== "string" || typeof asset !== "string")
    return null;
  if (typeof amount !== "string" || !AMOUNT6.test(amount)) return null;
  if (typeof payTo !== "string" || !HEX_ADDRESS.test(payTo)) return null;
  if (
    typeof maxTimeoutSeconds !== "number" ||
    !Number.isSafeInteger(maxTimeoutSeconds) ||
    maxTimeoutSeconds <= 0
  )
    return null;
  const extra = isObject(entry["extra"]) ? entry["extra"] : {};
  return { scheme, network, amount, asset, payTo, maxTimeoutSeconds, extra };
}

export interface HttpResponseLike {
  readonly status: number;
  readonly headers: HeaderBag;
  readonly body?: string;
}

/** Step 1–2: `PAYMENT-REQUIRED` header first; a v1 JSON body only when `x402Version === 1` (A3-02, A3-03). */
export function readPaymentRequired(response: HttpResponseLike): ReadResult {
  if (response.status !== 402) return { ok: false, reason: "not-402" };
  const raw = header(response.headers, "payment-required");
  let value: unknown;
  if (raw !== undefined) {
    const decoded = decodeBase64Json(raw);
    if (!decoded.ok) return { ok: false, reason: decoded.reason };
    value = decoded.value;
  } else {
    if (response.body === undefined) return { ok: false, reason: "missing" };
    if (Buffer.byteLength(response.body, "utf8") > 16 * 1024)
      return { ok: false, reason: "oversized" };
    try {
      value = JSON.parse(response.body) as unknown;
    } catch {
      return { ok: false, reason: "missing" };
    }
    if (!isObject(value) || value["x402Version"] !== 1)
      return { ok: false, reason: "unsupported-version" };
  }
  if (!isObject(value)) return { ok: false, reason: "malformed" };
  const version = value["x402Version"];
  if (version !== 1 && version !== 2) return { ok: false, reason: "unsupported-version" };
  if (raw !== undefined && version !== 2) return { ok: false, reason: "unsupported-version" };
  const accepts = value["accepts"];
  if (!Array.isArray(accepts) || accepts.length === 0)
    return { ok: false, reason: "invalid-shape" };
  const parsed = accepts.map((entry) => requirement(entry, version));
  if (parsed.some((entry) => entry === null)) return { ok: false, reason: "invalid-shape" };
  const resourceRaw =
    version === 2
      ? value["resource"]
      : {
          url: (accepts[0] as Record<string, unknown>)["resource"],
          description: (accepts[0] as Record<string, unknown>)["description"],
          mimeType: (accepts[0] as Record<string, unknown>)["mimeType"],
        };
  if (!isObject(resourceRaw) || typeof resourceRaw["url"] !== "string")
    return { ok: false, reason: "invalid-shape" };
  return {
    ok: true,
    version,
    paymentRequired: {
      x402Version: version,
      ...(typeof value["error"] === "string" ? { error: value["error"] } : {}),
      accepts: parsed as PaymentRequirements[],
    },
    resource: sanitizeResource(resourceRaw),
    extensions: sanitizeExtensions(value["extensions"]),
  };
}

export interface OfferPolicy {
  /** The plan's network; never switch chains (F1-07). */
  readonly network: string;
  /** `vault-direct` takes vanilla `exact`; `gateway` takes Gateway nanopayment offers (D37). */
  readonly rail: "vault-direct" | "gateway";
  readonly stepCap: bigint;
  /** The step's payee and alternates (its leaves). */
  readonly payees: readonly string[];
  readonly trustedPayees: readonly string[];
  readonly config: Config;
  readonly extensions402: SanitizedExtensions;
}

export type StepErrorCode = "unsupported-offer" | "price-or-payee-drift" | "flow-refused";

export type OfferChoice =
  | { readonly ok: true; readonly offer: PaymentRequirements }
  | { readonly ok: false; readonly code: StepErrorCode };

const lower = (s: string) => s.toLowerCase();

/** Classify a probed offer once for selection and pay-time rail checks (SCR-187 §6). */
export function classifyOffer(
  offer: PaymentRequirements,
  extensions402: SanitizedExtensions,
  config: Config,
): "vanilla" | "gateway" | "unsupported" {
  if (
    offer.extra["siwx"] === true ||
    offer.extra["siwxOnly"] === true ||
    extensions402.dropped.includes("sign-in-with-x")
  )
    return "unsupported";
  if (offer.extra["name"] !== GATEWAY_EXTRA_NAME)
    return offer.extra["paymentFlow"] === "batch-settlement" ? "unsupported" : "vanilla";
  const contract = offer.extra["verifyingContract"];
  return typeof contract === "string" &&
    lower(contract) === lower(String(config.get("chain.gatewayWalletAddress")))
    ? "gateway"
    : "unsupported";
}

/** Steps 3–5 of 02 §11.2. */
export function selectOffer(paymentRequired: PaymentRequired, policy: OfferPolicy): OfferChoice {
  const usable = paymentRequired.accepts.filter(
    (offer) =>
      offer.scheme === "exact" &&
      offer.network === policy.network &&
      lower(offer.asset) === USDC_ADDRESS &&
      classifyOffer(offer, policy.extensions402, policy.config) ===
        (policy.rail === "gateway" ? "gateway" : "vanilla"),
  );
  const offer = usable[0];
  if (offer === undefined) return { ok: false, code: "unsupported-offer" };
  const payees = new Set(policy.payees.map(lower));
  if (BigInt(offer.amount) > policy.stepCap || !payees.has(lower(offer.payTo))) {
    return { ok: false, code: "price-or-payee-drift" };
  }
  const flow = offer.extra["paymentFlow"];
  if (
    flow !== undefined &&
    flow !== "authorization" &&
    flow !== "escrow" &&
    !(policy.rail === "gateway" && flow === "batch-settlement")
  ) {
    const trusted =
      flow === "upfront" && policy.trustedPayees.map(lower).includes(lower(offer.payTo));
    if (!trusted) return { ok: false, code: "flow-refused" };
  }
  return { ok: true, offer };
}

export interface ExactAuthorization {
  readonly from: string;
  readonly to: string;
  readonly value: string;
  readonly validAfter: string;
  readonly validBefore: string;
  readonly nonce: string;
}

export interface PaymentPayload {
  readonly x402Version: 2;
  readonly resource?: {
    readonly url: string;
    readonly description?: string;
    readonly mimeType?: string;
  };
  readonly accepted: PaymentRequirements;
  readonly payload: {
    readonly signature: `0x${string}`;
    readonly authorization: ExactAuthorization;
  };
  readonly extensions?: Readonly<Record<string, unknown>>;
}

const PAYMENT_ID = /^[A-Za-z0-9_-]{16,128}$/;

/** Step 7 (A3-07). `payment-identifier` goes in only when the 402 advertised it (F1-06, 02 §7.4). */
export function buildExactPaymentPayload(input: {
  readonly resource: {
    readonly url: string;
    readonly description?: string;
    readonly mimeType?: string;
  };
  readonly accepted: PaymentRequirements;
  readonly authorization: ExactAuthorization;
  readonly signature: `0x${string}`;
  readonly paymentId?: string;
  readonly advertised?: { readonly required: boolean };
}): PaymentPayload {
  const base = {
    x402Version: 2 as const,
    resource: input.resource,
    accepted: input.accepted,
    payload: { signature: input.signature, authorization: input.authorization },
  };
  if (input.advertised === undefined || input.paymentId === undefined) return base;
  if (!PAYMENT_ID.test(input.paymentId))
    throw new Error("payment id must be 16–128 chars of [A-Za-z0-9_-]");
  return {
    ...base,
    extensions: {
      "payment-identifier": {
        info: { required: input.advertised.required, id: input.paymentId },
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            required: { type: "boolean" },
            id: { type: "string", minLength: 16, maxLength: 128 },
          },
          required: ["required"],
        },
      },
    },
  };
}

/** The `PAYMENT-SIGNATURE` header value (A3-02). */
export const encodePaymentSignature = (payload: PaymentPayload): string =>
  encodeBase64Json(payload);

export type Settlement =
  | {
      readonly state: "settled";
      readonly terminal: true;
      readonly transaction: string;
      readonly network?: string;
      readonly payer?: string;
      readonly amount?: string;
    }
  | { readonly state: "pending"; readonly terminal: false; readonly transaction: string }
  | { readonly state: "unpaid"; readonly terminal: true; readonly errorReason?: string }
  | { readonly state: "missing" | "malformed"; readonly terminal: false };

/** Step 9: `PAYMENT-RESPONSE`, then `X-PAYMENT-RESPONSE` for v1 sellers (A3-03, A3-08, A3-11). */
export function readSettlement(headers: HeaderBag): Settlement {
  const raw = header(headers, "payment-response") ?? header(headers, "x-payment-response");
  if (raw === undefined) return { state: "missing", terminal: false };
  const decoded = decodeBase64Json(raw);
  if (!decoded.ok || !isObject(decoded.value)) return { state: "malformed", terminal: false };
  const s = decoded.value;
  const transaction = typeof s["transaction"] === "string" ? s["transaction"] : "";
  if (s["success"] === true && transaction !== "") {
    return {
      state: "settled",
      terminal: true,
      transaction,
      ...(typeof s["network"] === "string" ? { network: s["network"] } : {}),
      ...(typeof s["payer"] === "string" ? { payer: s["payer"] } : {}),
      ...(typeof s["amount"] === "string" ? { amount: s["amount"] } : {}),
    };
  }
  if (s["errorReason"] === "settlement_pending" && transaction !== "")
    return { state: "pending", terminal: false, transaction };
  return {
    state: "unpaid",
    terminal: true,
    ...(typeof s["errorReason"] === "string" ? { errorReason: s["errorReason"] } : {}),
  };
}
