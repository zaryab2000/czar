import { loadConfig } from "@czar/config";
import { H, jcsString } from "@czar/hashing";
import { encodeBase64Json, type SafeFetch } from "@czar/x402";
import { validateSchema } from "@czar/schemas";
import { keccak256, toBytes } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAcceptancePorts } from "#src/acceptance/ports";
import type { RankingQuery } from "#src/planner/ports";
import { createRegisteredSelection } from "#src/selection/registered/index";
import { setupDatabase } from "#test/db";

const getPool = setupDatabase();
const SERVICE_A = `svc_${"a".repeat(32)}`;
const SERVICE_B = `svc_${"b".repeat(32)}`;
const NETWORK = "eip155:5042002";
const USDC_ASSET = "0x3600000000000000000000000000000000000000";
const RESOURCE = "https://merchant.example/v1/search";

interface SnapshotForReconstruction {
  readonly network: string;
  readonly policy_version: string;
  readonly descriptor: {
    readonly usdcAsset: string;
    readonly unverifiedWithApproval: boolean;
  };
  readonly services: Array<{
    serviceId: string;
    capabilities: string[];
    probe: { state: "failed" } | { state: "ok"; offers: Array<Record<string, unknown>> };
  }>;
}

function reconstructEligibility(
  snapshot: SnapshotForReconstruction,
  capability: string,
  maxPrice: bigint,
) {
  const candidates = snapshot.services.filter((service) =>
    service.capabilities.includes(capability),
  );
  const excluded: Array<{ service_id: string; gate: string; detail: string }> = [];
  const eligible: Array<{ service_id: string; amount: bigint }> = [];
  for (const service of candidates) {
    if (service.probe.state === "failed") {
      excluded.push({
        service_id: service.serviceId,
        gate: "probe-failed",
        detail: "live-402-unavailable-or-malformed",
      });
      continue;
    }
    const offers = service.probe.offers.filter(
      (reducedOffer) => reducedOffer["network"] === snapshot.network,
    );
    if (offers.length === 0) {
      excluded.push({ service_id: service.serviceId, gate: "network", detail: "wrong-network" });
      continue;
    }
    const payable = offers.filter(
      (reducedOffer) =>
        reducedOffer["scheme"] === "exact" &&
        reducedOffer["asset"] === snapshot.descriptor.usdcAsset &&
        reducedOffer["siwx"] === false &&
        reducedOffer["siwxOnly"] === false &&
        reducedOffer["batchSettlement"] === false,
    );
    if (payable.length === 0) {
      excluded.push({
        service_id: service.serviceId,
        gate: "offer",
        detail: "no-payable-live-offer",
      });
      continue;
    }
    const affordable = payable
      .map((reducedOffer) => BigInt(String(reducedOffer["amount"])))
      .filter((amount) => amount <= maxPrice);
    if (affordable.length === 0) {
      excluded.push({
        service_id: service.serviceId,
        gate: "price-over-budget",
        detail: "live-price-exceeds-max",
      });
      continue;
    }
    eligible.push({
      service_id: service.serviceId,
      amount: affordable.reduce((minimum, amount) => (amount < minimum ? amount : minimum)),
    });
  }
  eligible.sort((left, right) =>
    left.amount < right.amount
      ? -1
      : left.amount > right.amount
        ? 1
        : left.service_id.localeCompare(right.service_id),
  );
  const exploration =
    snapshot.descriptor.unverifiedWithApproval && eligible[0]
      ? { service_id: eligible[0].service_id, reason: "no-ranked-candidate" }
      : undefined;
  return { candidates, excluded, eligible, exploration };
}

function offer(
  amount: string,
  payTo: string,
  network = NETWORK,
  overrides: Record<string, unknown> = {},
) {
  return {
    scheme: "exact",
    network,
    amount,
    asset: "0x3600000000000000000000000000000000000000",
    payTo: `0x${payTo.replace(/^0x/, "").padStart(40, "0")}`,
    maxTimeoutSeconds: 300,
    extra: {},
    ...overrides,
  };
}

