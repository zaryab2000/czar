import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "@czar/config";
import { circleServiceId, serviceVersionId } from "@czar/hashing";
import type { PaymentRequirements, SafeFetch, SafeFetchResponse } from "@czar/x402";
import type { Pool } from "pg";
import { createCircleDiscovery } from "#src/selection/discovery/circle";

interface Listing {
  resource: string;
  type: string;
  accepts: PaymentRequirements[];
  metadata: {
    method: string;
    description?: string;
    provider: { name: string; category: string };
    input: Record<string, unknown>;
    output?: Record<string, unknown>;
    siwx?: boolean;
    requiredHeaders?: string[];
  };
}

// Unmodified listing items captured through Czar safeFetch on 2026-11-05; the response wrapper is a subset.
const recorded = JSON.parse(
  readFileSync(new URL("./fixtures/circle-arc-testnet.json", import.meta.url), "utf8"),
) as { items: Listing[] };
const quicknode = recorded.items.find((item) => item.resource.includes("arc-testnet"))!;
const botpay = recorded.items.find((item) => item.resource.endsWith("/go"))!;

function eligibleListing(): Listing {
  const listing = structuredClone(botpay);
  listing.metadata.input["queryParams"] = {
    type: "object",
    required: ["testRunId"],
    properties: { testRunId: { type: "string" } },
  };
  return listing;
}

function page(items: Listing[], limit = 200, offset = 0, total = items.length): SafeFetchResponse {
  return {
    status: 200,
    url: "https://api.circle.com/v2/x402/discovery/resources",
    headers: { "cache-control": "public, max-age=3600, stale-while-revalidate=600", etag: "v1" },
    body: Buffer.from(
      JSON.stringify({ x402Version: 2, items, pagination: { limit, offset, total } }),
    ),
  };
}

function challenge(
  listing: Listing,
  changes: Record<string, unknown> = {},
  extensions: Record<string, unknown> = {},
): SafeFetchResponse {
  const offer = listing.accepts.find((entry) => entry.network === "eip155:5042002")!;
  const body = {
    x402Version: 2,
    resource: { url: listing.resource },
    accepts: [{ ...offer, ...changes }],
    extensions,
  };
  return {
    status: 402,
    url: listing.resource,
    headers: { "payment-required": Buffer.from(JSON.stringify(body)).toString("base64") },
    body: Buffer.from(""),
  };
}

function setup(
  fetch: SafeFetch,
  configOverrides: Record<string, unknown> = {},
  now: () => Date = () => new Date("2026-11-05T16:00:00Z"),
) {
  const logs: { outcome: string; count: number }[] = [];
  const recordVersion = vi.fn(async () => {});
  const source = createCircleDiscovery({
    config: loadConfig({
      envFile: { "selection.circleDiscovery.enabled": true, ...configOverrides },
    }),
    safeFetch: fetch,
    pool: {} as Pool,
    now,
    log: ({ outcome, count }) => logs.push({ outcome, count }),
    recordVersion,
  });
  return { source, logs, recordVersion };
}

