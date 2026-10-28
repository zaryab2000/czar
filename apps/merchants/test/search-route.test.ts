// T-043 local acceptance against a mocked Facilitator: the 402 shape, verify before the handler, settle only
// after it succeeds, and the payment-identifier store (replay, 409, TTL). No network calls.
import { describe, expect, it } from "vitest";
import { decodeBase64Json, encodeBase64Json, readPaymentRequired } from "@czar/x402";
import { appendPaymentIdentifierToExtensions } from "@x402/extensions/payment-identifier";
import {
  createSearchRoute,
  memoryPaymentIdStore,
  type Facilitator,
  type SettleResult,
  type VerifyResult,
} from "../src/search/index.ts";

const PAY_TO = "0x00000000000000000000000000000000000000A1";
const BUYER = "0x00000000000000000000000000000000000c2a21";
const URL_BASE = "https://merchants.testnet.czar.dev/v1/search";

function mockFacilitator(
  options: { verify?: VerifyResult | Error; settle?: SettleResult | Error } = {},
) {
  const calls: string[] = [];
  const facilitator: Facilitator = {
    async verify() {
      calls.push("verify");
      const result = options.verify ?? { isValid: true, payer: BUYER };
      if (result instanceof Error) throw result;
      return result;
    },
    async settle() {
      calls.push("settle");
      const result = options.settle ?? {
        success: true,
        transaction: "0xabc",
        network: "eip155:5042002",
        payer: BUYER,
      };
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { facilitator, calls };
}

function setup(
  options: Parameters<typeof mockFacilitator>[0] & {
    handler?: (q: string) => Promise<unknown>;
    perPayerPerMin?: number;
  } = {},
) {
  const { facilitator, calls } = mockFacilitator(options);
  let now = 0;
  const store = memoryPaymentIdStore({
    ttlMs: 24 * 3_600_000,
    maxBytes: 1_048_576,
    now: () => now,
  });
  const events: { event: string; fields: Record<string, unknown> }[] = [];
  const route = createSearchRoute({
    resourceUrl: URL_BASE,
    network: "eip155:5042002",
    payTo: PAY_TO,
    priceAtomic: "50000",
    maxTimeoutSeconds: 300,
    handlerTimeoutMs: 10_000,
    ...(options.perPayerPerMin === undefined ? {} : { perPayerPerMin: options.perPayerPerMin }),
    facilitator,
    store,
    emit: (event, fields) => events.push({ event, fields }),
    ...(options.handler === undefined ? {} : { handler: options.handler }),
  });
  return { route, calls, store, events, advance: (ms: number) => (now += ms) };
}

const offer = {
  scheme: "exact",
  network: "eip155:5042002",
  amount: "50000",
  asset: "0x3600000000000000000000000000000000000000",
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  extra: { name: "USDC", version: "2" },
};

function paymentHeader(options: { id?: string; accepted?: Record<string, unknown> } = {}) {
  const extensions =
    options.id === undefined
      ? {}
      : appendPaymentIdentifierToExtensions(
          { "payment-identifier": { info: { required: false } } },
          options.id,
        );
  return encodeBase64Json({
    x402Version: 2,
    resource: { url: URL_BASE },
    accepted: options.accepted ?? offer,
    payload: {
      signature: `0x${"11".repeat(65)}`,
      authorization: {
        from: BUYER,
        to: PAY_TO,
        value: "50000",
        validAfter: "0",
        validBefore: "1760800300",
        nonce: `0x${"22".repeat(32)}`,
      },
    },
    extensions,
  });
}

const get = (q: string | null, headers: Record<string, string> = {}) =>
  new Request(q === null ? URL_BASE : `${URL_BASE}?q=${encodeURIComponent(q)}`, { headers });

describe("czar-search 402", () => {
  it("decodes to the 02 §11.1 field table", async () => {
    const { route } = setup();
    const response = await route(get("eip"));
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
      resource: { url: URL_BASE, mimeType: "application/json", serviceName: "czar-search" },
      accepts: [offer],
      extensions: { "payment-identifier": { info: { required: false } } },
    });
    expect(await response.json()).toEqual(pr);
  });

  it("declares the q input as a bazaar extension that passes the @czar/x402 sanitizer", async () => {
    const { route, calls } = setup();
    const response = await route(get("eip"));
    const read = readPaymentRequired({
      status: response.status,
      headers: response.headers,
      body: await response.clone().text(),
    });
    if (!read.ok) throw new Error(`402 did not parse: ${read.reason}`);
    const bazaar = read.extensions.bazaar;
    expect(read.extensions.dropped).toEqual([]);
    expect(bazaar?.info).toEqual({
      input: { type: "http", method: "GET", queryParams: { q: expect.any(String) } },
    });
    const queryParams = (
      bazaar?.schema as {
        properties: { input: { properties: { queryParams: Record<string, unknown> } } };
      }
    ).properties.input.properties.queryParams;
    expect(queryParams).toMatchObject({
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    });

    const example = (bazaar?.info as { input: { queryParams: { q: string } } }).input.queryParams.q;
    const exampleChallenge = await route(get(example));
    expect(exampleChallenge.status).toBe(402);
    expect(calls).toEqual([]);
  });

  it("answers a v1 X-PAYMENT client with the v2 402 and 'x402 v2 required'", async () => {
    const { route, calls } = setup();
    const response = await route(get("eip", { "x-payment": "abc" }));
    expect(response.status).toBe(402);
    expect(((await response.json()) as { error: string }).error).toBe("x402 v2 required");
    expect(calls).toEqual([]);
  });

  it("refuses an `accepted` that pays a different payee or price", async () => {
    const { route, calls } = setup();
    for (const accepted of [
      { ...offer, payTo: BUYER },
      { ...offer, amount: "1" },
      { ...offer, network: "eip155:8453" },
    ]) {
      const response = await route(
        get("eip", { "payment-signature": paymentHeader({ accepted }) }),
      );
      expect(response.status).toBe(402);
    }
    expect(calls).toEqual([]);
  });

  it("rejects extra or oversized input before any payment step", async () => {
    const { route, calls } = setup();
    expect((await route(new Request(`${URL_BASE}?q=a&x=1`))).status).toBe(400);
    expect((await route(get("a".repeat(201)))).status).toBe(400);
    expect((await route(get(null))).status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe("czar-search verify → handler → settle", () => {
  it("verifies, serves and settles, returning PAYMENT-RESPONSE and the body", async () => {
    const { route, calls } = setup();
    const response = await route(get("typed data", { "payment-signature": paymentHeader() }));
    expect(response.status).toBe(200);
    expect(calls).toEqual(["verify", "settle"]);
    const body = (await response.json()) as { results: { title: string }[] };
    expect(body.results.map((r) => r.title)).toEqual([
      "EIP-712: Typed structured data hashing and signing",
    ]);
    const settlement = decodeBase64Json(response.headers.get("payment-response") as string);
    expect(settlement).toMatchObject({
      ok: true,
      value: { success: true, transaction: "0xabc", amount: "50000" },
    });
  });

  it("a handler failure means no /settle call", async () => {
    const { route, calls, events } = setup({
      handler: async () => {
        throw new Error("index unavailable");
      },
    });
    const response = await route(
      get("eip", { "payment-signature": paymentHeader({ id: "pay_handler_fail_0001" }) }),
    );
    expect(response.status).toBe(500);
    expect(calls).toEqual(["verify"]);
    expect(events.at(-1)).toMatchObject({ event: "merchant.served", fields: { served: false } });
  });

  it("verify false → 402 with the reason, handler never runs", async () => {
    let ran = false;
    const { route, calls } = setup({
      verify: { isValid: false, invalidReason: "insufficient_funds" },
      handler: async () => {
        ran = true;
        return {};
      },
    });
    const response = await route(get("eip", { "payment-signature": paymentHeader() }));
    expect(response.status).toBe(402);
    expect(((await response.json()) as { error: string }).error).toBe("insufficient_funds");
    expect(ran).toBe(false);
    expect(calls).toEqual(["verify"]);
  });

  it("limits a verified payer after Facilitator verification", async () => {
    const { route, calls } = setup({ perPayerPerMin: 1 });
    const first = await route(get("eip", { "payment-signature": paymentHeader() }));
    const second = await route(get("arc", { "payment-signature": paymentHeader() }));
    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(calls).toEqual(["verify", "settle", "verify"]);
  });

  it("withholds service when the verified payer identity is missing", async () => {
    const { route, calls } = setup({ verify: { isValid: true }, perPayerPerMin: 1 });
    const response = await route(get("eip", { "payment-signature": paymentHeader() }));
    expect(response.status).toBe(502);
    expect(calls).toEqual(["verify"]);
  });

  it("settle failure withholds the body; settlement_pending returns it", async () => {
    const failed = setup({ settle: { success: false, errorReason: "invalid_transaction_state" } });
    const response = await failed.route(get("eip", { "payment-signature": paymentHeader() }));
    expect(response.status).toBe(402);
    expect(JSON.stringify(await response.json())).not.toContain("results");

    const pending = setup({
      settle: { success: false, errorReason: "settlement_pending", transaction: "0xdef" },
    });
    const ok = await pending.route(get("eip", { "payment-signature": paymentHeader() }));
    expect(ok.status).toBe(200);
    expect(decodeBase64Json(ok.headers.get("payment-response") as string)).toMatchObject({
      ok: true,
      value: { success: false, transaction: "0xdef", errorReason: "settlement_pending" },
    });
  });

  it("Facilitator unreachable → 503 with Retry-After", async () => {
    const { FacilitatorUnavailable } = await import("../src/search/index.ts");
    const { route } = setup({ verify: new FacilitatorUnavailable("down") });
    const response = await route(get("eip", { "payment-signature": paymentHeader() }));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
  });

  it("logs input hashes only, never the query", async () => {
    const { route, events } = setup();
    await route(get("very private query words", { "payment-signature": paymentHeader() }));
    expect(JSON.stringify(events)).not.toContain("private");
    expect(events[0]?.fields["inputHash"]).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("payment-identifier store", () => {
  it("same id + same payload → cached response without calling the Facilitator again", async () => {
    const { route, calls } = setup();
    const header = paymentHeader({ id: "pay_same_payload_0001" });
    const first = await route(get("eip", { "payment-signature": header }));
    const second = await route(get("eip", { "payment-signature": header }));
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(await first.text());
    expect(second.headers.get("payment-response")).toBe(first.headers.get("payment-response"));
    expect(calls).toEqual(["verify", "settle"]);
  });

  it("same id + different payload → 409", async () => {
    const { route, calls } = setup();
    await route(
      get("eip", { "payment-signature": paymentHeader({ id: "pay_conflict_test_0001" }) }),
    );
    const conflict = await route(
      get("arc", { "payment-signature": paymentHeader({ id: "pay_conflict_test_0001" }) }),
    );
    expect(conflict.status).toBe(409);
    expect(calls).toEqual(["verify", "settle"]);
  });

  it("a request that was not charged frees its id; entries expire after the TTL", async () => {
    const failing = setup({
      verify: { isValid: false, invalidReason: "invalid_exact_evm_payload_signature" },
    });
    await failing.route(
      get("eip", { "payment-signature": paymentHeader({ id: "pay_released_id_0001" }) }),
    );
    expect(failing.store.size()).toBe(0);

    const { route, calls, advance } = setup();
    const header = paymentHeader({ id: "pay_ttl_expiry_00001" });
    await route(get("eip", { "payment-signature": header }));
    advance(24 * 3_600_000);
    await route(get("arc", { "payment-signature": paymentHeader({ id: "pay_ttl_expiry_00001" }) }));
    expect(calls).toEqual(["verify", "settle", "verify", "settle"]);
  });

  it("scopes ids per route", async () => {
    const store = memoryPaymentIdStore({ ttlMs: 1000, maxBytes: 100 });
    expect(await store.claim("/v1/search", "pay_scope_test_00001", `0x${"1".repeat(64)}`)).toEqual({
      kind: "new",
    });
    expect(await store.claim("/v1/spot", "pay_scope_test_00001", `0x${"2".repeat(64)}`)).toEqual({
      kind: "new",
    });
  });

  it("rejects a malformed payment-identifier", async () => {
    const { route, calls } = setup();
    const bad = encodeBase64Json({
      x402Version: 2,
      accepted: offer,
      payload: { signature: "0x", authorization: {} },
      extensions: { "payment-identifier": { info: { required: false, id: "short" } } },
    });
    expect((await route(get("eip", { "payment-signature": bad }))).status).toBe(400);
    expect(calls).toEqual([]);
  });
});
