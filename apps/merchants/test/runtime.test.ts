import { request as httpRequest, createServer } from "node:http";
import { loadConfig } from "@czar/config";
import { createLogger } from "@czar/logging";
import type { Address } from "@czar/hashing";
import { encodeBase64Json } from "@czar/x402";
import { appendPaymentIdentifierToExtensions } from "@x402/extensions/payment-identifier";
import { describe, expect, it, vi } from "vitest";
import type { PaymentIdStore } from "../src/payment-id-store.ts";
import { createMerchantServer } from "../src/runtime.ts";

const payTo = "0x00000000000000000000000000000000000000A1";
const payer = "0x00000000000000000000000000000000000c2a21";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function rawGet(port: number, path: string, headers: Record<string, string> = {}) {
  const request = httpRequest(
    { hostname: "127.0.0.1", port, method: "GET", path, headers },
    (response) => {
      response.resume();
    },
  );
  request.on("error", () => undefined);
  request.end();
  return request;
}

async function rawGetStatus(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { hostname: "127.0.0.1", port, method: "GET", path },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on("error", reject);
    request.end();
  });
}

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

  it("drains payment persistence after a buyer disconnects", async () => {
    const completeStarted = deferred();
    const completeGate = deferred();
    let completed = false;
    const store: PaymentIdStore = {
      async claim() {
        return { kind: "new" };
      },
      async complete() {
        completeStarted.resolve();
        await completeGate.promise;
        completed = true;
      },
      async release() {},
    };
    const server = createServer();
    const runtime = await createMerchantServer({
      server,
      config: loadConfig({ envFile: { "merchants.publicOrigin": "http://127.0.0.1:8787" } }),
      signer: {
        async keyAddress() {
          return payTo;
        },
        async sign() {
          return { signature: `0x${"11".repeat(65)}`, digest: `0x${"22".repeat(32)}` };
        },
      },
      store,
      logger: createLogger({ service: "merchants", component: "CZ-20", sink: () => undefined }),
      port: 0,
      drainTimeoutMs: 1000,
      fetchFn: async (url) =>
        new Response(
          JSON.stringify(
            String(url).endsWith("/verify")
              ? { isValid: true, payer }
              : { success: true, transaction: "0xabc", network: "eip155:5042002", payer },
          ),
        ),
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected TCP address");
    const header = encodeBase64Json({
      x402Version: 2,
      resource: { url: "http://127.0.0.1:8787/v1/search" },
      accepted: {
        scheme: "exact",
        network: "eip155:5042002",
        amount: "50000",
        asset: "0x3600000000000000000000000000000000000000",
        payTo,
        maxTimeoutSeconds: 300,
        extra: { name: "USDC", version: "2" },
      },
      payload: {
        signature: `0x${"11".repeat(65)}`,
        authorization: {
          from: payer,
          to: payTo,
          value: "50000",
          validAfter: "0",
          validBefore: "1760800300",
          nonce: `0x${"22".repeat(32)}`,
        },
      },
      extensions: appendPaymentIdentifierToExtensions(
        { "payment-identifier": { info: { required: false } } },
        "pay_shutdown_inflight_0001",
      ),
    });
    const request = rawGet(address.port, "/v1/search?q=x", { "payment-signature": header });
    await completeStarted.promise;
    request.destroy();
    const stopped = runtime.stop();
    let stopResolved = false;
    void stopped.then(() => {
      stopResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopResolved).toBe(false);
    completeGate.resolve();
    await stopped;
    expect(completed).toBe(true);
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
      expect(await rawGetStatus(address.port, "/v1/%2e/search?q=a")).toBe(402);
      expect(await rawGetStatus(address.port, "/v1/search?q=b")).toBe(429);
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
