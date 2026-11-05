// T-051 part A, `czar-spot` (CZ-20 §5.1, §5.2, §5.7, D49): the vanilla 402, the public-source cache and
// its refresh interval, and the deterministic synthetic fallback when the source is unreachable.
// No test here reaches the network: the source is served by an injected safeFetch transport.
import { describe, expect, it } from "vitest";
import { decodeBase64Json, readPaymentRequired } from "@czar/x402";
import { createSpotRoute, SPOT_PATH, SYNTHETIC_SOURCE } from "../src/spot/index.ts";
import {
  BUYER,
  fakeSafeFetch,
  mockFacilitator,
  offerFor,
  paymentHeader,
  NETWORK,
  PAY_TO,
  testStore,
  type FakePages,
  type MockFacilitatorOptions,
} from "./x402-doubles.ts";

const ORIGIN = "https://merchants.testnet.czar.dev";
const RESOURCE = `${ORIGIN}${SPOT_PATH}`;
const PRICE = "50000";
const PAIRS = ["BTC-USD", "ETH-USD", "USDC-USD"] as const;
const SOURCE_TEMPLATE = "https://api.coinbase.com/v2/prices/{pair}/spot";

const coinbaseBody = (amount: string, pair = "BTC-USD") =>
  JSON.stringify({ data: { base: pair.split("-")[0], currency: pair.split("-")[1], amount } });

interface SpotSetupOptions extends MockFacilitatorOptions {
  readonly pages?: FakePages;
  readonly refreshSeconds?: number;
  readonly sourceUrlTemplate?: string;
}

function setup(options: SpotSetupOptions = {}) {
  const { facilitator, calls } = mockFacilitator(options);
  let now = 1_760_800_000_000;
  const { safeFetch, requests } = fakeSafeFetch({
    pages: options.pages ?? { "*": { body: coinbaseBody("100.500000") } },
  });
  const service = createSpotRoute({
    resourceUrl: RESOURCE,
    network: NETWORK,
    payTo: PAY_TO,
    priceAtomic: PRICE,
    maxTimeoutSeconds: 300,
    handlerTimeoutMs: 10_000,
    facilitator,
    store: testStore(() => now),
    safeFetch,
    sourceUrlTemplate: options.sourceUrlTemplate ?? SOURCE_TEMPLATE,
    pairs: PAIRS,
    refreshSeconds: options.refreshSeconds ?? 300,
    now: () => now,
  });
  return {
    service,
    calls,
    requests,
    advance: (ms: number) => (now += ms),
    get: (query: string, headers: Record<string, string> = {}) =>
      service.handle(new Request(`${RESOURCE}${query}`, { headers })),
    paid: (query: string, id?: string) =>
      service.handle(
        new Request(`${RESOURCE}${query}`, {
          headers: {
            "payment-signature": paymentHeader({
              resourceUrl: RESOURCE,
              amount: PRICE,
              ...(id === undefined ? {} : { id }),
            }),
          },
        }),
      ),
  };
}

