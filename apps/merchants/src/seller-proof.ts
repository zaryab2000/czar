import { randomBytes } from "node:crypto";
import type { SignerClient } from "@czar/signer";
import { toHex, type Hex } from "viem";
import { encodeSellerProof, type SellerProofSigner } from "./facilitator.ts";

export function createSellerProofSigner(options: {
  readonly signer: Pick<SignerClient, "sign">;
  readonly network: string;
  readonly payTo: string;
  readonly now?: () => number;
}): SellerProofSigner {
  const now = options.now ?? Date.now;
  return async ({ purpose, method, bodyHash }) => {
    const nonce = toHex(randomBytes(32));
    const expiry = Math.floor(now() / 1000) + 300;
    const result = await options.signer.sign("cz-20", {
      keyId: "K10",
      kind: "merchant-seller-proof",
      payload: {
        service: "czar-search",
        purpose,
        method,
        bodyHash,
        network: options.network,
        nonce,
        expiry,
      },
    });
    if (!("signature" in result)) throw new Error("merchant seller proof returned no signature");
    return encodeSellerProof({
      signature: result.signature as Hex,
      network: options.network,
      payTo: options.payTo,
      nonce,
      expiresAt: expiry,
    });
  };
}

export type MerchantSigner = Pick<SignerClient, "keyAddress" | "sign">;
