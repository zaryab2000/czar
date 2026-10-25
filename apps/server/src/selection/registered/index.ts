import { randomUUID } from "node:crypto";
import { H, jcsString } from "@czar/hashing";
import type { Config } from "@czar/config";
import type { RankingDecision } from "@czar/schemas";
import {
  readPaymentRequired,
  USDC_ADDRESS,
  type PaymentRequirements,
  type SafeFetch,
  type SafeFetchOptions,
} from "@czar/x402";
import { keccak256, toBytes } from "viem";
import type { Pool } from "pg";
import type { RankingQuery, PlannerService } from "#src/planner/ports";

interface ProbeInput {
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: Readonly<Record<string, unknown>>;
}

interface Registration {
  readonly serviceName: string;
  readonly resource: { readonly url: string; readonly method: "GET" | "POST" };
  readonly probeInput: ProbeInput;
  readonly capabilities: readonly string[];
}

interface RegisteredRecord {
  readonly serviceId: string;
  readonly registration: Registration;
  readonly accepts: readonly PaymentRequirements[];
  readonly outputSchema: Readonly<Record<string, unknown>> | null;
  readonly probedAt: string;
}

interface CachedProbe {
  readonly record: RegisteredRecord | null;
  readonly fetchedAt: number;
}

interface RegisteredSelectionOptions {
  readonly config: Config;
  readonly safeFetch: SafeFetch;
  readonly pool: Pool;
  readonly now?: () => Date;
}

export interface RegisteredSelection {
  readonly directory: {
    get(serviceId: string): Promise<(PlannerService & { probeInput: ProbeInput }) | null>;
  };
  readonly outputSchema: {
    forService(serviceId: string): Promise<Readonly<Record<string, unknown>> | null>;
  };
  readonly rank: { rank(query: RankingQuery): Promise<RankingDecision> };
}

/** Creates a cached registered-service directory and persists truthful interim decisions. */
export function createRegisteredSelection(
  options: RegisteredSelectionOptions,
): RegisteredSelection {
  const records = new Map<string, CachedProbe>();
  const pending = new Map<string, Promise<RegisteredRecord | null>>();
  const now = options.now ?? (() => new Date());
  const registrations = readRegistrations(options.config);
  const recrawlMs = Number(options.config.get("selection.registeredRecrawlHours")) * 3600000;
  const timeoutMs = Number(options.config.get("selection.probeTimeoutMs"));
  const network = String(options.config.get("selection.paymentNetwork"));
  const policy = policyVersion(
    network,
    Boolean(options.config.get("selection.unverifiedWithApproval")),
  );

  async function getRecord(serviceId: string): Promise<RegisteredRecord | null> {
    const registration = registrations.get(serviceId);
    if (!registration) return null;
    const cached = records.get(serviceId);
    if (cached && now().getTime() - cached.fetchedAt < recrawlMs) return cached.record;
    const active = pending.get(serviceId);
    if (active) return active;
    const request = probe(serviceId, registration, options.safeFetch, timeoutMs, now)
      .then((record) => {
        records.set(serviceId, { record, fetchedAt: now().getTime() });
        return record;
      })
      .finally(() => pending.delete(serviceId));
    pending.set(serviceId, request);
    return request;
  }

  return {
    directory: {
      async get(serviceId) {
        const record = await getRecord(serviceId);
        return record ? toPlannerService(record) : null;
      },
    },
    outputSchema: {
      async forService(serviceId) {
        return (await getRecord(serviceId))?.outputSchema ?? null;
      },
    },
    rank: {
      async rank(query) {
        const services = await Promise.all(
          [...registrations].map(async ([serviceId, registration]) => ({
            serviceId,
            registration,
            record: await getRecord(serviceId),
          })),
        );
        return createDecision({
          query,
          services,
          network,
          policy,
          explorationEnabled: Boolean(options.config.get("selection.unverifiedWithApproval")),
          riskQuantile: Number(options.config.get("selection.riskQuantile")),
          weights: {
            cost: Number(options.config.get("selection.wCost")),
            latency: Number(options.config.get("selection.wLatency")),
          },
          retentionDays: Number(options.config.get("selection.decisionRetentionDays")),
          pool: options.pool,
          now,
        });
      },
    },
  };
}

