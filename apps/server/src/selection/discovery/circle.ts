import { circleServiceId, serviceVersionId } from "@czar/hashing";
import type { Config } from "@czar/config";
import {
  readPaymentRequired,
  type PaymentRequirements,
  type SafeFetch,
  type SanitizedExtensions,
} from "@czar/x402";
import type { Pool } from "pg";
import type { PlannerService } from "#src/planner/ports";
import { recordServiceVersion } from "#src/selection/service-versions";

interface CircleListing {
  readonly type: string;
  readonly resource: string;
  readonly accepts: readonly PaymentRequirements[];
  readonly metadata: {
    readonly method?: string;
    readonly description?: string;
    readonly provider?: { readonly name?: string; readonly category?: string };
    readonly input?: unknown;
    readonly output?: unknown;
    readonly siwx?: boolean;
    readonly requiredHeaders?: unknown;
  };
}

interface DiscoveryPage {
  readonly items: readonly CircleListing[];
  readonly pagination: { readonly limit: number; readonly offset: number; readonly total: number };
}

interface ListingCache {
  readonly items: readonly CircleListing[];
  readonly etag: string | null;
  readonly maxAgeSeconds: number;
  readonly staleSeconds: number;
  readonly freshUntil: number;
  readonly staleUntil: number;
}

export interface CircleCandidate extends PlannerService {
  readonly source: "circle-registry";
  readonly card: Readonly<Record<string, unknown>>;
  readonly versionId: string;
  readonly priceAtomic: string;
  readonly probe: {
    readonly matchedOffer: PaymentRequirements;
    readonly extensions402: SanitizedExtensions;
  };
}

export interface CircleDiscoveryOptions {
  readonly config: Config;
  readonly safeFetch: SafeFetch;
  readonly pool: Pool;
  readonly now?: () => Date;
  readonly log?: (entry: {
    readonly source: "circle";
    readonly outcome: string;
    readonly capability: string;
    readonly count: number;
  }) => void;
  readonly recordVersion?: typeof recordServiceVersion;
}

const MAX_SERVICE_NAME_CHARS = 80;
const MAX_DESCRIPTION_CHARS = 300;
const CIRCLE_ORIGIN = "https://api.circle.com";
const CALL_TEMPLATE_CAPABILITIES = new Set(["web-search", "page-extract", "code-review"]);
const AMOUNT6 = /^(0|[1-9][0-9]*)$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Lists eligible Circle resources and admits only those with a matching unpaid live 402. */
export function createCircleDiscovery(options: CircleDiscoveryOptions) {
  const { config, safeFetch, pool } = options;
  const now = options.now ?? (() => new Date());
  const recordVersion = options.recordVersion ?? recordServiceVersion;
  const cache = new Map<string, ListingCache>();
  const network = String(config.get("selection.paymentNetwork"));
  const asset = String(config.get("chain.usdcAddress"));
  const baseUrl = String(config.get("selection.circleDiscovery.baseUrl"));
  const capabilityMap = config.get("selection.circleDiscovery.capabilityMap") as Record<
    string,
    unknown
  >;
  const report = (outcome: string, capability: string, count = 1) =>
    options.log?.({ source: "circle", outcome, capability, count });

  async function listings(capability: string, mapping: Record<string, unknown>) {
    const key = `${network}\0${capability}`;
    const prior = cache.get(key);
    const time = now().getTime();
    if (prior && time < prior.freshUntil) return prior.items;
    try {
      const next = await fetchListings({
        safeFetch,
        config,
        baseUrl,
        network,
        asset,
        mapping,
        etag: prior?.etag ?? null,
        ...(prior ? { prior } : {}),
        time,
      });
      cache.set(key, next);
      return next.items;
    } catch {
      report("fetch-failed", capability);
      return prior && time < prior.staleUntil ? prior.items : [];
    }
  }

  return {
    async discover(capability: string): Promise<readonly CircleCandidate[]> {
      if (!config.get("selection.circleDiscovery.enabled")) return [];
      const mapping = capabilityMap[capability];
      if (!isObject(mapping)) return [];
      const items = await listings(capability, mapping);
      const maximum = Number(config.get("selection.circleDiscovery.maxCandidates"));
      const selected: {
        listing: CircleListing;
        service: PlannerService;
        offer: PaymentRequirements;
      }[] = [];
      for (const listing of items) {
        const mapped = mapListing(listing, network, asset, config, capability);
        if ("reason" in mapped) {
          report(mapped.reason, capability);
          continue;
        }
        if (selected.length >= maximum) {
          report("cap", capability);
          continue;
        }
        selected.push({ listing, ...mapped });
      }
      const candidates: CircleCandidate[] = [];
      for (const entry of selected) {
        const probed = await probeListing(entry.service, entry.offer, safeFetch, config);
        if (!probed) {
          report("probe-failed", capability);
          continue;
        }
        const versionId = serviceVersionId({
          payTo: probed.offer.payTo.toLowerCase(),
          resource: {
            url: entry.service.resource.url,
            method: entry.listing.metadata.method === "POST" ? "POST" : "GET",
          },
          schema: null,
        });
        try {
          await recordVersion({
            pool,
            network,
            serviceId: entry.service.serviceId,
            versionId,
            now: now(),
          });
        } catch {
          report("version-failed", capability);
          continue;
        }
        candidates.push({
          ...entry.service,
          source: "circle-registry",
          card: entry.service.extensions.czar.card,
          versionId,
          priceAtomic: probed.offer.amount,
          probe: { matchedOffer: probed.offer, extensions402: probed.extensions },
        });
      }
      return candidates;
    },
  };
}