describe("SCR-187 Circle discovery", () => {
  it("uses the exact mapped request parameters and skips unmapped capabilities", async () => {
    const urls: URL[] = [];
    const fetch: SafeFetch = async (url) => {
      urls.push(new URL(url));
      return page([]);
    };
    const { source } = setup(fetch);
    for (const capability of [
      "web-search",
      "page-extract",
      "data-lookup",
      "email-lookup",
      "company-lookup",
      "price-lookup",
      "image-generate",
      "summarize",
      "translate",
      "transcribe",
      "code-review",
    ])
      await source.discover(capability);
    await source.discover("table-build");
    await source.discover("chart-build");
    expect(urls).toHaveLength(11);
    for (const url of urls) {
      expect(url.origin + url.pathname).toBe("https://api.circle.com/v2/x402/discovery/resources");
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        network: "eip155:5042002",
        type: "http",
        scheme: "exact",
        asset: "0x3600000000000000000000000000000000000000",
        limit: "200",
        offset: "0",
      });
    }
    expect(urls[0]!.searchParams.get("category")).toBe("WEB_SEARCH_RESEARCH");
    expect(urls[1]!.searchParams.get("query")).toBe("extract");
    expect(urls.at(-1)!.searchParams.get("query")).toBe("audit");
    expect(urls.at(-1)!.searchParams.has("category")).toBe(false);
  });

  it("pages, deduplicates unstable results, and caps candidates before probing", async () => {
    const first = eligibleListing();
    const second = { ...eligibleListing(), resource: "https://api.botpay.network/pay" };
    const requests: string[] = [];
    const fetch: SafeFetch = async (url) => {
      requests.push(url);
      if (!url.startsWith("https://api.circle.com"))
        return challenge(url.includes("/pay") ? second : first);
      const offset = Number(new URL(url).searchParams.get("offset"));
      return page(offset === 0 ? [first] : offset === 1 ? [first] : [second], 1, offset, 3);
    };
    const { source } = setup(fetch);
    const candidates = await source.discover("web-search");
    expect(candidates).toHaveLength(2);
    expect(requests.filter((url) => url.startsWith("https://api.circle.com"))).toHaveLength(3);
    expect(requests.filter((url) => url.startsWith("https://api.botpay.network"))).toHaveLength(2);

    const capped = setup(fetch, { "selection.circleDiscovery.maxPages": 2 });
    expect(await capped.source.discover("web-search")).toHaveLength(1);

    const candidateCap = setup(fetch, { "selection.circleDiscovery.maxCandidates": 1 });
    expect(await candidateCap.source.discover("web-search")).toHaveLength(1);
    expect(candidateCap.logs).toContainEqual({ outcome: "cap", count: 1 });
  });

  it("never probes more than planner.probeTopK Circle candidates", async () => {
    const first = eligibleListing();
    const second = { ...eligibleListing(), resource: "https://api.botpay.network/pay" };
    const probed: string[] = [];
    const fetch: SafeFetch = async (url) => {
      if (url.startsWith("https://api.circle.com")) return page([first, second]);
      probed.push(url);
      return challenge(url.includes("/pay") ? second : first);
    };
    const { source } = setup(fetch, { "planner.probeTopK": 1 });
    expect(await source.discover("web-search")).toHaveLength(1);
    expect(probed).toHaveLength(1);
  });

  it("caches fresh pages, revalidates with an ETag, and drops expired stale data", async () => {
    let time = Date.parse("2026-11-05T16:00:00Z");
    const requestHeaders: Record<string, string>[] = [];
    let request = 0;
    const fetch: SafeFetch = async (_url, options) => {
      requestHeaders.push({ ...options?.headers });
      request += 1;
      if (request === 1) return page([]);
      if (request === 2)
        return {
          status: 304,
          url: "https://api.circle.com/v2/x402/discovery/resources",
          headers: {},
          body: Buffer.from(""),
        };
      throw new Error("offline");
    };
    const { source } = setup(fetch, {}, () => new Date(time));
    await source.discover("web-search");
    await source.discover("web-search");
    expect(request).toBe(1);
    time += 3_600_000;
    await source.discover("web-search");
    expect(requestHeaders[1]).toEqual({ "if-none-match": "v1" });
    await source.discover("web-search");
    expect(request).toBe(2);
    time += 3_600_000 + 600_001;
    await source.discover("web-search");
    expect(request).toBe(3);
  });

  it("does not reuse a single page validator for a multi-page aggregate", async () => {
    const first = eligibleListing();
    const second = { ...eligibleListing(), resource: "https://api.botpay.network/pay" };
    const replacement = { ...eligibleListing(), resource: "https://api.botpay.network/new" };
    let time = Date.parse("2026-11-05T16:00:00Z");
    const requestHeaders: Record<string, string>[] = [];
    let pageCount = 0;
    const fetch: SafeFetch = async (url, options) => {
      if (!url.startsWith("https://api.circle.com")) {
        const listing = url.includes("/new") ? replacement : url.includes("/pay") ? second : first;
        return challenge(listing);
      }
      requestHeaders.push({ ...options?.headers });
      const round = Math.floor(pageCount / 2);
      const offset = Number(new URL(url).searchParams.get("offset"));
      pageCount += 1;
      return {
        ...page([offset === 0 ? first : round === 0 ? second : replacement], 1, offset, 2),
        headers: { etag: `page-${offset}`, "cache-control": "max-age=1" },
      };
    };
    const { source } = setup(fetch, {}, () => new Date(time));
    expect(await source.discover("web-search")).toHaveLength(2);
    time += 1_001;
    const refreshed = await source.discover("web-search");
    expect(requestHeaders[2]).toEqual({});
    expect(refreshed.map((candidate) => candidate.resource.url)).toContain(replacement.resource);
  });

  it("serves cached listings during the stale window when revalidation fails", async () => {
    const listing = eligibleListing();
    let time = Date.parse("2026-11-05T16:00:00Z");
    let discoveryCalls = 0;
    const fetch: SafeFetch = async (url) => {
      if (!url.startsWith("https://api.circle.com")) return challenge(listing);
      discoveryCalls += 1;
      if (discoveryCalls === 1) return page([listing]);
      throw new Error("offline");
    };
    const { source } = setup(fetch, {}, () => new Date(time));
    expect(await source.discover("web-search")).toHaveLength(1);
    time += 3_600_001;
    expect(await source.discover("web-search")).toHaveLength(1);
    time += 600_000;
    expect(await source.discover("web-search")).toHaveLength(0);
  });

  it("falls back on registry errors and logs only count and reason", async () => {
    for (const response of [
      { ...page([]), status: 500 },
      { ...page([]), body: Buffer.from("invalid JSON") },
    ]) {
      const { source, logs } = setup(async () => response);
      expect(await source.discover("web-search")).toEqual([]);
      expect(logs).toEqual([{ outcome: "fetch-failed", count: 1 }]);
    }
    const { source, logs } = setup(async () => {
      throw new Error("timeout");
    });
    expect(await source.discover("web-search")).toEqual([]);
    expect(logs).toEqual([{ outcome: "fetch-failed", count: 1 }]);
  });

  it("maps a recorded listing into stable, bounded plain-text candidate fields", async () => {
    const listing = eligibleListing();
    listing.metadata.provider.name = "X".repeat(90);
    listing.metadata.description = "<script>" + "Y".repeat(400);
    const fetch: SafeFetch = async (url) =>
      url.startsWith("https://api.circle.com") ? page([listing]) : challenge(listing);
    const { source, recordVersion } = setup(fetch);
    const candidates = await source.discover("web-search");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      serviceId: circleServiceId("eip155:5042002", "GET", listing.resource),
      source: "circle-registry",
      resource: { url: listing.resource, method: "GET" },
      priceAtomic: "100000",
      card: { inputFields: [{ name: "testRunId", type: "string" }] },
      probe: {
        matchedOffer: {
          amount: "100000",
          network: "eip155:5042002",
        },
        extensions402: { dropped: [] },
      },
    });
    expect(String(candidates[0]!.card["serviceName"])).toHaveLength(80);
    expect(String(candidates[0]!.card["description"])).toHaveLength(300);
    expect(recordVersion).toHaveBeenCalledOnce();
  });

  it("uses the validated live Bazaar schema in the recorded version", async () => {
    const listing = eligibleListing();
    const schema = { type: "object", properties: { input: { type: "object" } } };
    const extensions = { bazaar: { info: { input: {} }, schema } };
    const fetch: SafeFetch = async (url) =>
      url.startsWith("https://api.circle.com")
        ? page([listing])
        : challenge(listing, {}, extensions);
    const { source, recordVersion } = setup(fetch);
    const [candidate] = await source.discover("web-search");
    const payTo = listing.accepts.find((offer) => offer.network === "eip155:5042002")!.payTo;
    const versionId = serviceVersionId({
      payTo: payTo.toLowerCase(),
      resource: { url: listing.resource, method: "GET" },
      schema,
    });
    expect(candidate?.versionId).toBe(versionId);
    expect(recordVersion).toHaveBeenCalledWith(expect.objectContaining({ versionId }));
  });

  it("drops the recorded SIWX and schema-less listings and other bad fits", async () => {
    const cases: [Listing, string][] = [
      [quicknode, "siwx"],
      [botpay, "no-template"],
      [{ ...eligibleListing(), type: "mcp" }, "type"],
      [{ ...eligibleListing(), accepts: [] }, "payment-fit"],
      [
        {
          ...eligibleListing(),
          accepts: eligibleListing().accepts.map((offer) => ({
            ...offer,
            network: "eip155:5042",
          })),
        },
        "payment-fit",
      ],
      [
        {
          ...eligibleListing(),
          accepts: eligibleListing().accepts.map((offer) =>
            offer.network === "eip155:5042002" ? { ...offer, amount: "1000001" } : offer,
          ),
        },
        "price",
      ],
      [
        {
          ...eligibleListing(),
          metadata: { ...eligibleListing().metadata, requiredHeaders: ["x-key"] },
        },
        "required-headers",
      ],
      [{ ...eligibleListing(), resource: "http://127.0.0.1/pay" }, "resource"],
    ];
    for (const [listing, reason] of cases) {
      const { source, logs } = setup(async () => page([listing]));
      expect(await source.discover("web-search")).toEqual([]);
      expect(logs).toContainEqual({ outcome: reason, count: 1 });
    }
  });

  it("requires an equal v2 402 offer without sign-in or session extensions", async () => {
    const listing = eligibleListing();
    const offer = listing.accepts.find((entry) => entry.network === "eip155:5042002")!;
    for (const changed of [{ payTo: `0x${"1".repeat(40)}` }, { amount: "100001" }]) {
      const { source } = setup(async (url) =>
        url.startsWith("https://api.circle.com") ? page([listing]) : challenge(listing, changed),
      );
      expect(await source.discover("web-search")).toEqual([]);
    }
    const signIn = challenge(listing);
    for (const extension of ["sign-in-with-x", "quicknode-session"]) {
      const payload = {
        x402Version: 2,
        resource: { url: listing.resource },
        accepts: [offer],
        extensions: { [extension]: {} },
      };
      const fetch: SafeFetch = async (url) =>
        url.startsWith("https://api.circle.com")
          ? page([listing])
          : {
              ...signIn,
              headers: {
                "payment-required": Buffer.from(JSON.stringify(payload)).toString("base64"),
              },
            };
      const { source } = setup(fetch);
      expect(await source.discover("web-search")).toEqual([]);
    }
  });

  it("drops a candidate when its service version cannot be recorded", async () => {
    const listing = eligibleListing();
    const fetch: SafeFetch = async (url) =>
      url.startsWith("https://api.circle.com") ? page([listing]) : challenge(listing);
    const { source, logs, recordVersion } = setup(fetch);
    recordVersion.mockRejectedValueOnce(new Error("database unavailable"));
    expect(await source.discover("web-search")).toEqual([]);
    expect(logs).toContainEqual({ outcome: "version-failed", count: 1 });
  });
});