function response(
  amount: string,
  payTo: string,
  network = NETWORK,
  outputExample: Record<string, unknown> = {
    type: "object",
    properties: { answer: { type: "string" } },
  },
  resourceUrl = RESOURCE,
  offerOverrides: Record<string, unknown> = {},
  extraOffers: ReturnType<typeof offer>[] = [],
) {
  const body = {
    x402Version: 2,
    resource: { url: resourceUrl, description: "private merchant description" },
    accepts: [offer(amount, payTo, network, offerOverrides), ...extraOffers],
    extensions: {
      bazaar: {
        info: { input: {}, output: {} },
        schema: {
          type: "object",
          properties: {
            input: { type: "object" },
            output: { type: "object", properties: { example: outputExample } },
          },
        },
      },
    },
  };
  return {
    status: 402,
    url: resourceUrl,
    headers: { "payment-required": encodeBase64Json(body) },
    body: Buffer.from(""),
  };
}

function declaredInputResponse(
  location: "queryParams" | "body",
  properties: Record<string, unknown>,
  example: Record<string, unknown>,
) {
  const method = location === "queryParams" ? "GET" : "POST";
  const input =
    location === "queryParams"
      ? { type: "http", method, queryParams: example }
      : { type: "http", method, bodyType: "json", body: example };
  const body = {
    x402Version: 2,
    resource: { url: RESOURCE },
    accepts: [offer("25", "0xaaa")],
    extensions: {
      bazaar: {
        info: { input },
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            input: {
              type: "object",
              properties: {
                type: { type: "string", const: "http" },
                method: { type: "string" },
                ...(location === "body" ? { bodyType: { type: "string" } } : {}),
                [location]: { type: "object", properties },
              },
              required: ["type", "method"],
            },
          },
          required: ["input"],
        },
      },
    },
  };
  return {
    status: 402,
    url: RESOURCE,
    headers: { "payment-required": encodeBase64Json(body) },
    body: Buffer.from(""),
  };
}

function bareUrl(input: string): string {
  const url = new URL(input);
  url.search = "";
  return url.toString();
}

function query(maxPrice = "100"): RankingQuery {
  return {
    taskClass: "data-json",
    capability: "web-search",
    taskSpec: {
      kind: "table-fill",
      topic: "search",
      fields: [],
      output: { format: "json", formatSource: "default" },
    },
    networks: [NETWORK],
    rails: ["x402-exact", "gateway-batched", "erc8183-job"],
    max_price_atomic: maxPrice,
    unknown_policy: "exclude",
  };
}

function registration(url = RESOURCE, method: "GET" | "POST" = "GET", name = "merchant") {
  return {
    serviceName: name,
    resource: { url, method },
    probeInput:
      method === "GET" ? { query: { q: "czar probe" } } : { body: { query: "czar probe" } },
    capabilities: ["web-search"],
  };
}

function setup(
  fetchImpl: SafeFetch,
  services: Record<string, ReturnType<typeof registration>>,
  now: () => Date,
  configOverrides: Record<string, unknown> = {},
) {
  const config = loadConfig({
    envFile: { "selection.czarRegisteredServices": services, ...configOverrides },
  });
  return createRegisteredSelection({ config, safeFetch: fetchImpl, pool: getPool(), now });
}

beforeEach(async () => {
  await getPool().query("DELETE FROM selection_interim_snapshots");
});