function readRegistrations(config: Config): ReadonlyMap<string, Registration> {
  const input: unknown = config.get("selection.czarRegisteredServices");
  const taxonomy = config.get("drives.capabilityTaxonomy") as { readonly tags?: unknown };
  const allowedCapabilities = new Set(Array.isArray(taxonomy.tags) ? taxonomy.tags : []);
  if (!isObject(input)) throw new TypeError("registered services must be an object");
  const registrations = new Map<string, Registration>();
  for (const [serviceId, value] of Object.entries(input)) {
    if (!/^svc_[0-9a-f]{32}$/.test(serviceId))
      throw new TypeError(`${serviceId} is not a ServiceId`);
    if (!isObject(value) || !isObject(value["resource"]))
      throw new TypeError(`${serviceId} is malformed`);
    const resource = value["resource"];
    const probeInput = value["probeInput"];
    if (typeof value["serviceName"] !== "string" || !Array.isArray(value["capabilities"]))
      throw new TypeError(`${serviceId} needs serviceName and capabilities`);
    if (resource["method"] !== "GET" && resource["method"] !== "POST")
      throw new TypeError(`${serviceId}.resource.method must be GET or POST`);
    if (typeof resource["url"] !== "string" || !validBareUrl(resource["url"]))
      throw new TypeError(`${serviceId}.resource.url must be a URL without query or fragment`);
    if (!Array.isArray(value["capabilities"]) || !value["capabilities"].every(isString))
      throw new TypeError(`${serviceId}.capabilities must be strings`);
    if (!value["capabilities"].every((capability) => allowedCapabilities.has(capability)))
      throw new TypeError(`${serviceId}.capabilities must come from drives.capabilityTaxonomy`);
    if (!validProbeInput(probeInput, resource["method"]))
      throw new TypeError(`${serviceId}.probeInput does not match its method`);
    registrations.set(serviceId, {
      serviceName: value["serviceName"],
      resource: { url: resource["url"], method: resource["method"] },
      probeInput,
      capabilities: value["capabilities"],
    });
  }
  return registrations;
}

async function probe(
  serviceId: string,
  registration: Registration,
  safeFetch: SafeFetch,
  timeoutMs: number,
  now: () => Date,
): Promise<RegisteredRecord | null> {
  try {
    const response = await safeFetch(probeUrl(registration), probeOptions(registration, timeoutMs));
    if (
      response.status !== 402 ||
      new URL(response.url).origin !== new URL(registration.resource.url).origin
    )
      return null;
    const result = readPaymentRequired({
      status: response.status,
      headers: response.headers,
      body: Buffer.from(response.body).toString("utf8"),
    });
    if (!result.ok || !sameResourcePath(result.resource.url, registration.resource.url))
      return null;
    return {
      serviceId,
      registration,
      accepts: result.paymentRequired.accepts,
      outputSchema: responseSchema(result.extensions.bazaar?.schema),
      probedAt: now().toISOString(),
    };
  } catch {
    return null;
  }
}

function probeOptions(registration: Registration, timeoutMs: number): SafeFetchOptions {
  const { method } = registration.resource;
  if (method === "GET") {
    return { method, timeoutMs, headers: {} };
  }
  return {
    method,
    timeoutMs,
    headers: { "content-type": "application/json" },
    body: toBytes(JSON.stringify(registration.probeInput.body ?? {})),
  };
}

function probeUrl(registration: Registration): string {
  const url = new URL(registration.resource.url);
  if (registration.resource.method === "GET") {
    for (const [key, value] of Object.entries(registration.probeInput.query ?? {}))
      url.searchParams.set(key, value);
  }
  return url.toString();
}

function sameResourcePath(challengeUrl: string, configuredUrl: string): boolean {
  const challenge = new URL(challengeUrl);
  const configured = new URL(configuredUrl);
  return challenge.origin === configured.origin && challenge.pathname === configured.pathname;
}

function responseSchema(schema: Readonly<Record<string, unknown>> | undefined) {
  const output = objectAt(schema, "properties", "output");
  const example = objectAt(output, "properties", "example");
  if (!example || (Object.keys(example).length === 1 && example["type"] === "object")) return null;
  return example;
}

