import { describe, expect, it, vi } from "vitest";
import type { SignRequest } from "@czar/signer";
import { createSellerProofSigner } from "../src/seller-proof.ts";

describe("merchant seller proof adapter", () => {
  it("signs the canonical K10 request with a fresh nonce and bounded expiry", async () => {
    const sign = vi.fn(async (_caller: string, _request: SignRequest) => ({
      signature: `0x${"ab".repeat(65)}` as const,
      digest: `0x${"cd".repeat(32)}` as const,
    }));
    const sellerProof = createSellerProofSigner({
      signer: { sign },
      network: "eip155:5042002",
      payTo: "0x00000000000000000000000000000000000000A1",
      now: () => 1_760_800_000_000,
    });
    const proofA = await sellerProof({
      purpose: "verify",
      method: "POST",
      bodyHash: `0x${"12".repeat(32)}`,
    });
    const proofB = await sellerProof({
      purpose: "settle",
      method: "POST",
      bodyHash: `0x${"34".repeat(32)}`,
    });
    const first = JSON.parse(Buffer.from(proofA, "base64url").toString()) as Record<
      string,
      unknown
    >;
    const second = JSON.parse(Buffer.from(proofB, "base64url").toString()) as Record<
      string,
      unknown
    >;

    expect(sign).toHaveBeenCalledTimes(2);
    expect(sign.mock.calls[0]?.[0]).toBe("cz-20");
    expect(sign.mock.calls[0]?.[1]).toMatchObject({
      keyId: "K10",
      kind: "merchant-seller-proof",
      payload: {
        service: "czar-search",
        purpose: "verify",
        method: "POST",
        bodyHash: `0x${"12".repeat(32)}`,
        network: "eip155:5042002",
        expiry: 1_760_800_300,
      },
    });
    expect(first["nonce"]).toMatch(/^0x[0-9a-f]{64}$/);
    expect(second["nonce"]).toMatch(/^0x[0-9a-f]{64}$/);
    expect(first["nonce"]).not.toBe(second["nonce"]);
    expect(first["payTo"]).toBe("0x00000000000000000000000000000000000000A1");
    expect(first["expiresAt"]).toBe(1_760_800_300);
  });
});