async function fetchListings(input: {
  readonly safeFetch: SafeFetch;
  readonly config: Config;
  readonly baseUrl: string;
  readonly network: string;
  readonly asset: string;
  readonly mapping: Record<string, unknown>;
  readonly etag: string | null;
  readonly prior?: ListingCache;
  readonly time: number;
}): Promise<ListingCache> {
  const origin = new URL(input.baseUrl).origin;
  if (origin !== CIRCLE_ORIGIN) throw new Error("Circle discovery origin is not allowed");
  const limit = Number(input.config.get("selection.circleDiscovery.pageLimit"));
  const maxPages = Number(input.config.get("selection.circleDiscovery.maxPages"));
  const items = new Map<string, CircleListing>();
  let offset = 0;
  let etag: string | null = null;
  let cacheControl = "";
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const url = discoveryUrl(
      input.baseUrl,
      input.network,
      input.asset,
      input.mapping,
      limit,
      offset,
    );
    const response = await input.safeFetch(url, {
      method: "GET",
      headers: offset === 0 && input.etag ? { "if-none-match": input.etag } : {},
      timeoutMs: Number(input.config.get("selection.circleDiscovery.timeoutMs")),
      maxBytes: Number(input.config.get("selection.circleDiscovery.maxResponseBytes")),
    });
    if (new URL(response.url).origin !== CIRCLE_ORIGIN)
      throw new Error("Circle redirect escaped origin");
    if (response.status === 304 && offset === 0 && input.prior) {
      return refreshCache(
        input.prior.items,
        input.prior.etag,
        response.headers["cache-control"] ?? "",
        input,
        input.prior,
      );
    }
    if (response.status !== 200) throw new Error("Circle discovery did not return 200");
    const body = JSON.parse(Buffer.from(response.body).toString("utf8")) as unknown;
    const page = parsePage(body);
    etag = response.headers["etag"] ?? etag;
    cacheControl = response.headers["cache-control"] ?? cacheControl;
    for (const item of page.items) {
      const key = `${item.type}\0${item.resource}\0${item.metadata.method ?? "GET"}`;
      if (!items.has(key)) items.set(key, item);
    }
    offset += page.pagination.limit;
    if (offset >= page.pagination.total) break;
  }
  return refreshCache([...items.values()], etag, cacheControl, input);
}

