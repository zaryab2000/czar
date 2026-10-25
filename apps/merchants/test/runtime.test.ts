import { createServer } from "node:http";
import { once } from "node:events";
import { loadConfig } from "@czar/config";
import { createLogger } from "@czar/logging";
import type { Address } from "@czar/hashing";
import { describe, expect, it, vi } from "vitest";
import type { PaymentIdStore } from "../src/payment-id-store.ts";
import { createMerchantServer } from "../src/runtime.ts";

const payTo = "0x00000000000000000000000000000000000000A1";

function testStore(): PaymentIdStore {
  return {
    async claim() {
      return { kind: "new" };
    },
    async complete() {},
    async release() {},
  };
}

describe("merchant process composition", () => {
  it("fails before listen when keyAddress is unavailable", async () => {
    const server = createServer();
    await expect(
      createMerchantServer({
        server,
        config: loadConfig({ envFile: { "merchants.publicOrigin": "http://127.0.0.1:8787" } }),
        signer: {
          async keyAddress() {
            throw new Error("signer offline");
          },
          async sign() {
            throw new Error("unused");
          },
        },
        store: testStore(),
        logger: createLogger({ service: "merchants", component: "CZ-20", sink: () => undefined }),
        port: 0,
      }),
    ).rejects.toThrow("merchant_signer_unavailable");
    expect(server.listening).toBe(false);
  });

  it("uses the signer address in the 402 and serves health/search through HTTP", async () => {
    const keyAddress = vi.fn(async () => payTo as Address);
    const server = createServer();
    const runtime = await createMerchantServer({
      server,
      config: loadConfig({ envFile: { "merchants.publicOrigin": "http://127.0.0.1:8787" } }),
      signer: {
        keyAddress,
        async sign() {
          return { signature: `0x${"11".repeat(65)}`, digest: `0x${"22".repeat(32)}` };
        },
      },
      store: testStore(),
      logger: createLogger({ service: "merchants", component: "CZ-20", sink: () => undefined }),
      port: 0,
      fetchFn: async () => new Response(JSON.stringify({ isValid: false })),
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected TCP address");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      expect(keyAddress).toHaveBeenCalledWith("cz-20", "K10:czar-search");
      expect((await fetch(`${origin}/health`)).status).toBe(200);
      const challenge = await fetch(`${origin}/v1/search?q=fixture`);
      expect(challenge.status).toBe(402);
      expect(JSON.stringify(await challenge.json())).toContain(payTo);
    } finally {
      await runtime.stop();
    }
  });

  it("drains a request already in flight before stopping", async () => {
    const server = createServer();
    const runtime = await createMerchantServer({
      server,
      config: loadConfig({ envFile: { "merchants.publicOrigin": "http://127.0.0.1:8787" } }),
      signer: {
        async keyAddress() {
          return payTo;
        },
        async sign() {
          throw new Error("unused");
        },
      },
      store: testStore(),
      logger: createLogger({ service: "merchants", component: "CZ-20", sink: () => undefined }),
      port: 0,
      drainTimeoutMs: 1000,
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected TCP address");
    const pending = fetch(`http://127.0.0.1:${address.port}/v1/search?q=x`);
    await once(server, "request");
    const stopped = runtime.stop();
    expect((await pending).status).toBe(402);
    await stopped;
  });

  it("applies the route limit to /v1/search while preserving /health", async () => {
    const server = createServer();
    const runtime = await createMerchantServer({
      server,
      config: loadConfig({
        envFile: {
          "merchants.publicOrigin": "http://127.0.0.1:8787",
          "merchants.perRoutePerMin": 1,
        },
      }),
      signer: {
        async keyAddress() {
          return payTo;
        },
        async sign() {
          throw new Error("unused");
        },
      },
      store: testStore(),
      logger: createLogger({ service: "merchants", component: "CZ-20", sink: () => undefined }),
      port: 0,
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected TCP address");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      expect((await fetch(`${origin}/health`)).status).toBe(200);
      expect((await fetch(`${origin}/v1/search?q=a`)).status).toBe(402);
      expect((await fetch(`${origin}/v1/search?q=b`)).status).toBe(429);
    } finally {
      await runtime.stop();
    }
  });

  it("logs an unindexed signer payout address", async () => {
    const lines: string[] = [];
    const runtime = await createMerchantServer({
      config: loadConfig({
        envFile: {
          "merchants.publicOrigin": "http://127.0.0.1:8787",
          "indexer.merchantPayoutAddresses": ["0x00000000000000000000000000000000000000B2"],
        },
      }),
      signer: {
        async keyAddress() {
          return payTo;
        },
        async sign() {
          throw new Error("unused");
        },
      },
      store: testStore(),
      logger: createLogger({
        service: "merchants",
        component: "CZ-20",
        sink: (line) => lines.push(line),
      }),
      port: 0,
    });
    try {
      expect(lines.map((line) => JSON.parse(line))).toContainEqual(
        expect.objectContaining({
          event: "merchant_payout_unindexed",
          payTo,
        }),
      );
    } finally {
      await runtime.stop();
    }
  });
});