describe("registered selection", () => {
  it("returns an unanchored schema-valid decision and persists exact JCS bytes", async () => {
    const fetchImpl = vi.fn<SafeFetch>(async (url) =>
      response("25", "0xaaa", NETWORK, undefined, bareUrl(url)),
    );
    const selection = setup(
      fetchImpl,
      {
        [SERVICE_B]: registration("https://b.example/v1/search", "GET", "b"),
        [SERVICE_A]: registration("https://a.example/v1/search", "GET", "a"),
      },
      () => new Date("2026-10-25T00:00:00Z"),
    );

    const decision = await selection.rank.rank(query());
    const saved = await getPool().query<{ body_jcs: string }>(
      "SELECT body_jcs FROM selection_interim_snapshots WHERE snapshot_id = $1",
      [decision.snapshot_id],
    );
    const body = JSON.parse(saved.rows[0]!.body_jcs) as Record<string, unknown>;

    expect(validateSchema("ranking-decision", decision)).toBe(true);
    expect(decision.schemaVersion).toBe("1.1");
    expect(decision.policy_version).toBe(
      `pol_${H({
        policy: "czar-registered-interim",
        scr: "SCR-138",
        network: NETWORK,
        usdcAsset: USDC_ASSET,
        offerRule: "scheme-exact,asset-usdc,no-siwx,no-siwx-only,no-batch-settlement",
        unverifiedWithApproval: true,
        exploration: "lowest-eligible-live-price-then-serviceId",
        ranked: "none",
      }).slice(2, 18)}`,
    );
    expect(decision.snapshot_anchor_tx).toBeNull();
    expect(body["descriptor"]).toMatchObject({
      network: NETWORK,
      usdcAsset: USDC_ASSET,
      unverifiedWithApproval: true,
    });
    expect(`pol_${H(body["descriptor"]).slice(2, 18)}`).toBe(decision.policy_version);
    expect(decision.ranked).toEqual([]);
    expect(decision.unverified.map((row) => row.service_id)).toEqual([SERVICE_A, SERVICE_B]);
    expect(decision.exploration_slot?.service_id).toBe(SERVICE_A);
    expect(keccak256(toBytes(saved.rows[0]!.body_jcs))).toBe(decision.snapshot_id);
    expect(saved.rows[0]!.body_jcs).toBe(jcsString(body));
    expect(saved.rows[0]!.body_jcs).not.toContain("private merchant description");
    expect((body["services"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      serviceId: SERVICE_A,
      serviceName: "a",
      resourceUrl: "https://a.example/v1/search",
      capabilities: ["web-search"],
      probe: {
        state: "ok",
        probedAt: "2026-10-25T00:00:00.000Z",
        offers: [
          {
            network: NETWORK,
            scheme: "exact",
            asset: USDC_ASSET,
            amount: "25",
            payTo: `0x${"aaa".padStart(40, "0")}`,
            siwx: false,
            siwxOnly: false,
            batchSettlement: false,
          },
        ],
      },
    });
  });

  it("reconstructs gate order and exploration from the stored snapshot and decision query", async () => {
    const ids = Array.from({ length: 7 }, (_, index) => `svc_${String(index + 1).repeat(32)}`);
    const failed = ids[0]!;
    const siwxOnlyService = ids[3]!;
    const mixed = ids[6]!;
    const fetchImpl = vi.fn<SafeFetch>(async (url) => {
      if (url.includes("failed")) throw new Error("probe unavailable");
      if (url.includes("wrong-network"))
        return response("5", "0x1", "eip155:1", undefined, bareUrl(url));
      if (url.includes("siwx-only"))
        return response("5", "0x3", NETWORK, undefined, bareUrl(url), {
          extra: { siwxOnly: true },
        });
      if (url.includes("siwx"))
        return response("5", "0x2", NETWORK, undefined, bareUrl(url), { extra: { siwx: true } });
      if (url.includes("batch"))
        return response("5", "0x4", NETWORK, undefined, bareUrl(url), {
          extra: { paymentFlow: "batch-settlement" },
        });
      if (url.includes("over-budget"))
        return response("101", "0x5", NETWORK, undefined, bareUrl(url));
      return response("50", "0x6", NETWORK, undefined, bareUrl(url), {}, [
        offer("25", "0x7"),
        offer("5", "0x8", "unrecognized"),
      ]);
    });
    const services = Object.fromEntries(
      ids.map((id, index) => [
        id,
        registration(
          `https://${["failed", "wrong-network", "siwx", "siwx-only", "batch", "over-budget", "mixed"][index]}.example/v1/search`,
        ),
      ]),
    );
    const decision = await setup(
      fetchImpl,
      services,
      () => new Date("2026-10-25T00:00:00Z"),
    ).rank.rank(query("100"));
    const saved = await getPool().query<{ body_jcs: string }>(
      "SELECT body_jcs FROM selection_interim_snapshots WHERE snapshot_id = $1",
      [decision.snapshot_id],
    );
    const snapshot = JSON.parse(saved.rows[0]!.body_jcs) as SnapshotForReconstruction;
    const maxPrice = BigInt(String(decision.query.constraints["max_price_atomic"]));
    const reconstructed = reconstructEligibility(snapshot, decision.query.task, maxPrice);

    expect(snapshot.services).toHaveLength(ids.length);
    expect(`pol_${H(snapshot.descriptor).slice(2, 18)}`).toBe(snapshot.policy_version);
    expect(snapshot.policy_version).toBe(decision.policy_version);
    expect(keccak256(toBytes(saved.rows[0]!.body_jcs))).toBe(decision.snapshot_id);
    expect(snapshot.services[0]).toMatchObject({
      serviceId: failed,
      probe: { state: "failed", probedAt: "2026-10-25T00:00:00.000Z" },
    });
    const mixedSnapshot = snapshot.services.find((service) => service.serviceId === mixed);
    expect(mixedSnapshot?.probe).toMatchObject({
      state: "ok",
      offers: [
        { network: null, scheme: "exact", asset: USDC_ASSET, amount: "5" },
        { network: NETWORK, scheme: "exact", asset: USDC_ASSET, amount: "25" },
        { network: NETWORK, scheme: "exact", asset: USDC_ASSET, amount: "50" },
      ],
    });
    const siwxOnlySnapshot = snapshot.services.find(
      (service) => service.serviceId === siwxOnlyService,
    );
    expect(siwxOnlySnapshot?.probe).toMatchObject({
      state: "ok",
      offers: [
        {
          network: NETWORK,
          scheme: "exact",
          asset: USDC_ASSET,
          siwx: false,
          siwxOnly: true,
          batchSettlement: false,
        },
      ],
    });
    expect(reconstructed.excluded).toContainEqual({
      service_id: siwxOnlyService,
      gate: "offer",
      detail: "no-payable-live-offer",
    });
    expect(reconstructed.excluded).toEqual(decision.excluded);
    const reconstructedUnverified = reconstructed.eligible.map(({ service_id }) => ({
      service_id,
      reason: "n_eff_below_min",
      n_eff: 0,
    }));
    expect(reconstructedUnverified).toEqual(decision.unverified);
    expect(reconstructed.eligible[0]?.service_id).toBe(mixed);
    expect(reconstructed.exploration).toEqual(decision.exploration_slot);
    expect(reconstructed.candidates).toHaveLength(decision.candidates_considered);
  });

  it("replays exploration-disabled policy from the stored descriptor", async () => {
    const fetchImpl = vi.fn<SafeFetch>(async () => response("25", "0xaaa"));
    const selection = setup(
      fetchImpl,
      { [SERVICE_A]: registration() },
      () => new Date("2026-10-25T00:00:00Z"),
      { "selection.unverifiedWithApproval": false },
    );
    const decision = await selection.rank.rank(query());
    const saved = await getPool().query<{ body_jcs: string }>(
      "SELECT body_jcs FROM selection_interim_snapshots WHERE snapshot_id = $1",
      [decision.snapshot_id],
    );
    const snapshot = JSON.parse(saved.rows[0]!.body_jcs) as SnapshotForReconstruction;
    const reconstructed = reconstructEligibility(
      snapshot,
      decision.query.task,
      BigInt(String(decision.query.constraints["max_price_atomic"])),
    );

    expect(snapshot.descriptor).toMatchObject({
      usdcAsset: USDC_ASSET,
      unverifiedWithApproval: false,
    });
    expect(`pol_${H(snapshot.descriptor).slice(2, 18)}`).toBe(snapshot.policy_version);
    expect(reconstructed.eligible.map(({ service_id }) => service_id)).toEqual([SERVICE_A]);
    expect(reconstructed.exploration).toBeUndefined();
    expect(decision.exploration_slot).toBeUndefined();
  });

  it("adds GET probe input only to the unpaid request and preserves the bare resource", async () => {
    const fetchImpl = vi.fn<SafeFetch>(async () => response("25", "0xaaa"));
    const selection = setup(fetchImpl, { [SERVICE_A]: registration() }, () => new Date());

    const service = await selection.directory.get(SERVICE_A);
    const [url, options] = fetchImpl.mock.calls[0]!;

    expect(new URL(url).searchParams.get("q")).toBe("czar probe");
    expect(options).toMatchObject({ method: "GET", headers: {} });
    expect(service?.resource).toEqual({ url: RESOURCE, method: "GET" });
    expect(service?.probeInput).toEqual({ query: { q: "czar probe" } });
  });

  it("sends fixed POST probe input as JSON without payment headers", async () => {
    const fetchImpl = vi.fn<SafeFetch>(async () => response("25", "0xaaa"));
    const serviceRegistration = registration(RESOURCE, "POST");
    const selection = setup(fetchImpl, { [SERVICE_A]: serviceRegistration }, () => new Date());
    await selection.directory.get(SERVICE_A);
    const options = fetchImpl.mock.calls[0]![1]!;

    expect(options).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(Buffer.from(options.body!).toString("utf8")).toBe('{"query":"czar probe"}');
    expect(options.headers).not.toHaveProperty("payment-signature");
  });

  it("excludes wrong-network and over-cap services, and uses the current offer", async () => {
    const fetchImpl = vi.fn<SafeFetch>(async (url) =>
      url.includes("network")
        ? response("1", "0xaaa", "eip155:1", undefined, bareUrl(url))
        : response("101", "0xbbb", NETWORK, undefined, bareUrl(url)),
    );
    const selection = setup(
      fetchImpl,
      {
        [SERVICE_A]: registration("https://network.example/v1/search"),
        [SERVICE_B]: registration("https://price.example/v1/search"),
      },
      () => new Date(),
    );

    const decision = await selection.rank.rank(query("100"));

    expect(decision.unverified).toEqual([]);
    expect(decision.excluded).toEqual([
      { service_id: SERVICE_A, gate: "network", detail: "wrong-network" },
      { service_id: SERVICE_B, gate: "price-over-budget", detail: "live-price-exceeds-max" },
    ]);
  });

  it("reads only a declared sanitized output example schema", async () => {
    const fetchImpl = vi.fn<SafeFetch>(async () => response("25", "0xcccc"));
    const selection = setup(fetchImpl, { [SERVICE_A]: registration() }, () => new Date());

    expect(await selection.outputSchema.forService(SERVICE_A)).toEqual({
      type: "object",
      properties: { answer: { type: "string" } },
    });
    expect(JSON.stringify(await selection.directory.get(SERVICE_A))).not.toContain(
      "private merchant description",
    );
  });

  it("returns null for absent or forced-only response schemas", async () => {
    const fetchImpl = vi.fn<SafeFetch>(async () =>
      response("25", "0xaaa", NETWORK, { type: "object" }),
    );
    const selection = setup(fetchImpl, { [SERVICE_A]: registration() }, () => new Date());
    expect(await selection.outputSchema.forService(SERVICE_A)).toBeNull();
  });

  it("returns null when the Bazaar extension is absent", async () => {
    const fetchImpl = vi.fn<SafeFetch>(async () => ({
      status: 402,
      url: RESOURCE,
      headers: {
        "payment-required": encodeBase64Json({
          x402Version: 2,
          resource: { url: RESOURCE },
          accepts: [offer("25", "0xaaa")],
        }),
      },
      body: Buffer.from(""),
    }));
    const selection = setup(fetchImpl, { [SERVICE_A]: registration() }, () => new Date());
    expect(await selection.outputSchema.forService(SERVICE_A)).toBeNull();
  });

  it("carries a declared GET query string input into the card inputFields", async () => {
    const fetchImpl = vi.fn<SafeFetch>(async () =>
      declaredInputResponse(
        "queryParams",
        { q: { type: "string", description: "seller-written text", maxLength: 200 } },
        { q: "czar probe" },
      ),
    );
    const selection = setup(fetchImpl, { [SERVICE_A]: registration() }, () => new Date());
    const service = await selection.directory.get(SERVICE_A);

    expect(service?.extensions.czar.card["inputFields"]).toEqual([{ name: "q", type: "string" }]);
    expect(JSON.stringify(service?.extensions.czar.card)).not.toContain("seller-written text");
  });

  it("carries declared POST JSON body fields into the card inputFields", async () => {
    const fetchImpl = vi.fn<SafeFetch>(async () =>
      declaredInputResponse(
        "body",
        { query: { type: "string" }, limit: { type: "integer" } },
        { query: "czar probe", limit: 5 },
      ),
    );
    const selection = setup(
      fetchImpl,
      { [SERVICE_A]: registration(RESOURCE, "POST") },
      () => new Date(),
    );
    const service = await selection.directory.get(SERVICE_A);

    expect(service?.extensions.czar.card["inputFields"]).toEqual([
      { name: "query", type: "string" },
      { name: "limit", type: "integer" },
    ]);
  });

  it("keeps empty inputFields when no Bazaar input is declared", async () => {
    const fetchImpl = vi.fn<SafeFetch>(async () => ({
      status: 402,
      url: RESOURCE,
      headers: {
        "payment-required": encodeBase64Json({
          x402Version: 2,
          resource: { url: RESOURCE },
          accepts: [offer("25", "0xaaa")],
        }),
      },
      body: Buffer.from(""),
    }));
    const selection = setup(fetchImpl, { [SERVICE_A]: registration() }, () => new Date());
    const service = await selection.directory.get(SERVICE_A);

    expect(service?.extensions.czar.card).toMatchObject({ inputFields: [], outputFields: [] });
  });

  it("bounds card fields to 50 entries, 64-character names and JSON types", async () => {
    const properties: Record<string, unknown> = {
      [`n${"x".repeat(64)}`]: { type: "string" },
      untyped: { description: "no type" },
      union: { type: ["string", "null"] },
    };
    for (let index = 0; index < 60; index += 1) properties[`f${index}`] = { type: "number" };
    const fetchImpl = vi.fn<SafeFetch>(async () =>
      declaredInputResponse("queryParams", properties, {}),
    );
    const selection = setup(fetchImpl, { [SERVICE_A]: registration() }, () => new Date());
    const fields = (await selection.directory.get(SERVICE_A))?.extensions.czar.card[
      "inputFields"
    ] as Array<{ name: string; type: string }>;

    expect(fields).toHaveLength(50);
    expect(fields[0]).toEqual({ name: "f0", type: "number" });
    expect(fields.at(-1)).toEqual({ name: "f49", type: "number" });
  });

  it("carries declared output example properties into the card outputFields", async () => {
    const fetchImpl = vi.fn<SafeFetch>(async () =>
      response("25", "0xaaa", NETWORK, {
        type: "object",
        properties: {
          answer: { type: "string", description: "seller-written text" },
          count: { type: "integer" },
        },
      }),
    );
    const selection = setup(fetchImpl, { [SERVICE_A]: registration() }, () => new Date());
    const card = (await selection.directory.get(SERVICE_A))?.extensions.czar.card;

    expect(card?.["outputFields"]).toEqual([
      { name: "answer", type: "string" },
      { name: "count", type: "integer" },
    ]);
    expect(JSON.stringify(card)).not.toContain("seller-written text");
  });

  it("keeps a meaningful type-only response schema", async () => {
    const fetchImpl = vi.fn<SafeFetch>(async () =>
      response("25", "0xaaa", NETWORK, { type: "string" }),
    );
    const selection = setup(fetchImpl, { [SERVICE_A]: registration() }, () => new Date());
    expect(await selection.outputSchema.forService(SERVICE_A)).toEqual({ type: "string" });
  });

  it("does not assign exploration to an unpayable cheapest offer", async () => {
    const fetchImpl = vi.fn<SafeFetch>(async (url) =>
      url.includes("cheap")
        ? response("1", "0xaaa", NETWORK, undefined, bareUrl(url), { scheme: "permit" })
        : response("25", "0xbbb", NETWORK, undefined, bareUrl(url)),
    );
    const selection = setup(
      fetchImpl,
      {
        [SERVICE_A]: registration("https://cheap.example/v1/search"),
        [SERVICE_B]: registration("https://payable.example/v1/search"),
      },
      () => new Date(),
    );

    const decision = await selection.rank.rank(query());

    expect(decision.exploration_slot?.service_id).toBe(SERVICE_B);
    expect(decision.unverified.map((row) => row.service_id)).toEqual([SERVICE_B]);
    expect(decision.excluded).toEqual([
      { service_id: SERVICE_A, gate: "offer", detail: "no-payable-live-offer" },
    ]);
  });

  it("rejects invalid IDs and ignores non-402 or malformed challenges", async () => {
    const config = loadConfig({
      envFile: { "selection.czarRegisteredServices": { bad: registration() } },
    });
    expect(() =>
      createRegisteredSelection({ config, safeFetch: vi.fn<SafeFetch>(), pool: getPool() }),
    ).toThrow(/ServiceId/);
    const fetchImpl = vi.fn<SafeFetch>(async () => ({
      status: 200,
      url: RESOURCE,
      headers: {},
      body: Buffer.from("ok"),
    }));
    const selection = setup(fetchImpl, { [SERVICE_A]: registration() }, () => new Date());
    expect(await selection.directory.get(SERVICE_A)).toBeNull();

    const malformedFetch = vi.fn<SafeFetch>(async () => ({
      status: 402,
      url: RESOURCE,
      headers: { "payment-required": encodeBase64Json({ x402Version: 2, accepts: [] }) },
      body: Buffer.from(""),
    }));
    const malformed = setup(malformedFetch, { [SERVICE_A]: registration() }, () => new Date());
    expect(await malformed.directory.get(SERVICE_A)).toBeNull();
  });

  it("reuses a snapshot while updating retention and changes it when configuration changes", async () => {
    let clock = new Date("2026-10-25T00:00:00Z");
    const fetchImpl = vi.fn<SafeFetch>(async () => response("25", "0xaaaa"));
    const selection = setup(fetchImpl, { [SERVICE_A]: registration() }, () => clock);
    const first = await selection.rank.rank(query());
    clock = new Date(clock.getTime() + 3600000);
    const second = await selection.rank.rank(query());
    const saved = await getPool().query<{ last_used_at: Date }>(
      "SELECT last_used_at FROM selection_interim_snapshots WHERE snapshot_id = $1",
      [first.snapshot_id],
    );

    expect(second.snapshot_id).toBe(first.snapshot_id);
    expect(saved.rows[0]!.last_used_at.toISOString()).toBe(clock.toISOString());
    const changed = setup(
      fetchImpl,
      {
        [SERVICE_A]: { ...registration(), capabilities: ["web-search", "page-extract"] },
      },
      () => clock,
    );
    expect((await changed.rank.rank(query())).snapshot_id).not.toBe(first.snapshot_id);
    clock = new Date(clock.getTime() + 91 * 24 * 3600000);
    await changed.rank.rank(query());
    const retained = await getPool().query<{ snapshot_id: string }>(
      "SELECT snapshot_id FROM selection_interim_snapshots",
    );
    expect(retained.rows).toHaveLength(1);
    expect(retained.rows[0]!.snapshot_id).not.toBe(first.snapshot_id);
  });

  it("keeps last_used_at monotonic when snapshot writes arrive in reverse time order", async () => {
    let clock = new Date("2026-10-25T12:00:00Z");
    const fetchImpl = vi.fn<SafeFetch>(async () => response("25", "0xaaaa"));
    const selection = setup(fetchImpl, { [SERVICE_A]: registration() }, () => clock);
    const laterDecision = await selection.rank.rank(query());
    clock = new Date("2026-10-25T11:00:00Z");

    const earlierDecision = await selection.rank.rank(query());
    const saved = await getPool().query<{ last_used_at: Date }>(
      "SELECT last_used_at FROM selection_interim_snapshots WHERE snapshot_id = $1",
      [laterDecision.snapshot_id],
    );

    expect(earlierDecision.snapshot_id).toBe(laterDecision.snapshot_id);
    expect(saved.rows[0]!.last_used_at.toISOString()).toBe("2026-10-25T12:00:00.000Z");
  });

  it("recrawls live offers and changes the snapshot when the offer changes", async () => {
    let clock = new Date("2026-10-25T00:00:00Z");
    let payTo = "0xaaaa";
    const fetchImpl = vi.fn<SafeFetch>(async () => response("25", payTo));
    const selection = setup(fetchImpl, { [SERVICE_A]: registration() }, () => clock);
    expect((await selection.directory.get(SERVICE_A))?.accepts[0]?.payTo).toContain("aaaa");
    const first = await selection.rank.rank(query());
    payTo = "0xcccc";
    clock = new Date(clock.getTime() + 25 * 3600000);
    expect((await selection.directory.get(SERVICE_A))?.accepts[0]?.payTo).toContain("cccc");
    expect((await selection.rank.rank(query())).snapshot_id).not.toBe(first.snapshot_id);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("acceptance ports", () => {
  it("supplies the directory schema, no history, K7 address, and injected clock", async () => {
    const now = new Date("2026-10-25T12:00:00Z");
    const keyAddress = vi.fn(async (caller: "cz-16", keyRef: "K7") => {
      expect(caller).toBe("cz-16");
      expect(keyRef).toBe("K7");
      return `0x${"7".repeat(40)}` as const;
    });
    const ports = createAcceptancePorts({
      selection: { outputSchema: { forService: async () => ({ type: "object" }) } },
      keyAddress,
      now: () => now,
    });

    expect(await ports.outputSchema.forService(SERVICE_A)).toEqual({ type: "object" });
    expect(await ports.shapeHistory.forService(SERVICE_A)).toBeNull();
    expect(await ports.validatorIdentity.address()).toBe(`0x${"7".repeat(40)}`);
    expect(ports.clock.now()).toBe(now);
    expect(keyAddress).toHaveBeenCalledOnce();
  });
});