function discoveryUrl(
  baseUrl: string,
  network: string,
  asset: string,
  mapping: Record<string, unknown>,
  limit: number,
  offset: number,
): string {
  const url = new URL(baseUrl);
  url.searchParams.set("network", network);
  url.searchParams.set("type", "http");
  url.searchParams.set("scheme", "exact");
  url.searchParams.set("asset", asset);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  if (typeof mapping["category"] === "string")
    url.searchParams.set("category", mapping["category"]);
  if (typeof mapping["query"] === "string") url.searchParams.set("query", mapping["query"]);
  return url.toString();
}

function refreshCache(
  items: readonly CircleListing[],
  etag: string | null,
  header: string,
  input: { readonly config: Config; readonly time: number },
  prior?: ListingCache,
): ListingCache {
  const maxAge = Math.min(
    cacheDirective(header, "max-age") ?? prior?.maxAgeSeconds ?? 0,
    Number(input.config.get("selection.circleDiscovery.cacheSeconds")),
  );
  const stale = cacheDirective(header, "stale-while-revalidate") ?? prior?.staleSeconds ?? 0;
  const freshUntil = input.time + maxAge * 1000;
  return {
    items,
    etag,
    maxAgeSeconds: maxAge,
    staleSeconds: stale,
    freshUntil,
    staleUntil: freshUntil + stale * 1000,
  };
}

function cacheDirective(header: string, name: string): number | null {
  const match = new RegExp(`(?:^|,)\\s*${name}=(\\d+)(?:,|$)`, "i").exec(header);
  return match ? Number(match[1]) : null;
}

function parsePage(value: unknown): DiscoveryPage {
  if (!isObject(value) || value["x402Version"] !== 2 || !Array.isArray(value["items"]))
    throw new TypeError("Invalid Circle discovery page");
  const pagination = value["pagination"];
  if (!isObject(pagination)) throw new TypeError("Invalid Circle pagination");
  const { limit, offset, total } = pagination;
  if (
    ![limit, offset, total].every(
      (number) => typeof number === "number" && Number.isSafeInteger(number) && number >= 0,
    ) ||
    limit === 0
  )
    throw new TypeError("Invalid Circle pagination");
  for (const item of value["items"]) {
    if (
      !isObject(item) ||
      typeof item["resource"] !== "string" ||
      typeof item["type"] !== "string" ||
      !Array.isArray(item["accepts"]) ||
      !isObject(item["metadata"])
    )
      throw new TypeError("Invalid Circle listing");
  }
  return {
    items: value["items"] as CircleListing[],
    pagination: { limit: limit as number, offset: offset as number, total: total as number },
  };
}

function mapListing(
  listing: CircleListing,
  network: string,
  asset: string,
  config: Config,
  capability: string,
): { service: PlannerService; offer: PaymentRequirements } | { reason: string } {
  if (listing.type !== "http") return { reason: "type" };
  const method = listing.metadata.method ?? "GET";
  if ((method !== "GET" && method !== "POST") || !validResource(listing.resource))
    return { reason: "resource" };
  const networkOffers = listing.accepts.filter(
    (offer) => validOffer(offer) && offer.network === network,
  );
  const payable = networkOffers.filter(
    (offer) => offer.scheme === "exact" && offer.asset.toLowerCase() === asset.toLowerCase(),
  );
  if (payable.length === 0) return { reason: "payment-fit" };
  const maxAmount = BigInt(config.get("planner.defaultMaxUnitAtomic") as number);
  const affordable = payable.filter((offer) => BigInt(offer.amount) <= maxAmount);
  if (affordable.length === 0) return { reason: "price" };
  if (listing.metadata.siwx === true) return { reason: "siwx" };
  if (hasRequiredHeaders(listing.metadata.requiredHeaders)) return { reason: "required-headers" };
  if (!CALL_TEMPLATE_CAPABILITIES.has(capability)) return { reason: "no-template" };
  const field = oneRequiredString(listing.metadata.input, method);
  if (!field) return { reason: "no-template" };
  const offer = affordable.reduce((best, next) =>
    BigInt(next.amount) < BigInt(best.amount) ? next : best,
  );
  const resource = { url: listing.resource, method: method as "GET" | "POST" };
  const card = {
    serviceName: truncate(listing.metadata.provider?.name, MAX_SERVICE_NAME_CHARS),
    description: truncate(listing.metadata.description, MAX_DESCRIPTION_CHARS),
    category: truncate(listing.metadata.provider?.category, MAX_SERVICE_NAME_CHARS),
    inputFields: [{ name: field, type: "string" }],
    ...(isObject(listing.metadata.output) ? { outputSchema: listing.metadata.output } : {}),
  };
  const probeInput =
    method === "GET" ? { query: { [field]: "probe" } } : { body: { [field]: "probe" } };
  const service: PlannerService = {
    serviceId: circleServiceId(network, method, listing.resource),
    resource,
    probeInput,
    accepts: networkOffers,
    extensions: {
      czar: { claim: { status: "unclaimed" }, evidence: null, card, source: "circle-registry" },
    },
  };
  return { service, offer };
}

