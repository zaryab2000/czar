import { loadConfig } from "@czar/config";
import { H } from "@czar/hashing";
import { encodeBase64Json, type SafeFetch } from "@czar/x402";
import { validateSchema } from "@czar/schemas";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAcceptancePorts } from "#src/acceptance/ports";
import type { RankingQuery } from "#src/planner/ports";
import { createRegisteredSelection } from "#src/selection/registered/index";
import { setupDatabase } from "#test/db";

const getPool = setupDatabase();
const SERVICE_A = `svc_${"a".repeat(32)}`;
const SERVICE_B = `svc_${"b".repeat(32)}`;
const NETWORK = "eip155:5042002";
const RESOURCE = "https://merchant.example/v1/search";

function offer(amount: string, payTo: string, network = NETWORK) {
  return {
    scheme: "exact",
    network,
    amount,
    asset: "0x3600000000000000000000000000000000000000",
    payTo: `0x${payTo.replace(/^0x/, "").padStart(40, "0")}`,
    maxTimeoutSeconds: 300,
    extra: {},
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
) {
  const body = {
    x402Version: 2,
    resource: { url: resourceUrl, description: "private merchant description" },
    accepts: [offer(amount, payTo, network)],
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
) {
  const config = loadConfig({ envFile: { "selection.czarRegisteredServices": services } });
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
        scr: "SCR-137",
        network: NETWORK,
        unverifiedWithApproval: true,
        exploration: "lowest-live-price-then-serviceId",
        ranked: "none",
      }).slice(2, 18)}`,
    );
    expect(decision.snapshot_anchor_tx).toBeNull();
    expect(decision.ranked).toEqual([]);
    expect(decision.unverified.map((row) => row.service_id)).toEqual([SERVICE_A, SERVICE_B]);
    expect(decision.exploration_slot?.service_id).toBe(SERVICE_A);
    expect(H(body)).toBe(decision.snapshot_id);
    expect(saved.rows[0]!.body_jcs).not.toContain("private merchant description");
    expect((body["services"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      serviceId: SERVICE_A,
      serviceName: "a",
      resourceUrl: "https://a.example/v1/search",
      capabilities: ["web-search"],
    });
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
    const keyAddress = vi.fn(async (keyRef: "K7") => {
      expect(keyRef).toBe("K7");
      return "0xvalidator";
    });
    const ports = createAcceptancePorts({
      selection: { outputSchema: { forService: async () => ({ type: "object" }) } },
      keyAddress,
      now: () => now,
    });

    expect(await ports.outputSchema.forService(SERVICE_A)).toEqual({ type: "object" });
    expect(await ports.shapeHistory.forService(SERVICE_A)).toBeNull();
    expect(await ports.validatorIdentity.address()).toBe("0xvalidator");
    expect(ports.clock.now()).toBe(now);
    expect(keyAddress).toHaveBeenCalledOnce();
  });
});
