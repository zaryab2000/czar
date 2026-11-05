// T-106 / PM-043: the Czar test-merchant lab (CZ-20 §5.8a). Six services whose behaviour differs on purpose,
// each a pure function of `merchants.lab.seed` and the service's own call sequence, never of who the buyer
// is. Nothing here reaches the network: lab search and extract read bundled data, and lab spot reads an
// injected safeFetch transport.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { loadConfig, type Config } from "@czar/config";
import { createLogger } from "@czar/logging";
import type { Address } from "@czar/hashing";
import { describe, expect, it, vi } from "vitest";
import { createAlphaMerchantServer } from "../src/alpha-services.ts";
import { validateDiscoveryIndexEntry } from "../src/index-entry.ts";
import {
  LAB_CORPUS,
  LAB_SERVICE_IDS,
  labCoin,
  labPath,
  labServiceSpecs,
  type LabServiceId,
} from "../src/lab/index.ts";
import { SEARCH_INDEX } from "../src/search/index.ts";
import type { Facilitator } from "../src/facilitator.ts";
import type { ServiceBuildContext } from "../src/runtime.ts";
import type { MerchantService } from "../src/vanilla-route.ts";
import {
  BUYER,
  fakeSafeFetch,
  NETWORK,
  offerFor,
  PAY_TO,
  paymentHeader,
  testStore,
} from "./x402-doubles.ts";

const ORIGIN = "https://merchants.testnet.czar.dev";
const SEED = 20261105;
const PRICE = 40_000;
const SWAP_PAY_TO = "0x00000000000000000000000000000000000000B7";
const SECOND_BUYER = "0x00000000000000000000000000000000000d3b32";
const CALLS = 1_000;
const RATE_TOLERANCE = 0.05;
const DAY_MS = 86_400_000;
const COINBASE = JSON.stringify({ data: { base: "BTC", currency: "USD", amount: "100.5" } });

const baseEnv = {
  "merchants.publicOrigin": ORIGIN,
  "merchants.lab.priceAtomic": PRICE,
  // 1,000 paid calls come from one payer; the per-payer limit is not what these tests are about.
  "merchants.perPayerPerMin": 1_000_000,
} as const;

const configWith = (extra: Record<string, number | boolean | string> = {}): Config =>
  loadConfig({ envFile: { ...baseEnv, ...extra } });

/** A Facilitator that records its calls and reports the payer named in the signed payload. */
function recordingFacilitator() {
  const calls: string[] = [];
  const facilitator: Facilitator = {
    async verify(payload) {
      calls.push("verify");
      const from = (payload as { payload: { authorization: { from: string } } }).payload
        .authorization.from;
      return { isValid: true, payer: from };
    },
    async settle(payload) {
      calls.push("settle");
      const from = (payload as { payload: { authorization: { from: string } } }).payload
        .authorization.from;
      return { success: true, transaction: "0xabc", network: NETWORK, payer: from };
    },
  };
  return { facilitator, calls };
}

interface LabSetup {
  readonly config?: Config;
  readonly seed?: number;
  readonly now?: () => number;
  readonly swapPayTo?: string | undefined;
}

/** Builds the lab services directly, one `MerchantService` per id, each behind the same K10 stand-in. */
function buildLab(setup: LabSetup = {}) {
  const { facilitator, calls } = recordingFacilitator();
  const sleeps: number[] = [];
  const config = setup.config ?? configWith();
  const context: ServiceBuildContext = {
    config,
    network: NETWORK,
    payTo: PAY_TO,
    facilitator,
    store: testStore(),
    emit: () => undefined,
    resourceUrl: (path) => `${ORIGIN}${path}`,
  };
  const specs = labServiceSpecs({
    config,
    safeFetch: fakeSafeFetch({ pages: { "*": { body: COINBASE } } }).safeFetch,
    seed: setup.seed ?? SEED,
    swapPayTo: "swapPayTo" in setup ? setup.swapPayTo : SWAP_PAY_TO,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...(setup.now === undefined ? {} : { now: setup.now }),
  });
  const services = new Map<string, MerchantService>(
    specs.map((spec) => [spec.serviceName, spec.build(context)]),
  );
  const get = (id: LabServiceId): MerchantService => {
    const service = services.get(id);
    if (service === undefined) throw new Error(`lab service ${id} was not built`);
    return service;
  };
  return { get, services, calls, sleeps, specs };
}

const searchUrl = (id: LabServiceId, q: string) =>
  `${ORIGIN}${labPath(id)}?q=${encodeURIComponent(q)}`;
const spotUrl = (id: LabServiceId, pair = "BTC-USD") => `${ORIGIN}${labPath(id)}?pair=${pair}`;
const extractRequest = (id: LabServiceId, url: string, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${labPath(id)}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ url }),
  });

const pay = (id: LabServiceId, buyer = BUYER, accepted?: Record<string, unknown>) => ({
  "payment-signature": paymentHeader({
    resourceUrl: `${ORIGIN}${labPath(id)}`,
    amount: String(PRICE),
    buyer,
    ...(accepted === undefined ? {} : { accepted }),
  }),
});

