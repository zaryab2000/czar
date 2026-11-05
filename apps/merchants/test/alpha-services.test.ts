// PM-042 composition (CZ-20 §5.8 startup): `createAlphaMerchantServer` serves czar-search, czar-spot and
// czar-extract, each with its own K10 `payTo` from the signer, while `createMerchantServer` called the way
// `local-main.ts` calls it still serves czar-search alone (the local signer knows only that service).
import { createServer } from "node:http";
import { loadConfig } from "@czar/config";
import { createLogger } from "@czar/logging";
import type { Address } from "@czar/hashing";
import { describe, expect, it, vi } from "vitest";
import { createAlphaMerchantServer, ALPHA_SERVICE_IDS } from "../src/alpha-services.ts";
import { createMerchantServer } from "../src/runtime.ts";
import { EXTRACT_PATH } from "../src/extract/index.ts";
import { SPOT_PATH } from "../src/spot/index.ts";
import { SEARCH_PATH } from "../src/search/index.ts";
import { fakeSafeFetch, testStore } from "./x402-doubles.ts";

const ADDRESSES: Record<string, string> = {
  "K10:czar-search": "0x00000000000000000000000000000000000000A1",
  "K10:czar-spot": "0x00000000000000000000000000000000000000A2",
  "K10:czar-extract": "0x00000000000000000000000000000000000000A3",
};

function signer(addresses: Record<string, string> = ADDRESSES) {
  const keyAddress = vi.fn(async (_caller: string, keyRef: string) => {
    const address = addresses[keyRef];
    if (address === undefined) throw new Error(`no such key: ${keyRef}`);
    return address as Address;
  });
  return {
    keyAddress,
    signer: {
      keyAddress,
      async sign() {
        return {
          signature: `0x${"11".repeat(65)}` as const,
          digest: `0x${"22".repeat(32)}` as const,
        };
      },
    },
  };
}

const config = () => loadConfig({ envFile: { "merchants.publicOrigin": "http://127.0.0.1:8787" } });

const logger = () =>
  createLogger({ service: "merchants", component: "CZ-20", sink: () => undefined });

describe("local composition is unchanged", () => {
  it("createMerchantServer with no service list still serves czar-search alone", async () => {
    const { keyAddress, signer: merchantSigner } = signer();
    const runtime = await createMerchantServer({
      server: createServer(),
      config: config(),
      signer: merchantSigner,
      store: testStore(),
      logger: logger(),
      port: 0,
    });
    try {
      expect(runtime.routes).toEqual([SEARCH_PATH]);
      expect(keyAddress.mock.calls).toEqual([["cz-20", "K10:czar-search"]]);
    } finally {
      await runtime.stop();
    }
  });

  it("the local service list never reaches for a K10 key the local signer lacks", async () => {
    // The local signer's merchantServices is ["czar-search"] (apps/signer/src/local-main.ts:58).
    const { signer: merchantSigner } = signer({
      "K10:czar-search": ADDRESSES["K10:czar-search"] as string,
    });
    const runtime = await createMerchantServer({
      server: createServer(),
      config: config(),
      signer: merchantSigner,
      store: testStore(),
      logger: logger(),
      port: 0,
    });
    try {
      expect(runtime.routes).toEqual([SEARCH_PATH]);
    } finally {
      await runtime.stop();
    }
  });
});

