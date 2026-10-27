import { describe, expect, it } from "vitest";
import {
  buildPaymentRequired,
  encodePaymentRequired,
  readPaymentRequired,
  readPaymentSignature,
  encodePaymentSignature,
  encodeSettlement,
  readSettlement,
} from "@czar/x402";

describe("seller helpers (02 §11.1)", () => {
  const required = buildPaymentRequired({
    url: "https://search.czar.example/v1/search",
    description: "Web search results as JSON",
    serviceName: "czar-search",
    tags: ["search", "web"],
    network: "eip155:5042002",
    amount: "50000",
    payTo: "0x000000000000000000000000000000000000bEEF",
    maxTimeoutSeconds: 300,
  });

  it("matches the §11.1 field table", () => {
    expect(required).toMatchObject({
      x402Version: 2,
      error: "payment required",
      resource: {
        url: "https://search.czar.example/v1/search",
        mimeType: "application/json",
        serviceName: "czar-search",
      },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:5042002",
          amount: "50000",
          asset: "0x3600000000000000000000000000000000000000",
          payTo: "0x000000000000000000000000000000000000bEEF",
          maxTimeoutSeconds: 300,
          extra: { name: "USDC", version: "2" },
        },
      ],
    });
    expect(required.extensions?.["payment-identifier"]).toMatchObject({
      info: { required: false },
    });
  });

  it("round-trips through the buyer parser", () => {
    const parsed = readPaymentRequired({
      status: 402,
      headers: { "payment-required": encodePaymentRequired(required) },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.extensions.paymentIdentifier).toEqual({ required: false });
  });

  it.each([
    ["description over 200 chars", { description: "x".repeat(201) }],
    ["serviceName over 32", { serviceName: "x".repeat(33) }],
    ["more than 5 tags", { tags: ["a", "b", "c", "d", "e", "f"] }],
    ["maxTimeoutSeconds over 600", { maxTimeoutSeconds: 601 }],
    ["amount not Amount6", { amount: "0.05" }],
  ])("refuses %s", (_name, override) => {
    expect(() =>
      buildPaymentRequired({
        url: "https://search.czar.example/v1/search",
        description: "d",
        serviceName: "czar-search",
        tags: [],
        network: "eip155:5042002",
        amount: "50000",
        payTo: "0x000000000000000000000000000000000000bEEF",
        maxTimeoutSeconds: 300,
        ...override,
      }),
    ).toThrow();
  });

  it("reads PAYMENT-SIGNATURE and encodes PAYMENT-RESPONSE", () => {
    const payload = {
      x402Version: 2,
      accepted: required.accepts[0],
      payload: { signature: "0x01", authorization: {} },
    };
    expect(
      readPaymentSignature({ "payment-signature": encodePaymentSignature(payload as never) }),
    ).toMatchObject({ ok: true });
    expect(readPaymentSignature({})).toMatchObject({ ok: false, reason: "missing" });
    const header = encodeSettlement({
      success: true,
      transaction: `0x${"78".repeat(32)}`,
      network: "eip155:5042002",
    });
    expect(readSettlement({ "payment-response": header }).state).toBe("settled");
  });
});