const paidSearch = (
  service: MerchantService,
  id: LabServiceId,
  q: string,
  buyer = BUYER,
): Promise<Response> => service.handle(new Request(searchUrl(id, q), { headers: pay(id, buyer) }));

const paidExtract = (
  service: MerchantService,
  id: LabServiceId,
  url: string,
  buyer = BUYER,
): Promise<Response> => service.handle(extractRequest(id, url, pay(id, buyer)));

const corpusUrl = (index: number) => (LAB_CORPUS[index % LAB_CORPUS.length] as { url: string }).url;

/** The price an unpaid request is quoted, read from the live 402. */
async function quotedAmount(service: MerchantService, request: Request): Promise<string> {
  const response = await service.handle(request);
  expect(response.status).toBe(402);
  const body = (await response.json()) as { accepts: { amount: string; payTo: string }[] };
  return (body.accepts[0] as { amount: string }).amount;
}

async function quotedPayTo(service: MerchantService, request: Request): Promise<string> {
  const response = await service.handle(request);
  expect(response.status).toBe(402);
  const body = (await response.json()) as { accepts: { amount: string; payTo: string }[] };
  return (body.accepts[0] as { payTo: string }).payTo;
}

const within = (observed: number, expected: number) =>
  Math.abs(observed - expected) <= RATE_TOLERANCE;

/** The profile also lands within 1% of its rate, which holds on the stricter relative reading of ±5%. */
const TIGHT_TOLERANCE = 0.01;
const tight = (observed: number, expected: number) =>
  Math.abs(observed - expected) <= TIGHT_TOLERANCE;

const flakyStatuses = async (seed: number) => {
  const { get } = buildLab({ seed });
  const service = get("lab-search-flaky");
  const out: number[] = [];
  for (let i = 0; i < 200; i += 1)
    out.push((await paidSearch(service, "lab-search-flaky", "eip")).status);
  return out;
};

const countHits = (flip: () => boolean, calls: number) => {
  let hits = 0;
  for (let i = 0; i < calls; i += 1) if (flip()) hits += 1;
  return hits;
};

const coinRun = (
  seed: number,
  service: "lab-search-flaky" | "lab-extract-drift",
  stream: string,
) => {
  const flip = labCoin(seed, service, stream, 0.3);
  return Array.from({ length: 300 }, () => flip());
};

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

/** One unpaid request to each of the six lab routes. */
const labRequests = (origin: string) => [
  fetch(`${origin}${labPath("lab-search-steady")}?q=eip`),
  fetch(`${origin}${labPath("lab-search-flaky")}?q=eip`),
  fetch(`${origin}${labPath("lab-search-slow")}?q=eip`),
  fetch(`${origin}${labPath("lab-spot-payee-swap")}?pair=BTC-USD`),
  fetch(`${origin}${labPath("lab-extract-schemabreak")}`, {
    method: "POST",
    body: JSON.stringify({ url: corpusUrl(0) }),
  }),
  fetch(`${origin}${labPath("lab-extract-drift")}`, {
    method: "POST",
    body: JSON.stringify({ url: corpusUrl(0) }),
  }),
];

/** Runs one fixed request sequence for one buyer on a fresh lab and records every outcome. */
async function runBuyerSequence(buyer: string) {
  const { get, calls } = buildLab();
  const out: string[] = [];
  const flaky = get("lab-search-flaky");
  const broken = get("lab-extract-schemabreak");
  for (let i = 0; i < 300; i += 1) {
    out.push(`f${(await paidSearch(flaky, "lab-search-flaky", `eip ${i}`, buyer)).status}`);
    const response = await paidExtract(broken, "lab-extract-schemabreak", corpusUrl(i), buyer);
    out.push(`e${"text" in ((await response.json()) as object)}`);
  }
  return { out, calls };
}