describe("createAlphaMerchantServer", () => {
  it("serves all three services, each behind its own K10 payTo", async () => {
    const { keyAddress, signer: merchantSigner } = signer();
    const server = createServer();
    const runtime = await createAlphaMerchantServer({
      server,
      config: config(),
      signer: merchantSigner,
      store: testStore(),
      logger: logger(),
      port: 0,
      safeFetch: fakeSafeFetch({ pages: { "*": { body: "<html><title>t</title></html>" } } })
        .safeFetch,
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected TCP address");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      expect(ALPHA_SERVICE_IDS).toEqual(["czar-search", "czar-spot", "czar-extract"]);
      expect(runtime.routes).toEqual([SEARCH_PATH, SPOT_PATH, EXTRACT_PATH]);
      expect(keyAddress.mock.calls.map((call) => call[1])).toEqual([
        "K10:czar-search",
        "K10:czar-spot",
        "K10:czar-extract",
      ]);

      expect((await fetch(`${origin}/health`)).status).toBe(200);

      const search = await fetch(`${origin}${SEARCH_PATH}?q=eip`);
      expect(search.status).toBe(402);
      expect(JSON.stringify(await search.json())).toContain(ADDRESSES["K10:czar-search"]);

      const spot = await fetch(`${origin}${SPOT_PATH}?pair=BTC-USD`);
      expect(spot.status).toBe(402);
      expect(JSON.stringify(await spot.json())).toContain(ADDRESSES["K10:czar-spot"]);

      const extract = await fetch(`${origin}${EXTRACT_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/p" }),
      });
      expect(extract.status).toBe(402);
      expect(JSON.stringify(await extract.json())).toContain(ADDRESSES["K10:czar-extract"]);
    } finally {
      await runtime.stop();
    }
  });

  it("stops before listening when one service's K10 key is unavailable", async () => {
    const server = createServer();
    const { signer: merchantSigner } = signer({
      "K10:czar-search": ADDRESSES["K10:czar-search"] as string,
    });
    await expect(
      createAlphaMerchantServer({
        server,
        config: config(),
        signer: merchantSigner,
        store: testStore(),
        logger: logger(),
        port: 0,
        safeFetch: fakeSafeFetch({ pages: {} }).safeFetch,
      }),
    ).rejects.toThrow("merchant_signer_unavailable");
    expect(server.listening).toBe(false);
  });

  it("applies the route rate limit per route, not across routes", async () => {
    const { signer: merchantSigner } = signer();
    const server = createServer();
    const runtime = await createAlphaMerchantServer({
      server,
      config: loadConfig({
        envFile: {
          "merchants.publicOrigin": "http://127.0.0.1:8787",
          "merchants.perRoutePerMin": 1,
        },
      }),
      signer: merchantSigner,
      store: testStore(),
      logger: logger(),
      port: 0,
      safeFetch: fakeSafeFetch({ pages: { "*": { body: "<html></html>" } } }).safeFetch,
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected TCP address");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      expect((await fetch(`${origin}${SEARCH_PATH}?q=a`)).status).toBe(402);
      expect((await fetch(`${origin}${SEARCH_PATH}?q=b`)).status).toBe(429);
      expect((await fetch(`${origin}${SPOT_PATH}?pair=BTC-USD`)).status).toBe(402);
      expect((await fetch(`${origin}${SPOT_PATH}?pair=ETH-USD`)).status).toBe(429);
      expect((await fetch(`${origin}/health`)).status).toBe(200);
    } finally {
      await runtime.stop();
    }
  });

  it("logs every unindexed K10 payout address by address only", async () => {
    const lines: string[] = [];
    const { signer: merchantSigner } = signer();
    const runtime = await createAlphaMerchantServer({
      config: loadConfig({
        envFile: {
          "merchants.publicOrigin": "http://127.0.0.1:8787",
          "indexer.merchantPayoutAddresses": [ADDRESSES["K10:czar-search"] as string],
        },
      }),
      signer: merchantSigner,
      store: testStore(),
      logger: createLogger({
        service: "merchants",
        component: "CZ-20",
        sink: (line) => lines.push(line),
      }),
      port: 0,
      safeFetch: fakeSafeFetch({ pages: {} }).safeFetch,
    });
    try {
      const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      const unindexed = events.filter((event) => event["event"] === "merchant_payout_unindexed");
      expect(unindexed.map((event) => event["payTo"])).toEqual([
        ADDRESSES["K10:czar-spot"],
        ADDRESSES["K10:czar-extract"],
      ]);
      // The allowlist (cross-cutting §4) keeps the service name out of the log line.
      expect(JSON.stringify(unindexed)).not.toContain("czar-spot");
    } finally {
      await runtime.stop();
    }
  });
});
