import { describe, expect, it } from "vitest";
import { fixtureMerchantResponse } from "#src/social/fixture-merchants";

describe("local-only fixture supplier probe", () => {
  it("returns an unpaid exact 402 on each fixture-only search origin", async () => {
    for (const port of [8788, 8789]) {
      const response = fixtureMerchantResponse(
        new Request(`http://127.0.0.1:${port}/v1/search?q=czar%20probe`),
      );
      expect(response.status).toBe(402);
      const body = (await response.json()) as {
        x402Version: number;
        accepts: { payTo: string; network: string }[];
      };
      expect(body.x402Version).toBe(2);
      expect(body.accepts[0]?.network).toBe("eip155:5042002");
      expect(response.headers.get("payment-required")).toBeTruthy();
      expect(body.accepts[0]?.payTo).toMatch(/^0x[0-9a-f]{40}$/);
    }
  });

  it("refuses any payment signature rather than settling a fixture request", () => {
    const response = fixtureMerchantResponse(
      new Request("http://127.0.0.1:8788/v1/search?q=czar", {
        headers: { "payment-signature": "fixture" },
      }),
    );
    expect(response.status).toBe(400);
  });
});