function oneRequiredString(input: unknown, method: "GET" | "POST"): string | null {
  if (!isObject(input)) return null;
  const schema = input[method === "GET" ? "queryParams" : "body"];
  if (
    !isObject(schema) ||
    !Array.isArray(schema["required"]) ||
    schema["required"].length !== 1 ||
    !isObject(schema["properties"])
  )
    return null;
  const name = schema["required"][0];
  const property = typeof name === "string" ? schema["properties"][name] : null;
  return isObject(property) && property["type"] === "string" && name.length <= 64 ? name : null;
}

function hasRequiredHeaders(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return typeof value === "string" && value.length > 0;
}

function validResource(value: string): boolean {
  if (value.includes("?") || value.includes("#")) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function validOffer(offer: PaymentRequirements): boolean {
  return (
    typeof offer === "object" &&
    offer !== null &&
    typeof offer.network === "string" &&
    typeof offer.scheme === "string" &&
    typeof offer.asset === "string" &&
    ADDRESS.test(offer.asset) &&
    typeof offer.payTo === "string" &&
    ADDRESS.test(offer.payTo) &&
    typeof offer.amount === "string" &&
    AMOUNT6.test(offer.amount) &&
    Number.isSafeInteger(offer.maxTimeoutSeconds) &&
    offer.maxTimeoutSeconds > 0 &&
    isObject(offer.extra)
  );
}

async function probeListing(
  service: PlannerService,
  expected: PaymentRequirements,
  safeFetch: SafeFetch,
  config: Config,
): Promise<{ offer: PaymentRequirements; extensions: SanitizedExtensions } | null> {
  try {
    const url = new URL(service.resource.url);
    if (service.resource.method === "GET") {
      for (const [key, value] of Object.entries(service.probeInput?.query ?? {}))
        url.searchParams.set(key, value);
    }
    const body = service.probeInput?.body;
    const response = await safeFetch(url.toString(), {
      method: service.resource.method,
      timeoutMs: Number(config.get("planner.probeTimeoutMs")),
      ...(body
        ? {
            headers: { "content-type": "application/json" },
            body: Buffer.from(JSON.stringify(body)),
          }
        : {}),
    });
    if (response.status !== 402 || new URL(response.url).origin !== url.origin) return null;
    const parsed = readPaymentRequired({
      status: response.status,
      headers: response.headers,
      body: Buffer.from(response.body).toString("utf8"),
    });
    if (
      !parsed.ok ||
      parsed.version !== 2 ||
      new URL(parsed.resource.url).origin !== url.origin ||
      new URL(parsed.resource.url).pathname !== url.pathname ||
      parsed.extensions.dropped.some(
        (name) => name === "sign-in-with-x" || name.endsWith("-session"),
      )
    )
      return null;
    const offer = parsed.paymentRequired.accepts.find(
      (candidateOffer) =>
        candidateOffer.network === expected.network &&
        candidateOffer.scheme === expected.scheme &&
        candidateOffer.asset.toLowerCase() === expected.asset.toLowerCase() &&
        candidateOffer.amount === expected.amount &&
        candidateOffer.payTo.toLowerCase() === expected.payTo.toLowerCase() &&
        candidateOffer.extra["name"] === expected.extra["name"],
    );
    return offer ? { offer, extensions: parsed.extensions } : null;
  } catch {
    return null;
  }
}

function truncate(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
