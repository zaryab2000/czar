// Shared test doubles for the vanilla x402 lifecycle: a mocked Facilitator and a safeFetch whose
// transport and DNS answers are injected, so no test in this package reaches the network.
import { createSafeFetch, type SafeFetch, type Transport } from "@czar/x402";
import { appendPaymentIdentifierToExtensions } from "@x402/extensions/payment-identifier";
import { encodeBase64Json } from "@czar/x402";
import type { Facilitator, SettleResult, VerifyResult } from "../src/facilitator.ts";
import { memoryPaymentIdStore, type PaymentIdStore } from "../src/payment-id-store.ts";

export const PAY_TO = "0x00000000000000000000000000000000000000A1";
export const BUYER = "0x00000000000000000000000000000000000c2a21";
export const NETWORK = "eip155:5042002";
export const USDC = "0x3600000000000000000000000000000000000000";

export interface MockFacilitatorOptions {
  readonly verify?: VerifyResult | Error;
  readonly settle?: SettleResult | Error;
}

export function mockFacilitator(options: MockFacilitatorOptions = {}) {
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
        network: NETWORK,
        payer: BUYER,
      };
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { facilitator, calls };
}

export function testStore(now: () => number = () => 0): PaymentIdStore {
  return memoryPaymentIdStore({ ttlMs: 24 * 3_600_000, maxBytes: 1_048_576, now });
}

/** An `accepts[0]`-shaped offer for the given price. */
export const offerFor = (amount: string) => ({
  scheme: "exact",
  network: NETWORK,
  amount,
  asset: USDC,
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  extra: { name: "USDC", version: "2" },
});

export function paymentHeader(options: {
  resourceUrl: string;
  amount: string;
  id?: string;
  accepted?: Record<string, unknown>;
}) {
  const extensions =
    options.id === undefined
      ? {}
      : appendPaymentIdentifierToExtensions(
          { "payment-identifier": { info: { required: false } } },
          options.id,
        );
  return encodeBase64Json({
    x402Version: 2,
    resource: { url: options.resourceUrl },
    accepted: options.accepted ?? offerFor(options.amount),
    payload: {
      signature: `0x${"11".repeat(65)}`,
      authorization: {
        from: BUYER,
        to: PAY_TO,
        value: options.amount,
        validAfter: "0",
        validBefore: "1760800300",
        nonce: `0x${"22".repeat(32)}`,
      },
    },
    extensions,
  });
}

export interface FakePage {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: string | Uint8Array;
}

/** Fake pages keyed by request path, or `*` for any path; an `Error` makes the transport fail. */
export type FakePages = Readonly<Record<string, FakePage | Error>>;

/**
 * safeFetch with its transport and resolver injected (`SafeFetchDeps.transport`, `.resolve`): the real
 * address rules still run, so a blocked address is still blocked, but nothing leaves the process.
 */
export function fakeSafeFetch(options: {
  readonly pages: FakePages;
  readonly maxRedirects?: number;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  /** Public address every hostname resolves to. */
  readonly address?: string;
  readonly onRequest?: (target: { path: string; headers: Record<string, string> }) => void;
}): { safeFetch: SafeFetch; requests: { path: string; headers: Record<string, string> }[] } {
  const requests: { path: string; headers: Record<string, string> }[] = [];
  const transport: Transport = async (target) => {
    requests.push({ path: target.path, headers: target.headers });
    options.onRequest?.({ path: target.path, headers: target.headers });
    const page = options.pages[target.path] ?? options.pages["*"];
    if (page === undefined)
      throw Object.assign(new Error("no fake page"), { code: "ECONNREFUSED" });
    if (page instanceof Error) throw page;
    const bytes = typeof page.body === "string" ? new TextEncoder().encode(page.body) : page.body;
    return {
      status: page.status ?? 200,
      headers: { "content-type": "text/html; charset=utf-8", ...page.headers },
      body: (async function* () {
        yield bytes;
      })(),
    };
  };
  const safeFetch = createSafeFetch({
    localMerchantOrigins: [],
    maxRedirects: options.maxRedirects ?? 3,
    maxBytes: options.maxBytes ?? 2_097_152,
    timeoutMs: options.timeoutMs ?? 8_000,
    version: "0.0.0-test",
    resolve: async () => [{ address: options.address ?? "93.184.216.34", family: 4 }],
    interfaceAddresses: () => [],
    transport,
  });
  return { safeFetch, requests };
}