function objectAt(value: unknown, ...path: string[]): Record<string, unknown> | null {
  let current = value;
  for (const key of path) {
    if (!isObject(current)) return null;
    current = current[key];
  }
  return isObject(current) ? current : null;
}

function toPlannerService(record: RegisteredRecord): PlannerService & { probeInput: ProbeInput } {
  return {
    serviceId: record.serviceId,
    resource: record.registration.resource,
    probeInput: record.registration.probeInput,
    accepts: record.accepts,
    extensions: {
      czar: {
        claim: { status: "unclaimed" },
        evidence: null,
        card: { serviceName: record.registration.serviceName, inputFields: [], outputFields: [] },
        source: "czar-registered",
      },
    },
  };
}

async function createDecision(args: {
  readonly query: RankingQuery;
  readonly services: readonly {
    serviceId: string;
    registration: Registration;
    record: RegisteredRecord | null;
  }[];
  readonly network: string;
  readonly policy: string;
  readonly explorationEnabled: boolean;
  readonly riskQuantile: number;
  readonly weights: Readonly<Record<string, number>>;
  readonly retentionDays: number;
  readonly pool: Pool;
  readonly now: () => Date;
}): Promise<RankingDecision> {
  const { query, services, network, policy, explorationEnabled, riskQuantile, weights, now } = args;
  const candidates = services
    .filter(({ registration }) => registration.capabilities.includes(query.capability))
    .toSorted((left, right) => compareServiceId(left.serviceId, right.serviceId));
  const excluded: RankingDecision["excluded"] = [];
  const eligible: Array<{ serviceId: string; amount: bigint }> = [];
  for (const candidate of candidates) {
    if (!candidate.record) {
      excluded.push({
        service_id: candidate.serviceId,
        gate: "probe-failed",
        detail: "live-402-unavailable-or-malformed",
      });
      continue;
    }
    const usable = candidate.record.accepts.filter((offer) => offer.network === network);
    if (usable.length === 0) {
      excluded.push({ service_id: candidate.serviceId, gate: "network", detail: "wrong-network" });
      continue;
    }
    const payable = usable.filter(isUsableOffer);
    if (payable.length === 0) {
      excluded.push({
        service_id: candidate.serviceId,
        gate: "offer",
        detail: "no-payable-live-offer",
      });
      continue;
    }
    const affordable = payable.filter(
      (offer) => BigInt(offer.amount) <= BigInt(query.max_price_atomic),
    );
    if (affordable.length === 0) {
      excluded.push({
        service_id: candidate.serviceId,
        gate: "price-over-budget",
        detail: "live-price-exceeds-max",
      });
      continue;
    }
    const cheapest = affordable.reduce((left, right) =>
      BigInt(left.amount) <= BigInt(right.amount) ? left : right,
    );
    eligible.push({ serviceId: candidate.serviceId, amount: BigInt(cheapest.amount) });
  }
  eligible.sort(comparePriceThenId);
  const snapshot = makeSnapshot(services, network, policy);
  const snapshotId = await persistSnapshot(args.pool, snapshot, now(), args.retentionDays);
  const decision: RankingDecision = {
    schemaVersion: "1.1",
    query_id: randomUUID(),
    received_at: now().toISOString(),
    policy_version: policy,
    snapshot_id: snapshotId,
    snapshot_anchor_tx: null,
    query: {
      task: query.capability,
      task_class: query.taskClass,
      constraints: { max_price_atomic: query.max_price_atomic },
      risk_quantile: riskQuantile,
      weights,
    },
    candidates_considered: candidates.length,
    excluded,
    ranked: [],
    unverified: eligible.map(({ serviceId }) => ({
      service_id: serviceId,
      reason: "n_eff_below_min",
      n_eff: 0,
    })),
    missing_dimensions_for_class: [],
    insufficient_evidence: true,
    ...(explorationEnabled && eligible[0]
      ? {
          exploration_slot: {
            service_id: eligible[0].serviceId,
            reason: "no-ranked-candidate" as const,
          },
        }
      : {}),
  };
  return decision;
}