async function start(
  extra: Record<string, number | boolean | string>,
  lab: { seed?: number; payeeSwapKeyRef?: string } | null = {
    seed: SEED,
    payeeSwapKeyRef: "K10:second",
  },
) {
  const refs: string[] = [];
  const server = createServer();
  const runtime = await createAlphaMerchantServer({
    server,
    config: configWith(extra),
    signer: {
      async keyAddress(_caller: string, keyRef: string) {
        refs.push(keyRef);
        return addr(0xa000 + refs.length);
      },
      async sign() {
        return {
          signature: `0x${"11".repeat(65)}` as const,
          digest: `0x${"22".repeat(32)}` as const,
        };
      },
    },
    store: testStore(),
    logger: createLogger({ service: "merchants", component: "CZ-20", sink: () => undefined }),
    port: 0,
    safeFetch: fakeSafeFetch({ pages: { "*": { body: COINBASE } } }).safeFetch,
    ...(lab === null ? {} : { lab }),
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected TCP address");
  return { runtime, refs, origin: `http://127.0.0.1:${address.port}` };
}

const driftQuotes = async (service: MerchantService, buyer: string) => {
  const out: string[] = [];
  for (let i = 0; i < 100; i += 1)
    out.push(
      await quotedAmount(
        service,
        extractRequest("lab-extract-drift", corpusUrl(i), { "x-buyer": buyer }),
      ),
    );
  return out;
};

describe("the six services and their routes", () => {
  it("names exactly the six CZ-20 §5.8a services, each under /lab/<service>/", () => {
    expect(LAB_SERVICE_IDS).toEqual([
      "lab-search-steady",
      "lab-search-flaky",
      "lab-search-slow",
      "lab-extract-schemabreak",
      "lab-extract-drift",
      "lab-spot-payee-swap",
    ]);
    const { services } = buildLab();
    expect([...services.keys()]).toEqual([...LAB_SERVICE_IDS]);
    for (const id of LAB_SERVICE_IDS) {
      expect(labPath(id).startsWith(`/lab/${id}/`)).toBe(true);
      expect(services.get(id)?.path).toBe(labPath(id));
    }
  });

  it("serves vanilla x402 only, and every service is a test merchant", async () => {
    const { get } = buildLab();
    for (const id of LAB_SERVICE_IDS) {
      const service = get(id);
      expect(service.testMerchant).toBe(true);
      expect(service.serviceName).toBe(id);
      const offers = service.paymentRequired.accepts;
      expect(offers).toHaveLength(1);
      expect(offers[0]).toMatchObject({ scheme: "exact", amount: String(PRICE), payTo: PAY_TO });
    }
  });

  it("skips a service its own `enabled` key switches off", () => {
    const { services } = buildLab({
      config: configWith({ "merchants.lab.lab-search-flaky.enabled": false }),
    });
    expect(services.has("lab-search-flaky")).toBe(false);
    expect(services.size).toBe(5);
  });

  it("does not build the payee-swap service without a second payee", () => {
    const { services } = buildLab({ swapPayTo: undefined });
    expect(services.has("lab-spot-payee-swap")).toBe(false);
    expect(services.size).toBe(5);
  });
});

describe("T-106 acceptance 1: each profile hits its configured rate over 1,000 seeded calls (±5%)", () => {
  it("lab-search-steady always delivers, with the exact schema, and is never delayed", async () => {
    const { get, calls, sleeps } = buildLab();
    const service = get("lab-search-steady");
    let delivered = 0;
    for (let i = 0; i < CALLS; i += 1) {
      const response = await paidSearch(service, "lab-search-steady", "eip");
      if (response.status === 200) {
        const body = (await response.json()) as { results: unknown[] };
        expect(Object.keys(body)).toEqual(["results"]);
        expect(Array.isArray(body.results)).toBe(true);
        delivered += 1;
      }
    }
    expect(delivered).toBe(CALLS);
    expect(calls.filter((call) => call === "settle")).toHaveLength(CALLS);
    expect(sleeps).toEqual([]);
  });

  it("lab-search-steady answers from the fixture corpus, exactly as czar-search does", async () => {
    const { get } = buildLab();
    const response = await paidSearch(get("lab-search-steady"), "lab-search-steady", "eip 712");
    const body = (await response.json()) as { results: { title: string; url: string }[] };
    expect(body.results.length).toBeGreaterThan(0);
    for (const result of body.results)
      expect(SEARCH_INDEX.some((entry) => entry.url === result.url)).toBe(true);
  });

  it("lab-search-flaky fails failRate (0.3) of calls with a 5xx", async () => {
    const { get } = buildLab();
    const service = get("lab-search-flaky");
    let failed = 0;
    for (let i = 0; i < CALLS; i += 1) {
      const response = await paidSearch(service, "lab-search-flaky", `eip ${i}`);
      if (response.status >= 500) failed += 1;
      else expect(response.status).toBe(200);
    }
    expect(within(failed / CALLS, 0.3)).toBe(true);
    expect(tight(failed / CALLS, 0.3)).toBe(true);
  });

  it("lab-search-flaky follows a failRate set in config", async () => {
    const { get } = buildLab({
      config: configWith({ "merchants.lab.lab-search-flaky.failRate": 0.6 }),
    });
    const service = get("lab-search-flaky");
    let failed = 0;
    for (let i = 0; i < CALLS; i += 1)
      if ((await paidSearch(service, "lab-search-flaky", "eip")).status >= 500) failed += 1;
    expect(within(failed / CALLS, 0.6)).toBe(true);
    expect(tight(failed / CALLS, 0.6)).toBe(true);
  });

  it("lab-search-slow delivers correctly after delayMs (6,000) on every call", async () => {
    const { get, sleeps } = buildLab();
    const service = get("lab-search-slow");
    for (let i = 0; i < CALLS; i += 1) {
      const response = await paidSearch(service, "lab-search-slow", "eip");
      expect(response.status).toBe(200);
    }
    expect(sleeps).toHaveLength(CALLS);
    expect(new Set(sleeps)).toEqual(new Set([6_000]));
  });

  it("lab-search-slow keeps its delay inside the route's own timeouts", () => {
    const config = configWith();
    expect(6_000).toBeLessThan(Number(config.get("merchants.handlerTimeoutMs")));
    expect(6_000 / 1000).toBeLessThan(Number(config.get("merchants.maxTimeoutSeconds")));
  });

  it("lab-extract-schemabreak returns JSON missing `text` for schemaBreakRate (0.2) of calls", async () => {
    const { get } = buildLab();
    const service = get("lab-extract-schemabreak");
    let broken = 0;
    for (let i = 0; i < CALLS; i += 1) {
      const response = await paidExtract(service, "lab-extract-schemabreak", corpusUrl(i));
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      if (!("text" in body)) {
        broken += 1;
        expect(typeof body["title"]).toBe("string");
      } else {
        expect(Object.keys(body).toSorted()).toEqual(["links", "text", "title", "untrusted"]);
        expect(body["untrusted"]).toBe(true);
      }
    }
    expect(within(broken / CALLS, 0.2)).toBe(true);
    expect(tight(broken / CALLS, 0.2)).toBe(true);
  });

  it("lab-extract-drift quotes a price +driftBps (2,000) above its index entry for driftRate (0.33) of 402s", async () => {
    const { get } = buildLab();
    const service = get("lab-extract-drift");
    const indexed = service.paymentRequired.accepts[0]?.amount;
    expect(indexed).toBe(String(PRICE));
    const drifted = String((BigInt(PRICE) * (10_000n + 2_000n)) / 10_000n);
    let driftCount = 0;
    for (let i = 0; i < CALLS; i += 1) {
      const amount = await quotedAmount(service, extractRequest("lab-extract-drift", corpusUrl(i)));
      if (amount === drifted) driftCount += 1;
      else expect(amount).toBe(indexed);
    }
    expect(within(driftCount / CALLS, 0.33)).toBe(true);
    expect(tight(driftCount / CALLS, 0.33)).toBe(true);
  });

  it("lab-extract-drift serves a buyer who pays the drifted price it quoted", async () => {
    const { get, calls } = buildLab();
    const service = get("lab-extract-drift");
    const drifted = String((BigInt(PRICE) * 12_000n) / 10_000n);
    let served = 0;
    for (let i = 0; i < 60 && served < 3; i += 1) {
      const url = corpusUrl(i);
      const amount = await quotedAmount(service, extractRequest("lab-extract-drift", url));
      if (amount !== drifted) continue;
      const response = await service.handle(
        extractRequest("lab-extract-drift", url, {
          "payment-signature": paymentHeader({
            resourceUrl: `${ORIGIN}${labPath("lab-extract-drift")}`,
            amount: drifted,
            accepted: offerFor(drifted),
          }),
        }),
      );
      expect(response.status).toBe(200);
      served += 1;
    }
    expect(served).toBe(3);
    expect(calls.filter((call) => call === "settle")).toHaveLength(3);
  });

  it("lab-spot-payee-swap names a second Czar-owned payTo every payeeSwapEveryDays (7) days", async () => {
    let now = Date.UTC(2026, 10, 1);
    const { get } = buildLab({ now: () => now });
    const service = get("lab-spot-payee-swap");
    const indexedPayTo = service.paymentRequired.accepts[0]?.payTo;
    expect(indexedPayTo).toBe(PAY_TO);
    const live: string[] = [];
    for (let day = 0; day < 28; day += 1) {
      live.push(await quotedPayTo(service, new Request(spotUrl("lab-spot-payee-swap"))));
      now += DAY_MS;
    }
    expect(new Set(live)).toEqual(new Set([PAY_TO, SWAP_PAY_TO]));
    expect(live.filter((payTo) => payTo === SWAP_PAY_TO)).toHaveLength(14);
    // The payee only ever changes at a 7-day boundary: runs of 7 identical days, apart from the first
    // run, which starts wherever the seed's phase puts it.
    const runs: number[] = [];
    for (const [i, payTo] of live.entries()) {
      if (i === 0 || payTo !== live[i - 1]) runs.push(1);
      else runs[runs.length - 1] = (runs[runs.length - 1] ?? 0) + 1;
    }
    for (const run of runs.slice(1, -1)) expect(run).toBe(7);
  });

  it("lab-spot-payee-swap follows a payeeSwapEveryDays set in config", async () => {
    let now = Date.UTC(2026, 10, 1);
    const { get } = buildLab({
      config: configWith({ "merchants.lab.lab-spot-payee-swap.payeeSwapEveryDays": 2 }),
      now: () => now,
    });
    const service = get("lab-spot-payee-swap");
    const live: string[] = [];
    for (let day = 0; day < 16; day += 1) {
      live.push(await quotedPayTo(service, new Request(spotUrl("lab-spot-payee-swap"))));
      now += DAY_MS;
    }
    const runs: number[] = [];
    for (const [i, payTo] of live.entries()) {
      if (i === 0 || payTo !== live[i - 1]) runs.push(1);
      else runs[runs.length - 1] = (runs[runs.length - 1] ?? 0) + 1;
    }
    for (const run of runs.slice(1, -1)) expect(run).toBe(2);
  });

  it("lab-spot-payee-swap serves a buyer who pays the payee its live 402 names", async () => {
    // Find a day on which the second payee is live, then pay that payee.
    let now = Date.UTC(2026, 10, 1);
    const { get, calls } = buildLab({ now: () => now });
    const service = get("lab-spot-payee-swap");
    let live = "";
    for (let day = 0; day < 14 && live !== SWAP_PAY_TO; day += 1) {
      live = await quotedPayTo(service, new Request(spotUrl("lab-spot-payee-swap")));
      if (live !== SWAP_PAY_TO) now += DAY_MS;
    }
    expect(live).toBe(SWAP_PAY_TO);
    const swapped = await service.handle(
      new Request(spotUrl("lab-spot-payee-swap"), {
        headers: pay("lab-spot-payee-swap", BUYER, {
          ...offerFor(String(PRICE)),
          payTo: SWAP_PAY_TO,
        }),
      }),
    );
    expect(swapped.status).toBe(200);
    const body = (await swapped.json()) as Record<string, unknown>;
    expect(Object.keys(body).toSorted()).toEqual(["asOf", "pair", "price", "source"]);
    expect(calls.filter((call) => call === "settle")).toHaveLength(1);
  });

  it("the same seed gives the same outcomes and a different seed gives different ones", async () => {
    const first = await flakyStatuses(SEED);
    expect(await flakyStatuses(SEED)).toEqual(first);
    expect(await flakyStatuses(SEED + 1)).not.toEqual(first);
  });
});

describe("the seeded rate stream", () => {
  it("hits its rate to within one call per thousand, for any rate", () => {
    for (const rate of [0, 0.2, 0.3, 0.33, 0.6, 0.123, 1]) {
      const hits = countHits(labCoin(SEED, "lab-search-flaky", "fail", rate), CALLS);
      expect(Math.abs(hits - rate * CALLS), String(rate)).toBeLessThanOrEqual(1);
    }
  });

  it("is a function of the seed, the service, the stream and the position only", () => {
    const first = coinRun(SEED, "lab-search-flaky", "fail");
    expect(coinRun(SEED, "lab-search-flaky", "fail")).toEqual(first);
    expect(coinRun(SEED + 1, "lab-search-flaky", "fail")).not.toEqual(first);
    expect(coinRun(SEED, "lab-extract-drift", "fail")).not.toEqual(first);
    expect(coinRun(SEED, "lab-search-flaky", "other")).not.toEqual(first);
  });

  it("places hits at random, not in a fixed rhythm, so failures can arrive back to back", () => {
    const flip = labCoin(SEED, "lab-search-flaky", "fail", 0.3);
    const outcomes = Array.from({ length: CALLS }, () => flip());
    expect(outcomes.some((hit, i) => hit && outcomes[i + 1] === true)).toBe(true);
    expect(outcomes.some((hit, i) => !hit && outcomes[i + 1] === false)).toBe(true);
  });
});

describe("T-106 acceptance 2: the flaky profile never settles a failed call", () => {
  it("settles once per delivered call and never after a handler failure", async () => {
    const { get, calls } = buildLab();
    const service = get("lab-search-flaky");
    let delivered = 0;
    let failed = 0;
    for (let i = 0; i < CALLS; i += 1) {
      const before = calls.length;
      const response = await paidSearch(service, "lab-search-flaky", `eip ${i}`);
      const made = calls.slice(before);
      if (response.status === 200) {
        delivered += 1;
        expect(made).toEqual(["verify", "settle"]);
        expect(response.headers.get("payment-response")).not.toBeNull();
      } else {
        failed += 1;
        expect(response.status).toBe(500);
        expect(made).toEqual(["verify"]);
        expect(response.headers.get("payment-response")).toBeNull();
      }
    }
    expect(failed).toBeGreaterThan(0);
    expect(delivered).toBeGreaterThan(0);
    expect(calls.filter((call) => call === "settle")).toHaveLength(delivered);
  });

  it("releases the payment identifier, so the buyer's retry is a fresh request", async () => {
    const { get } = buildLab();
    const service = get("lab-search-flaky");
    const statuses: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      const response = await service.handle(
        new Request(searchUrl("lab-search-flaky", "eip"), {
          headers: {
            "payment-signature": paymentHeader({
              resourceUrl: `${ORIGIN}${labPath("lab-search-flaky")}`,
              amount: String(PRICE),
              id: "pay_retry_one_identifier_0001",
            }),
          },
        }),
      );
      statuses.push(response.status);
      if (response.status === 200) break;
    }
    // A 5xx never leaves the identifier stuck "in progress" (409) or replaying the failure.
    expect(statuses.every((status) => status === 500 || status === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(200);
  });
});

describe("T-106 acceptance 3: index entries validate and carry the test-merchant source and flag", () => {
  const ADDRESSES: Record<string, string> = {
    "K10:czar-search": "0x00000000000000000000000000000000000000A1",
    "K10:czar-spot": "0x00000000000000000000000000000000000000A2",
    "K10:czar-extract": "0x00000000000000000000000000000000000000A3",
    "K10:lab-search-steady": "0x00000000000000000000000000000000000000C1",
    "K10:lab-search-flaky": "0x00000000000000000000000000000000000000C2",
    "K10:lab-search-slow": "0x00000000000000000000000000000000000000C3",
    "K10:lab-extract-schemabreak": "0x00000000000000000000000000000000000000C4",
    "K10:lab-extract-drift": "0x00000000000000000000000000000000000000C5",
    "K10:lab-spot-payee-swap": "0x00000000000000000000000000000000000000C6",
    "K10:lab-spot-payee-swap-second": SWAP_PAY_TO,
  };

  function signer() {
    const keyAddress = vi.fn(async (_caller: string, keyRef: string) => {
      const address = ADDRESSES[keyRef];
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

  async function runLab(
    extra: Record<string, number | boolean | string> = {},
    lab: { seed?: number; payeeSwapKeyRef?: string } = {
      seed: SEED,
      payeeSwapKeyRef: "K10:lab-spot-payee-swap-second",
    },
  ) {
    const { keyAddress, signer: merchantSigner } = signer();
    const server = createServer();
    const runtime = await createAlphaMerchantServer({
      server,
      config: configWith(extra),
      signer: merchantSigner,
      store: testStore(),
      logger: createLogger({ service: "merchants", component: "CZ-20", sink: () => undefined }),
      port: 0,
      safeFetch: fakeSafeFetch({ pages: { "*": { body: COINBASE } } }).safeFetch,
      lab,
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected TCP address");
    return { runtime, keyAddress, origin: `http://127.0.0.1:${address.port}` };
  }

  it("emits one valid entry per lab route, labelled czar-test-merchant with testMerchant true", async () => {
    const { runtime } = await runLab();
    try {
      const entries = runtime.indexEntries({ lastUpdated: "2026-11-05T12:00:00Z" });
      expect(entries).toHaveLength(3 + LAB_SERVICE_IDS.length);
      const lab = entries.filter((entry) => String(entry["resource"]).includes("/lab/"));
      expect(lab.map((entry) => entry["serviceName"])).toEqual([...LAB_SERVICE_IDS]);
      for (const entry of lab) {
        expect(validateDiscoveryIndexEntry(entry)).toEqual([]);
        const czar = (entry["extensions"] as { czar: Record<string, unknown> }).czar;
        expect(czar["source"]).toBe("czar-test-merchant");
        expect(czar["testMerchant"]).toBe(true);
        expect(czar["rail"]).toBe("x402-exact");
        expect(czar["routing"]).toEqual({ vaultDirect: true, gateway: false, upto: false });
        expect((entry["metadata"] as Record<string, unknown>)["supportsCircleGateway"]).toBe(false);
        expect(String(entry["resource"])).toContain(`/lab/${String(entry["serviceName"])}/`);
      }
    } finally {
      await runtime.stop();
    }
  });

  it("leaves the three core entries exactly as they were", async () => {
    const { runtime } = await runLab();
    try {
      const entries = runtime.indexEntries({ lastUpdated: "2026-11-05T12:00:00Z" });
      const core = entries.filter((entry) => !String(entry["resource"]).includes("/lab/"));
      expect(core.map((entry) => entry["serviceName"])).toEqual([
        "czar-search",
        "czar-spot",
        "czar-extract",
      ]);
      for (const entry of core) {
        expect(validateDiscoveryIndexEntry(entry)).toEqual([]);
        const czar = (entry["extensions"] as { czar: Record<string, unknown> }).czar;
        expect(czar["source"]).toBe("czar-registered");
        expect("testMerchant" in czar).toBe(false);
      }
    } finally {
      await runtime.stop();
    }
  });

  it("the payee-swap entry lists the primary payTo, not the second one", async () => {
    const { runtime } = await runLab();
    try {
      const entries = runtime.indexEntries({ lastUpdated: "2026-11-05T12:00:00Z" });
      const swap = entries.find((entry) => entry["serviceName"] === "lab-spot-payee-swap");
      const accepts = (swap as { accepts: { payTo: string }[] }).accepts;
      expect(accepts.map((offer) => offer.payTo)).toEqual([ADDRESSES["K10:lab-spot-payee-swap"]]);
      expect(JSON.stringify(entries)).not.toContain(SWAP_PAY_TO);
    } finally {
      await runtime.stop();
    }
  });

  it("every lab service gets its own payTo from the signer", async () => {
    const { runtime, keyAddress } = await runLab();
    try {
      const refs = keyAddress.mock.calls.map((call) => call[1]);
      for (const id of LAB_SERVICE_IDS) expect(refs).toContain(`K10:${id}`);
      expect(runtime.routes.filter((route) => route.startsWith("/lab/"))).toEqual(
        LAB_SERVICE_IDS.map(labPath),
      );
    } finally {
      await runtime.stop();
    }
  });

  it("rejects an index entry that claims the test-merchant source without the flag", () => {
    const base = {
      resource: "https://merchants.testnet.czar.dev/lab/x/v1/search",
      type: "http",
      x402Version: 2,
      lastUpdated: "2026-11-05T12:00:00Z",
      accepts: [offerFor("1")],
      description: "d",
      mimeType: "application/json",
      serviceName: "x",
      tags: [],
      metadata: {
        path: "/lab/x/v1/search",
        method: "GET",
        siwx: false,
        supportsVanillax402: true,
        supportsCircleGateway: false,
      },
    };
    const entry = (czar: Record<string, unknown>) => ({
      ...base,
      extensions: {
        czar: {
          rail: "x402-exact",
          routing: { vaultDirect: true, gateway: false, upto: false },
          ...czar,
        },
      },
    });
    expect(
      validateDiscoveryIndexEntry(entry({ source: "czar-test-merchant", testMerchant: true })),
    ).toEqual([]);
    expect(validateDiscoveryIndexEntry(entry({ source: "czar-test-merchant" }))).not.toEqual([]);
    expect(
      validateDiscoveryIndexEntry(entry({ source: "czar-registered", testMerchant: true })),
    ).not.toEqual([]);
  });
});

describe("T-106 acceptance 4: disabled -> 404; mainnet -> forced off", () => {
  it("serves a 402 on every lab route when the lab is on (the control for the 404 tests)", async () => {
    const { runtime, origin } = await start({});
    try {
      const statuses = (await Promise.all(labRequests(origin))).map((response) => response.status);
      expect(statuses).toEqual([402, 402, 402, 402, 402, 402]);
    } finally {
      await runtime.stop();
    }
  });

  it("returns 404 on every lab route when merchants.lab.enabled is false, and asks for no lab key", async () => {
    const { runtime, refs, origin } = await start({ "merchants.lab.enabled": false });
    try {
      const statuses = (await Promise.all(labRequests(origin))).map((response) => response.status);
      expect(statuses).toEqual([404, 404, 404, 404, 404, 404]);
      expect(runtime.routes.some((route) => route.startsWith("/lab/"))).toBe(false);
      expect(refs.some((ref) => ref.includes("lab-"))).toBe(false);
      expect(runtime.indexEntries()).toHaveLength(3);
      // The core services are untouched.
      expect((await fetch(`${origin}/v1/search?q=eip`)).status).toBe(402);
    } finally {
      await runtime.stop();
    }
  });

  it("forces the lab off on a mainnet payment network even though enabled is true", async () => {
    for (const network of ["eip155:1", "eip155:8453", "eip155:137", "eip155:999999"]) {
      const { runtime, refs, origin } = await start({
        "merchants.lab.enabled": true,
        "selection.paymentNetwork": network,
      });
      try {
        const statuses = (await Promise.all(labRequests(origin))).map(
          (response) => response.status,
        );
        expect(statuses, network).toEqual([404, 404, 404, 404, 404, 404]);
        expect(runtime.routes.some((route) => route.startsWith("/lab/"))).toBe(false);
        expect(refs.some((ref) => ref.includes("lab-"))).toBe(false);
      } finally {
        await runtime.stop();
      }
    }
  });

  it("treats a payment network it cannot read as mainnet (fail closed)", async () => {
    const { runtime, origin } = await start({
      "merchants.lab.enabled": true,
      "selection.paymentNetwork": "not-a-chain",
    });
    try {
      expect((await fetch(`${origin}${labPath("lab-search-steady")}?q=eip`)).status).toBe(404);
    } finally {
      await runtime.stop();
    }
  });

  it("runs on the Arc testnet and on a local anvil chain", async () => {
    for (const network of ["eip155:5042002", "eip155:31337"]) {
      const { runtime, origin } = await start({ "selection.paymentNetwork": network });
      try {
        expect(
          (await fetch(`${origin}${labPath("lab-search-steady")}?q=eip`)).status,
          network,
        ).toBe(402);
      } finally {
        await runtime.stop();
      }
    }
  });

  it("does not start at all unless the caller asks for the lab (the default is today's behaviour)", async () => {
    const { runtime, refs, origin } = await start({}, null);
    try {
      expect(runtime.routes).toEqual(["/v1/search", "/v1/spot", "/v1/extract"]);
      expect(refs).toEqual(["K10:czar-search", "K10:czar-spot", "K10:czar-extract"]);
      expect((await fetch(`${origin}${labPath("lab-search-steady")}?q=eip`)).status).toBe(404);
    } finally {
      await runtime.stop();
    }
  });

  it("refuses to start an asked-for lab that has no price", async () => {
    await expect(
      createAlphaMerchantServer({
        server: createServer(),
        config: loadConfig({ envFile: { "merchants.publicOrigin": ORIGIN } }),
        signer: {
          async keyAddress() {
            return addr(1);
          },
          async sign() {
            return {
              signature: `0x${"11".repeat(65)}` as const,
              digest: `0x${"22".repeat(32)}` as const,
            };
          },
        },
        store: testStore(),
        logger: createLogger({ service: "merchants", component: "CZ-20", sink: () => undefined }),
        port: 0,
        safeFetch: fakeSafeFetch({ pages: {} }).safeFetch,
        lab: { seed: SEED },
      }),
    ).rejects.toThrow(/merchants\.lab\.priceAtomic/);
  });

  it("refuses to start an asked-for lab that has no seed", async () => {
    await expect(start({}, {})).rejects.toThrow("merchant_lab_seed_missing");
  });
});

describe("T-106 acceptance 5: lab services never vary behaviour by buyer", () => {
  it("two buyer vaults get identical outcomes for the same request sequence", async () => {
    const first = await runBuyerSequence(BUYER);
    const second = await runBuyerSequence(SECOND_BUYER);
    expect(second.out).toEqual(first.out);
    expect(second.calls).toEqual(first.calls);
    expect(first.out.filter((outcome) => outcome === "f500").length).toBeGreaterThan(0);
    expect(first.out.filter((outcome) => outcome === "efalse").length).toBeGreaterThan(0);
  });

  it("alternating buyers on one lab gives the outcomes a single buyer gets", async () => {
    const single = await runBuyerSequence(BUYER);
    const { get } = buildLab();
    const flaky = get("lab-search-flaky");
    const broken = get("lab-extract-schemabreak");
    const mixed: string[] = [];
    for (let i = 0; i < 300; i += 1) {
      const buyer = i % 2 === 0 ? BUYER : SECOND_BUYER;
      mixed.push(`f${(await paidSearch(flaky, "lab-search-flaky", `eip ${i}`, buyer)).status}`);
      const response = await paidExtract(broken, "lab-extract-schemabreak", corpusUrl(i), buyer);
      mixed.push(`e${"text" in ((await response.json()) as object)}`);
    }
    expect(mixed).toEqual(single.out);
  });

  it("the live 402 is the same for two buyers", async () => {
    const { get } = buildLab();
    const drift = get("lab-extract-drift");
    const other = buildLab().get("lab-extract-drift");
    expect(await driftQuotes(other, SECOND_BUYER)).toEqual(await driftQuotes(drift, BUYER));
  });

  it("no lab source file reads the payer or any buyer header", () => {
    const dir = new URL("../src/lab/", import.meta.url);
    const files = ["index.ts", "profiles.ts", "route.ts", "services.ts"];
    for (const file of files) {
      const source = readFileSync(new URL(file, dir), "utf8");
      expect(source, file).not.toMatch(
        /\bpayer\b|authorization|\bfrom\b\s*:|x-buyer|headers\.get/i,
      );
    }
  });
});

describe("the local merchant process still starts only czar-search", () => {
  it("local-main.ts neither imports the alpha composition nor the lab", () => {
    const source = readFileSync(new URL("../src/local-main.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/alpha-services|createAlphaMerchantServer|\/lab\/|lab\/index/);
    expect(source).toMatch(/createMerchantServer\(\{\s*config,\s*signer,\s*store,\s*logger,/);
    expect(source).not.toMatch(/services\s*:/);
  });
});

describe("the bundled corpus", () => {
  it("holds about 20 short pre-1929 public-domain texts, each with a recorded basis", () => {
    expect(LAB_CORPUS).toHaveLength(20);
    expect(new Set(LAB_CORPUS.map((page) => page.id)).size).toBe(20);
    expect(new Set(LAB_CORPUS.map((page) => page.url)).size).toBe(20);
    for (const page of LAB_CORPUS) {
      expect(page.url, page.id).toMatch(/^https:\/\//);
      expect(page.title.length, page.id).toBeGreaterThan(0);
      expect(page.author.length, page.id).toBeGreaterThan(0);
      expect(page.basis.length, page.id).toBeGreaterThan(20);
      // Published before 1929: public domain in the United States on a date basis alone.
      expect(page.year, page.id).toBeLessThan(1929);
      expect(page.text.length, page.id).toBeGreaterThan(80);
      // Short excerpts, not whole books.
      expect(page.text.length, page.id).toBeLessThanOrEqual(1_500);
    }
  });

  it("SOURCES.md records the title, author, year and public-domain basis of every text", () => {
    const sources = readFileSync(new URL("../src/lab/corpus/SOURCES.md", import.meta.url), "utf8");
    for (const page of LAB_CORPUS) {
      const row = sources.split("\n").find((line) => line.includes(`\`${page.id}\``));
      expect(row, `${page.id} has no row in SOURCES.md`).toBeDefined();
      expect(row, page.id).toContain(page.title);
      expect(row, page.id).toContain(page.author);
      expect(row, page.id).toContain(String(page.year));
      expect(row, page.id).toContain(page.url);
    }
  });

  it("lab extract serves the bundled text for a corpus url and refuses any other url, unpaid", async () => {
    const { get, calls } = buildLab();
    const service = get("lab-extract-schemabreak");
    const refused = await service.handle(
      extractRequest("lab-extract-schemabreak", "https://example.com/p"),
    );
    expect(refused.status).toBe(400);
    expect(calls).toEqual([]);
    const page = LAB_CORPUS[0] as (typeof LAB_CORPUS)[number];
    for (let i = 0; i < 10; i += 1) {
      const response = await paidExtract(service, "lab-extract-schemabreak", page.url);
      const body = (await response.json()) as Record<string, unknown>;
      if ("text" in body) {
        expect(body).toEqual({ title: page.title, text: page.text, links: [], untrusted: true });
        return;
      }
    }
    throw new Error("no intact response in ten calls");
  });

  it("makes no network request: lab search and extract read bundled data", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const { get } = buildLab();
      await paidSearch(get("lab-search-steady"), "lab-search-steady", "eip");
      await paidExtract(get("lab-extract-drift"), "lab-extract-drift", corpusUrl(3));
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("treats corpus text as data: it carries the untrusted label and is never acted on", async () => {
    const { get } = buildLab({ seed: SEED });
    const response = await paidExtract(get("lab-extract-drift"), "lab-extract-drift", corpusUrl(0));
    // lab-extract-drift keeps the schema intact on every call.
    const body = (await response.json()) as { untrusted: boolean };
    expect(body.untrusted).toBe(true);
  });
});
