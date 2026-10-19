// Circle Facilitator client (CZ-20 §4, spec 00 F3/F4). Keyless trial: every call carries a
// `Facilitator-Seller-Proof` header, a base64url EIP-712 `SellerRequest` signed by the `payTo` key (K10)
// through the signer. Tests inject `fetchFn`; nothing here runs against the live service in CI.
import { keccak256, toBytes, type Hex } from "viem";

export const FACILITATOR_BASE_URL = "https://api.circle.com/v1/facilitator/x402";

export interface VerifyResult {
  readonly isValid: boolean;
  readonly invalidReason?: string;
  readonly payer?: string;
}

export interface SettleResult {
  readonly success: boolean;
  readonly transaction?: string;
  readonly network?: string;
  readonly payer?: string;
  readonly errorReason?: string;
}

export class FacilitatorUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FacilitatorUnavailable";
  }
}

/** Asks the signer (kind `merchant-seller-proof`, K10) for a proof over one Facilitator request. */
export type SellerProofSigner = (request: {
  purpose: "verify" | "settle";
  method: "POST";
  bodyHash: Hex;
}) => Promise<string>;

export interface Facilitator {
  verify(paymentPayload: unknown, paymentRequirements: unknown): Promise<VerifyResult>;
  settle(paymentPayload: unknown, paymentRequirements: unknown): Promise<SettleResult>;
}

export function createFacilitator(options: {
  readonly sellerProof: SellerProofSigner;
  readonly timeoutMs: number;
  readonly baseUrl?: string;
  readonly fetchFn?: typeof fetch;
}): Facilitator {
  const base = options.baseUrl ?? FACILITATOR_BASE_URL;
  const fetchFn = options.fetchFn ?? fetch;

  async function call(
    purpose: "verify" | "settle",
    paymentPayload: unknown,
    paymentRequirements: unknown,
  ) {
    const body = JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements });
    const proof = await options.sellerProof({
      purpose,
      method: "POST",
      bodyHash: keccak256(toBytes(body)),
    });
    let response: Response;
    try {
      response = await fetchFn(`${base}/${purpose}`, {
        method: "POST",
        headers: { "content-type": "application/json", "facilitator-seller-proof": proof },
        body,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch {
      throw new FacilitatorUnavailable(`facilitator ${purpose} unreachable`);
    }
    if (response.status >= 500 || response.status === 429)
      throw new FacilitatorUnavailable(`facilitator ${purpose} answered ${response.status}`);
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new FacilitatorUnavailable(`facilitator ${purpose} sent no JSON`);
    }
    if (typeof json !== "object" || json === null)
      throw new FacilitatorUnavailable(`facilitator ${purpose} sent a non-object`);
    return json as Record<string, unknown>;
  }

  return {
    async verify(paymentPayload, paymentRequirements) {
      const json = await call("verify", paymentPayload, paymentRequirements);
      return {
        isValid: json["isValid"] === true,
        ...(typeof json["invalidReason"] === "string"
          ? { invalidReason: json["invalidReason"] }
          : {}),
        ...(typeof json["payer"] === "string" ? { payer: json["payer"] } : {}),
      };
    },
    async settle(paymentPayload, paymentRequirements) {
      const json = await call("settle", paymentPayload, paymentRequirements);
      const pick = (name: string) =>
        typeof json[name] === "string" ? { [name]: json[name] as string } : {};
      return {
        success: json["success"] === true,
        ...pick("transaction"),
        ...pick("network"),
        ...pick("payer"),
        ...pick("errorReason"),
      };
    },
  };
}

/** Keyless-trial proof lifetime: the signer refuses longer expiries (CZ-27 `merchant-seller-proof`). */
export const SELLER_PROOF_LIFETIME_SEC = 300;

/** The `Facilitator-Seller-Proof` value: base64url JSON around the K10 `SellerRequest` signature (spec 00 F4). */
export function encodeSellerProof(proof: {
  readonly signature: Hex;
  readonly network: string;
  readonly payTo: string;
  readonly nonce: Hex;
  readonly expiresAt: number;
}): string {
  const envelope = {
    version: 1,
    signature: proof.signature,
    network: proof.network,
    payTo: proof.payTo,
    nonce: proof.nonce,
    issuedAt: proof.expiresAt - SELLER_PROOF_LIFETIME_SEC,
    expiresAt: proof.expiresAt,
  };
  return Buffer.from(JSON.stringify(envelope)).toString("base64url");
}