function makeSnapshot(
  services: readonly {
    serviceId: string;
    registration: Registration;
    record: RegisteredRecord | null;
  }[],
  network: string,
  policy: string,
): Record<string, unknown> {
  return {
    kind: "czar-registered-interim-snapshot",
    policy_version: policy,
    network,
    services: services
      .filter((service) => service.record !== null)
      .toSorted((left, right) => compareServiceId(left.serviceId, right.serviceId))
      .map(({ serviceId, registration, record }) => {
        const offer = snapshotOffer(record!.accepts, network);
        return {
          serviceId,
          serviceName: registration.serviceName,
          capabilities: [...registration.capabilities].toSorted(),
          resourceUrl: registration.resource.url,
          method: registration.resource.method,
          payTo: offer.payTo,
          amount: offer.amount,
          scheme: offer.scheme,
          network: offer.network,
          probedAt: record!.probedAt,
        };
      }),
  };
}

function snapshotOffer(
  offers: readonly PaymentRequirements[],
  network: string,
): PaymentRequirements {
  const relevant = offers.filter((offer) => offer.network === network);
  const choices = relevant.length > 0 ? relevant : offers;
  return [...choices].toSorted((left, right) => {
    const amountOrder =
      BigInt(left.amount) < BigInt(right.amount)
        ? -1
        : BigInt(left.amount) > BigInt(right.amount)
          ? 1
          : 0;
    if (amountOrder !== 0) return amountOrder;
    return compareText(left.payTo, right.payTo) || compareText(left.scheme, right.scheme);
  })[0]!;
}

async function persistSnapshot(
  pool: Pool,
  snapshot: Record<string, unknown>,
  usedAt: Date,
  retentionDays: number,
) {
  const bodyJcs = jcsString(snapshot);
  const snapshotId = keccak256(toBytes(bodyJcs));
  if (H(snapshot) !== snapshotId) throw new Error("snapshot canonical hash mismatch");
  const saved = await pool.query<{ body_jcs: string }>(
    `INSERT INTO selection_interim_snapshots (snapshot_id, body_jcs, created_at, last_used_at)
     VALUES ($1, $2, $3, $3)
     ON CONFLICT (snapshot_id) DO UPDATE SET last_used_at = EXCLUDED.last_used_at
     RETURNING body_jcs`,
    [snapshotId, bodyJcs, usedAt],
  );
  const stored = saved.rows[0]?.body_jcs;
  if (stored === undefined || keccak256(toBytes(stored)) !== snapshotId || stored !== bodyJcs)
    throw new Error("stored selection snapshot failed exact-byte verification");
  await pool.query(
    `DELETE FROM selection_interim_snapshots
     WHERE last_used_at < $1::timestamptz - ($2::text || ' days')::interval`,
    [usedAt, retentionDays],
  );
  return snapshotId;
}

function policyVersion(network: string, unverifiedWithApproval: boolean): string {
  const descriptor = {
    policy: "czar-registered-interim",
    scr: "SCR-137",
    network,
    unverifiedWithApproval,
    exploration: "lowest-live-price-then-serviceId",
    ranked: "none",
  };
  return `pol_${H(descriptor).slice(2, 18)}`;
}

function comparePriceThenId(
  left: { serviceId: string; amount: bigint },
  right: { serviceId: string; amount: bigint },
) {
  if (left.amount < right.amount) return -1;
  if (left.amount > right.amount) return 1;
  return compareServiceId(left.serviceId, right.serviceId);
}

function compareServiceId(left: string, right: string): number {
  return compareText(left, right);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isUsableOffer(offer: PaymentRequirements): boolean {
  return (
    offer.scheme === "exact" &&
    offer.asset.toLowerCase() === USDC_ADDRESS.toLowerCase() &&
    offer.extra["siwx"] !== true &&
    offer.extra["siwxOnly"] !== true &&
    offer.extra["paymentFlow"] !== "batch-settlement"
  );
}

function validBareUrl(value: string): boolean {
  if (value.includes("?") || value.includes("#")) return false;
  try {
    const url = new URL(value);
    return url.username === "" && url.password === "" && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

function validProbeInput(value: unknown, method: "GET" | "POST"): value is ProbeInput {
  if (!isObject(value)) return false;
  if (method === "GET")
    return (
      isObject(value["query"]) &&
      Object.values(value["query"]).every(isString) &&
      value["body"] === undefined
    );
  return isObject(value["body"]) && value["query"] === undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