describe("czar-spot 402", () => {
  it("answers an unpaid request with a vanilla 402 that decodes with @czar/x402", async () => {
    const { service, calls } = setup();
    const response = await service.handle(new Request(`${RESOURCE}?pair=BTC-USD`));
    expect(response.status).toBe(402);
    const read = readPaymentRequired({
      status: response.status,
      headers: response.headers,
      body: await response.clone().text(),
    });
    expect(read.ok).toBe(true);
    const decoded = decodeBase64Json(response.headers.get("payment-required") as string);
    const pr = (decoded as { ok: true; value: Record<string, unknown> }).value;
    expect(pr).toMatchObject({
      x402Version: 2,
      resource: { url: RESOURCE, mimeType: "application/json", serviceName: "czar-spot" },
      accepts: [offerFor(PRICE)],
      extensions: { "payment-identifier": { info: { required: false } } },
    });
    expect(await response.json()).toEqual(pr);
    expect(calls).toEqual([]);
  });

  it("declares the pair input as a bazaar extension the sanitizer keeps", async () => {
    const { service } = setup();
    const response = await service.handle(new Request(`${RESOURCE}?pair=BTC-USD`));
    const read = readPaymentRequired({
      status: response.status,
      headers: response.headers,
      body: await response.clone().text(),
    });
    if (!read.ok) throw new Error(`402 did not parse: ${read.reason}`);
    expect(read.extensions.dropped).toEqual([]);
    const bazaar = read.extensions.bazaar;
    if (bazaar === undefined) throw new Error("402 declares no sanitized bazaar extension");
    expect(bazaar.info).toEqual({
      input: { type: "http", method: "GET", queryParams: { pair: expect.any(String) } },
    });
  });

  it("rejects an unknown or extra pair before any payment step", async () => {
    const { get, calls } = setup();
    expect((await get("?pair=BTC-USD&x=1")).status).toBe(400);
    expect((await get("?pair=DOGE-USD")).status).toBe(400);
    expect((await get("")).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("answers a v1 X-PAYMENT client with the v2 402", async () => {
    const { get, calls } = setup();
    const response = await get("?pair=BTC-USD", { "x-payment": "abc" });
    expect(response.status).toBe(402);
    expect(((await response.json()) as { error: string }).error).toBe("x402 v2 required");
    expect(calls).toEqual([]);
  });

  it("refuses an `accepted` that pays a different payee or price", async () => {
    const { service, calls } = setup();
    for (const accepted of [
      { ...offerFor(PRICE), payTo: BUYER },
      { ...offerFor(PRICE), amount: "1" },
    ]) {
      const response = await service.handle(
        new Request(`${RESOURCE}?pair=BTC-USD`, {
          headers: {
            "payment-signature": paymentHeader({
              resourceUrl: RESOURCE,
              amount: PRICE,
              accepted,
            }),
          },
        }),
      );
      expect(response.status).toBe(402);
    }
    expect(calls).toEqual([]);
  });
});

describe("czar-spot body", () => {
  it("serves the public source with `source` always present", async () => {
    const { paid, calls, requests } = setup();
    const response = await paid("?pair=BTC-USD");
    expect(response.status).toBe(200);
    expect(calls).toEqual(["verify", "settle"]);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      pair: "BTC-USD",
      price: "100.500000",
      asOf: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/),
      source: "api.coinbase.com",
    });
    expect(requests[0]?.path).toBe("/v2/prices/BTC-USD/spot");
  });

  it("never sends an API key, a contact address or any identifier to the source", async () => {
    const { paid, requests } = setup();
    await paid("?pair=BTC-USD");
    const headers = requests[0]?.headers ?? {};
    // Only what safeFetch itself sets, plus the content type we accept. Nothing identifies Czar or a user.
    expect(Object.keys(headers).toSorted()).toEqual(["accept", "host", "user-agent"]);
    expect(headers["user-agent"]).toBe("Czar/0.0.0-test");
    expect(headers["host"]).toBe("api.coinbase.com");
    expect(JSON.stringify(requests)).not.toMatch(/@|api[-_]?key|authorization|token|contact/i);
    // No query of ours is appended to the source URL either.
    expect(requests[0]?.path).toBe("/v2/prices/BTC-USD/spot");
  });

  it("falls back to the deterministic synthetic series when the source is unreachable", async () => {
    const unreachable = setup({
      pages: { "*": Object.assign(new Error("down"), { code: "ECONNREFUSED" }) },
    });
    const first = await unreachable.paid("?pair=BTC-USD");
    expect(first.status).toBe(200);
    const body = (await first.json()) as Record<string, unknown>;
    expect(body["source"]).toBe(SYNTHETIC_SOURCE);
    expect(body["source"]).toBe("synthetic-testnet");
    expect(body["price"]).toMatch(/^\d+\.\d{6}$/);

    // Deterministic: the same pair and the same refresh bucket give the same price.
    const again = setup({
      pages: { "*": Object.assign(new Error("down"), { code: "ECONNREFUSED" }) },
    });
    const repeat = (await (await again.paid("?pair=BTC-USD")).json()) as Record<string, unknown>;
    expect(repeat["price"]).toBe(body["price"]);
    const other = (await (await again.paid("?pair=ETH-USD")).json()) as Record<string, unknown>;
    expect(other["price"]).not.toBe(body["price"]);
  });

  it("falls back when the source answers a non-200 or an unparseable body", async () => {
    for (const page of [
      { status: 503, body: "" },
      { body: "not json" },
      { body: JSON.stringify({ data: { amount: "oops" } }) },
    ]) {
      const { paid } = setup({ pages: { "*": page } });
      const body = (await (await paid("?pair=BTC-USD")).json()) as Record<string, unknown>;
      expect(body["source"]).toBe(SYNTHETIC_SOURCE);
    }
  });

  it("reads Kraken's public ticker shape too, so the source key can be switched", async () => {
    const { paid, requests } = setup({
      sourceUrlTemplate: "https://api.kraken.com/0/public/Ticker?pair={pair}",
      pages: {
        "*": {
          body: JSON.stringify({ error: [], result: { XXBTZUSD: { c: ["7.250000", "1"] } } }),
        },
      },
    });
    const body = (await (await paid("?pair=BTC-USD")).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ pair: "BTC-USD", price: "7.250000", source: "api.kraken.com" });
    expect(requests[0]?.path).toBe("/0/public/Ticker?pair=BTC-USD");
  });

  it("honours the refresh interval: one source call per pair per interval", async () => {
    const { paid, requests, advance } = setup({ refreshSeconds: 300 });
    await paid("?pair=BTC-USD");
    await paid("?pair=BTC-USD");
    advance(299_000);
    await paid("?pair=BTC-USD");
    expect(requests).toHaveLength(1);

    advance(2_000);
    await paid("?pair=BTC-USD");
    expect(requests).toHaveLength(2);

    await paid("?pair=ETH-USD");
    expect(requests).toHaveLength(3);
    expect(requests.map((r) => r.path)).toEqual([
      "/v2/prices/BTC-USD/spot",
      "/v2/prices/BTC-USD/spot",
      "/v2/prices/ETH-USD/spot",
    ]);
  });

  it("serves the cached quote while it is fresh, with its own asOf", async () => {
    const { paid, advance } = setup({ refreshSeconds: 300 });
    const first = (await (await paid("?pair=BTC-USD")).json()) as Record<string, unknown>;
    advance(10_000);
    const second = (await (await paid("?pair=BTC-USD")).json()) as Record<string, unknown>;
    expect(second["asOf"]).toBe(first["asOf"]);
    expect(second["price"]).toBe(first["price"]);
  });

  it("does not settle when the handler fails", async () => {
    const { facilitator, calls } = mockFacilitator();
    const broken = createSpotRoute({
      resourceUrl: RESOURCE,
      network: NETWORK,
      payTo: PAY_TO,
      priceAtomic: PRICE,
      maxTimeoutSeconds: 300,
      handlerTimeoutMs: 10_000,
      facilitator,
      store: testStore(),
      safeFetch: fakeSafeFetch({ pages: {} }).safeFetch,
      sourceUrlTemplate: SOURCE_TEMPLATE,
      pairs: PAIRS,
      refreshSeconds: 300,
      quote: async () => {
        throw new Error("source module failed");
      },
    });
    const response = await broken.handle(
      new Request(`${RESOURCE}?pair=BTC-USD`, {
        headers: {
          "payment-signature": paymentHeader({ resourceUrl: RESOURCE, amount: PRICE }),
        },
      }),
    );
    expect(response.status).toBe(500);
    expect(broken.path).toBe(SPOT_PATH);
    expect(calls).toEqual(["verify"]);
  });

  it("logs the pair as a hash, never the raw query", async () => {
    const events: { event: string; fields: Record<string, unknown> }[] = [];
    const service = createSpotRoute({
      resourceUrl: RESOURCE,
      network: NETWORK,
      payTo: PAY_TO,
      priceAtomic: PRICE,
      maxTimeoutSeconds: 300,
      handlerTimeoutMs: 10_000,
      facilitator: mockFacilitator().facilitator,
      store: testStore(),
      safeFetch: fakeSafeFetch({ pages: { "*": { body: coinbaseBody("1.000000") } } }).safeFetch,
      sourceUrlTemplate: SOURCE_TEMPLATE,
      pairs: PAIRS,
      refreshSeconds: 300,
      emit: (event, fields) => events.push({ event, fields }),
    });
    await service.handle(
      new Request(`${RESOURCE}?pair=BTC-USD`, {
        headers: {
          "payment-signature": paymentHeader({ resourceUrl: RESOURCE, amount: PRICE }),
        },
      }),
    );
    expect(JSON.stringify(events)).not.toContain("BTC-USD");
    expect(JSON.stringify(events)).not.toContain("coinbase");
    expect(events[0]?.fields["inputHash"]).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
