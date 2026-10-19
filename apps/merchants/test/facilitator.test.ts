// Facilitator client against a mocked fetch: the keyless-trial proof header binds the exact body.
import { describe, expect, it } from "vitest";
import { keccak256, toBytes } from "viem";
import {
  createFacilitator,
  FACILITATOR_BASE_URL,
  FacilitatorUnavailable,
} from "../src/search/index.ts";

const make = (fetchFn: typeof fetch) =>
  createFacilitator({ timeoutMs: 1000, sellerProof: async () => "p", fetchFn });

describe("facilitator client", () => {
  it("POSTs v2 bodies to /verify and /settle with a seller proof over the body hash", async () => {
    const seen: { url: string; body: string; proof: string | null }[] = [];
    const proofs: string[] = [];
    const facilitator = createFacilitator({
      timeoutMs: 1000,
      sellerProof: async ({ purpose, bodyHash }) => {
        proofs.push(`${purpose}:${bodyHash}`);
        return `proof-${purpose}`;
      },
      fetchFn: (async (url: string, init: RequestInit) => {
        seen.push({
          url,
          body: String(init.body),
          proof: new Headers(init.headers).get("facilitator-seller-proof"),
        });
        return new Response(
          JSON.stringify(
            url.endsWith("/verify")
              ? { isValid: true, payer: "0x1" }
              : { success: true, transaction: "0x2", network: "eip155:5042002" },
          ),
        );
      }) as typeof fetch,
    });
    expect(await facilitator.verify({ a: 1 }, { b: 2 })).toEqual({ isValid: true, payer: "0x1" });
    expect(await facilitator.settle({ a: 1 }, { b: 2 })).toMatchObject({
      success: true,
      transaction: "0x2",
    });
    expect(seen.map((s) => s.url)).toEqual([
      `${FACILITATOR_BASE_URL}/verify`,
      `${FACILITATOR_BASE_URL}/settle`,
    ]);
    expect(JSON.parse(seen[0]?.body as string)).toEqual({
      x402Version: 2,
      paymentPayload: { a: 1 },
      paymentRequirements: { b: 2 },
    });
    expect(proofs[0]).toBe(`verify:${keccak256(toBytes(seen[0]?.body as string))}`);
    expect(seen.map((s) => s.proof)).toEqual(["proof-verify", "proof-settle"]);
  });

  it("maps network errors, 5xx and 429 to FacilitatorUnavailable; 4xx JSON is an answer", async () => {
    await expect(
      make((async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch).verify({}, {}),
    ).rejects.toBeInstanceOf(FacilitatorUnavailable);
    await expect(
      make((async () => new Response("", { status: 502 })) as typeof fetch).verify({}, {}),
    ).rejects.toBeInstanceOf(FacilitatorUnavailable);
    await expect(
      make((async () => new Response("", { status: 429 })) as typeof fetch).settle({}, {}),
    ).rejects.toBeInstanceOf(FacilitatorUnavailable);
    const answer = make(
      (async () =>
        new Response(JSON.stringify({ isValid: false, invalidReason: "insufficient_funds" }), {
          status: 400,
        })) as typeof fetch,
    );
    expect(await answer.verify({}, {})).toEqual({
      isValid: false,
      invalidReason: "insufficient_funds",
    });
  });
});

describe("seller proof envelope", () => {
  it("is base64url JSON with issuedAt five minutes before expiry", async () => {
    const { encodeSellerProof } = await import("../src/search/index.ts");
    const value = encodeSellerProof({
      signature: `0x${"ab".repeat(65)}`,
      network: "eip155:5042002",
      payTo: "0x00000000000000000000000000000000000000A1",
      nonce: `0x${"cd".repeat(32)}`,
      expiresAt: 1_760_800_300,
    });
    expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(value, "base64url").toString())).toMatchObject({
      version: 1,
      issuedAt: 1_760_800_000,
      expiresAt: 1_760_800_300,
    });
  });
});
