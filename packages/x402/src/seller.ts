// Seller side (02 §11.1): the `PAYMENT-REQUIRED` declaration Czar's merchants send, reading
// `PAYMENT-SIGNATURE`, and the `PAYMENT-RESPONSE` header.
import { declarePaymentIdentifierExtension } from "@x402/extensions/payment-identifier";
import { decodeBase64Json, encodeBase64Json, header, type HeaderBag } from "./codec.ts";
import { USDC_ADDRESS, type PaymentPayload, type PaymentRequirements } from "./buyer.ts";

const MAX_DESCRIPTION = 200;
const MAX_SERVICE_NAME = 32;
const MAX_TAGS = 5;
const MAX_TAG = 32;
/** Never above 600 s, so the vault's reservation TTL covers it (spec 01 §10.1). */
const MAX_TIMEOUT_SECONDS = 600;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const AMOUNT6 = /^(0|[1-9][0-9]*)$/;
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface SellerOffer {
  readonly url: string;
  readonly description: string;
  readonly serviceName: string;
  readonly tags: readonly string[];
  readonly network: string;
  readonly amount: string;
  /** The merchant payout key address (K10). */
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
}

export interface PaymentRequiredV2 {
  readonly x402Version: 2;
  readonly error: string;
  readonly resource: {
    readonly url: string;
    readonly description: string;
    readonly mimeType: string;
    readonly serviceName: string;
    readonly tags: readonly string[];
  };
  readonly accepts: readonly PaymentRequirements[];
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export function buildPaymentRequired(offer: SellerOffer): PaymentRequiredV2 {
  if (offer.description.length > MAX_DESCRIPTION) throw new Error("description over 200 chars");
  if (offer.serviceName.length > MAX_SERVICE_NAME || !PRINTABLE_ASCII.test(offer.serviceName))
    throw new Error("bad serviceName");
  if (
    offer.tags.length > MAX_TAGS ||
    offer.tags.some((t) => t.length > MAX_TAG || !PRINTABLE_ASCII.test(t))
  )
    throw new Error("bad tags");
  if (
    !Number.isSafeInteger(offer.maxTimeoutSeconds) ||
    offer.maxTimeoutSeconds <= 0 ||
    offer.maxTimeoutSeconds > MAX_TIMEOUT_SECONDS
  ) {
    throw new Error("maxTimeoutSeconds must be 1–600");
  }
  if (!AMOUNT6.test(offer.amount)) throw new Error("amount must be Amount6");
  if (!HEX_ADDRESS.test(offer.payTo)) throw new Error("payTo must be an address");
  return {
    x402Version: 2,
    error: "payment required",
    resource: {
      url: offer.url,
      description: offer.description,
      mimeType: "application/json",
      serviceName: offer.serviceName,
      tags: offer.tags,
    },
    accepts: [
      {
        scheme: "exact",
        network: offer.network,
        amount: offer.amount,
        asset: USDC_ADDRESS,
        payTo: offer.payTo,
        maxTimeoutSeconds: offer.maxTimeoutSeconds,
        extra: { name: "USDC", version: "2" },
      },
    ],
    extensions: { "payment-identifier": declarePaymentIdentifierExtension(false) },
  };
}

export const encodePaymentRequired = (paymentRequired: PaymentRequiredV2): string =>
  encodeBase64Json(paymentRequired);

export type SignatureRead =
  | { readonly ok: true; readonly payload: PaymentPayload; readonly raw: string }
  | { readonly ok: false; readonly reason: "missing" | "oversized" | "malformed" };

/** Reads only `PAYMENT-SIGNATURE` (A3-03: Czar sellers speak v2). */
export function readPaymentSignature(headers: HeaderBag): SignatureRead {
  const raw = header(headers, "payment-signature");
  if (raw === undefined) return { ok: false, reason: "missing" };
  const decoded = decodeBase64Json(raw);
  if (!decoded.ok) return { ok: false, reason: decoded.reason };
  const value = decoded.value as Record<string, unknown> | null;
  if (
    value === null ||
    typeof value !== "object" ||
    value["x402Version"] !== 2 ||
    typeof value["accepted"] !== "object" ||
    typeof value["payload"] !== "object"
  ) {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, payload: value as unknown as PaymentPayload, raw };
}

export interface SettlementResponse {
  readonly success: boolean;
  readonly transaction: string;
  readonly network: string;
  readonly payer?: string;
  readonly amount?: string;
  readonly errorReason?: string;
}

export const encodeSettlement = (settlement: SettlementResponse): string =>
  encodeBase64Json(settlement);
