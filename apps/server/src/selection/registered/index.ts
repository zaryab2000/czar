import { randomUUID } from "node:crypto";
import { H } from "@czar/hashing";
import type { Config } from "@czar/config";
import type { CapabilityCard, RankingDecision } from "@czar/schemas";
import {
  readPaymentRequired,
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

type CardField = CapabilityCard["inputFields"][number];

/** `CapabilityCard.inputFields`/`outputFields` bounds (02 §4.27). */
const MAX_CARD_FIELDS = 50;
const MAX_CARD_FIELD_NAME = 64;
const CARD_FIELD_TYPES: ReadonlySet<string> = new Set<CardField["type"]>([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
]);

interface RegisteredRecord {
  readonly serviceId: string;
  readonly registration: Registration;
  readonly accepts: readonly PaymentRequirements[];
  readonly outputSchema: Readonly<Record<string, unknown>> | null;
  readonly inputFields: readonly CardField[];
  readonly outputFields: readonly CardField[];
}

interface ProbeOutcome {
  readonly record: RegisteredRecord | null;
  readonly probedAt: string;
}

interface CachedProbe {
  readonly outcome: ProbeOutcome;
  readonly fetchedAt: number;
}

interface SnapshotOffer {
  readonly network: string | null;
  readonly scheme: string | null;
  readonly asset: string | null;
  readonly amount: string;
  readonly payTo: string;
  readonly siwx: boolean;
  readonly siwxOnly: boolean;
  readonly batchSettlement: boolean;
}

type SnapshotProbe =
  | { readonly state: "failed"; readonly probedAt: string }
  | { readonly state: "ok"; readonly probedAt: string; readonly offers: readonly SnapshotOffer[] };

interface SnapshotService {
  readonly serviceId: string;
  readonly serviceName: string;
  readonly capabilities: readonly string[];
  readonly resourceUrl: string;
  readonly method: "GET" | "POST";
  readonly probe: SnapshotProbe;
}

interface InterimPolicyDescriptor {
  readonly policy: "czar-registered-interim";
  readonly scr: "SCR-138";
  readonly network: string;
  readonly usdcAsset: string;
  readonly offerRule: "scheme-exact,asset-usdc,no-siwx,no-siwx-only,no-batch-settlement";
  readonly unverifiedWithApproval: boolean;
  readonly exploration: "lowest-eligible-live-price-then-serviceId";
  readonly ranked: "none";
}

interface InterimSnapshot {
  readonly kind: "czar-registered-interim-snapshot";
  readonly policy_version: string;
  readonly descriptor: InterimPolicyDescriptor;
  readonly network: string;
  readonly services: readonly SnapshotService[];
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
  const probes = new Map<string, CachedProbe>();
  const pending = new Map<string, Promise<ProbeOutcome>>();
  const now = options.now ?? (() => new Date());
  const registrations = readRegistrations(options.config);
  const recrawlMs = Number(options.config.get("selection.registeredRecrawlHours")) * 3600000;
  const timeoutMs = Number(options.config.get("selection.probeTimeoutMs"));
  const network = String(options.config.get("selection.paymentNetwork"));
  const usdcAsset = String(options.config.get("chain.usdcAddress")).toLowerCase();
  const unverifiedWithApproval = Boolean(options.config.get("selection.unverifiedWithApproval"));
  const descriptor = policyDescriptor(network, usdcAsset, unverifiedWithApproval);

  async function getProbe(serviceId: string): Promise<ProbeOutcome | null> {
    const registration = registrations.get(serviceId);
    if (!registration) return null;
    const cached = probes.get(serviceId);
    if (cached && now().getTime() - cached.fetchedAt < recrawlMs) return cached.outcome;
    const active = pending.get(serviceId);
    if (active) return active;
    const request = probe(serviceId, registration, options.safeFetch, timeoutMs, now)
      .then((outcome) => {
        probes.set(serviceId, { outcome, fetchedAt: now().getTime() });
        return outcome;
      })
      .finally(() => pending.delete(serviceId));
    pending.set(serviceId, request);
    return request;
  }

  return {
    directory: {
      async get(serviceId) {
        const outcome = await getProbe(serviceId);
        return outcome?.record ? toPlannerService(outcome.record) : null;
      },
    },
    outputSchema: {
      async forService(serviceId) {
        return (await getProbe(serviceId))?.record?.outputSchema ?? null;
      },
    },
    rank: {
      async rank(query) {
        const services = await Promise.all(
          [...registrations].map(async ([serviceId, registration]) => ({
            serviceId,
            registration,
            outcome: (await getProbe(serviceId))!,
          })),
        );
        return createDecision({
          query,
          services,
          descriptor,
          riskQuantile: 0.05,
          weights: {},
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
): Promise<ProbeOutcome> {
  const probedAt = now().toISOString();
  try {
    const response = await safeFetch(probeUrl(registration), probeOptions(registration, timeoutMs));
    if (
      response.status !== 402 ||
      new URL(response.url).origin !== new URL(registration.resource.url).origin
    )
      return { record: null, probedAt };
    const result = readPaymentRequired({
      status: response.status,
      headers: response.headers,
      body: Buffer.from(response.body).toString("utf8"),
    });
    if (!result.ok || !sameResourcePath(result.resource.url, registration.resource.url))
      return { record: null, probedAt };
    const declared = result.extensions.bazaar?.schema;
    const outputSchema = responseSchema(declared);
    return {
      probedAt,
      record: {
        serviceId,
        registration,
        accepts: result.paymentRequired.accepts,
        outputSchema,
        inputFields: cardFields(
          objectAt(declared, ...declaredInputPath(registration.resource.method), "properties"),
        ),
        outputFields: cardFields(objectAt(outputSchema, "properties")),
      },
    };
  } catch {
    return { record: null, probedAt };
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

/** Where the sanitized Bazaar schema declares the buyer input (02 §12.2, A3-35). */
function declaredInputPath(method: Registration["resource"]["method"]): string[] {
  const location = method === "GET" ? "queryParams" : "body";
  return ["properties", "input", "properties", location];
}

/** `{name, type}` per declared property, descriptions dropped, bounded per 02 §4.27. */
function cardFields(properties: Record<string, unknown> | null): CardField[] {
  const fields: CardField[] = [];
  for (const [name, property] of Object.entries(properties ?? {})) {
    if (fields.length === MAX_CARD_FIELDS) break;
    const type = isObject(property) ? property["type"] : undefined;
    if (name.length > MAX_CARD_FIELD_NAME || !isString(type) || !CARD_FIELD_TYPES.has(type))
      continue;
    fields.push({ name, type: type as CardField["type"] });
  }
  return fields;
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
        card: {
          serviceName: record.registration.serviceName,
          inputFields: record.inputFields,
          outputFields: record.outputFields,
        },
        source: "czar-registered",
      },
    },
  };
}

interface EligibilityResult {
  readonly excluded: RankingDecision["excluded"];
  readonly eligible: readonly { serviceId: string; amount: bigint }[];
  readonly candidatesConsidered: number;
}

async function createDecision(args: {
  readonly query: RankingQuery;
  readonly services: readonly {
    serviceId: string;
    registration: Registration;
    outcome: ProbeOutcome;
  }[];
  readonly descriptor: InterimPolicyDescriptor;
  readonly riskQuantile: number;
  readonly weights: Readonly<Record<string, number>>;
  readonly retentionDays: number;
  readonly pool: Pool;
  readonly now: () => Date;
}): Promise<RankingDecision> {
  const { query, services, descriptor, riskQuantile, weights, now } = args;
  const policy = policyVersion(descriptor);
  const snapshot = makeSnapshot(services, descriptor);
  const eligibility = evaluateSnapshot(
    snapshot.services,
    query,
    descriptor.network,
    descriptor.usdcAsset,
  );
  const snapshotId = await persistSnapshot(args.pool, snapshot, now(), args.retentionDays);
  return {
    schemaVersion: "1.3",
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
    candidates_considered: eligibility.candidatesConsidered,
    excluded: eligibility.excluded,
    ranked: [],
    unverified: eligibility.eligible.map(({ serviceId }) => ({
      service_id: serviceId,
      reason: "n_eff_below_min",
      n_eff: 0,
    })),
    missing_dimensions_for_class: [],
    insufficient_evidence: true,
    ...(descriptor.unverifiedWithApproval && eligibility.eligible[0]
      ? {
          exploration_slot: {
            service_id: eligibility.eligible[0].serviceId,
            reason: "no-ranked-candidate" as const,
          },
        }
      : {}),
  };
}

function makeSnapshot(
  services: readonly {
    serviceId: string;
    registration: Registration;
    outcome: ProbeOutcome;
  }[],
  descriptor: InterimPolicyDescriptor,
): InterimSnapshot {
  return {
    kind: "czar-registered-interim-snapshot",
    policy_version: policyVersion(descriptor),
    descriptor,
    network: descriptor.network,
    services: services
      .toSorted((left, right) => compareServiceId(left.serviceId, right.serviceId))
      .map(({ serviceId, registration, outcome }) => {
        return {
          serviceId,
          serviceName: registration.serviceName,
          capabilities: [...registration.capabilities].toSorted(),
          resourceUrl: registration.resource.url,
          method: registration.resource.method,
          probe: outcome.record
            ? {
                state: "ok" as const,
                probedAt: outcome.probedAt,
                offers: outcome.record.accepts.map(reduceOffer).toSorted(compareSnapshotOffer),
              }
            : { state: "failed" as const, probedAt: outcome.probedAt },
        };
      }),
  };
}

function evaluateSnapshot(
  services: readonly SnapshotService[],
  query: RankingQuery,
  network: string,
  usdcAsset: string,
): EligibilityResult {
  const candidates = services.filter((service) => service.capabilities.includes(query.capability));
  const excluded: RankingDecision["excluded"] = [];
  const eligible: Array<{ serviceId: string; amount: bigint }> = [];
  for (const service of candidates) {
    const result = evaluateService(service, network, usdcAsset, query.max_price_atomic);
    if (result.excluded) excluded.push(result.excluded);
    if (result.eligible) eligible.push(result.eligible);
  }
  eligible.sort(comparePriceThenId);
  return { excluded, eligible, candidatesConsidered: candidates.length };
}

function evaluateService(
  service: SnapshotService,
  network: string,
  usdcAsset: string,
  maxPrice: string,
): {
  excluded?: RankingDecision["excluded"][number];
  eligible?: { serviceId: string; amount: bigint };
} {
  if (service.probe.state === "failed")
    return {
      excluded: {
        service_id: service.serviceId,
        gate: "probe-failed",
        detail: "live-402-unavailable-or-malformed",
      },
    };
  const onNetwork = service.probe.offers.filter((offer) => offer.network === network);
  if (onNetwork.length === 0)
    return {
      excluded: { service_id: service.serviceId, gate: "network", detail: "wrong-network" },
    };
  const usable = onNetwork.filter((offer) => isUsableOffer(offer, usdcAsset));
  if (usable.length === 0)
    return {
      excluded: {
        service_id: service.serviceId,
        gate: "offer",
        detail: "no-payable-live-offer",
      },
    };
  const affordable = usable.filter((offer) => BigInt(offer.amount) <= BigInt(maxPrice));
  if (affordable.length === 0)
    return {
      excluded: {
        service_id: service.serviceId,
        gate: "price-over-budget",
        detail: "live-price-exceeds-max",
      },
    };
  const cheapest = affordable.reduce((left, right) =>
    BigInt(left.amount) <= BigInt(right.amount) ? left : right,
  );
  return { eligible: { serviceId: service.serviceId, amount: BigInt(cheapest.amount) } };
}

function reduceOffer(offer: PaymentRequirements): SnapshotOffer {
  return {
    network: /^eip155:[1-9][0-9]{0,19}$/.test(offer.network) ? offer.network : null,
    scheme: /^[a-z0-9-]{1,32}$/.test(offer.scheme) ? offer.scheme : null,
    asset: /^0x[0-9a-fA-F]{40}$/.test(offer.asset) ? offer.asset.toLowerCase() : null,
    amount: offer.amount,
    payTo: offer.payTo.toLowerCase(),
    siwx: offer.extra["siwx"] === true,
    siwxOnly: offer.extra["siwxOnly"] === true,
    batchSettlement: offer.extra["paymentFlow"] === "batch-settlement",
  };
}

function compareSnapshotOffer(left: SnapshotOffer, right: SnapshotOffer): number {
  for (const [leftValue, rightValue] of [
    [left.network, right.network],
    [left.scheme, right.scheme],
    [left.asset, right.asset],
  ] as const) {
    const order = compareNullableText(leftValue, rightValue);
    if (order !== 0) return order;
  }
  const leftAmount = BigInt(left.amount);
  const rightAmount = BigInt(right.amount);
  if (leftAmount < rightAmount) return -1;
  if (leftAmount > rightAmount) return 1;
  return compareText(left.payTo, right.payTo);
}

function compareNullableText(left: string | null, right: string | null): number {
  if (left === null) return right === null ? 0 : -1;
  if (right === null) return 1;
  return compareText(left, right);
}

async function persistSnapshot(
  pool: Pool,
  snapshot: InterimSnapshot,
  usedAt: Date,
  retentionDays: number,
) {
  if (policyVersion(snapshot.descriptor) !== snapshot.policy_version)
    throw new Error("selection snapshot policy descriptor hash mismatch");
  const bodyJcs = snapshotJcsString(snapshot);
  const snapshotId = keccak256(toBytes(bodyJcs));
  const saved = await pool.query<{ body_jcs: string }>(
    `INSERT INTO selection_interim_snapshots (snapshot_id, body_jcs, created_at, last_used_at)
     VALUES ($1, $2, $3, $3)
     ON CONFLICT (snapshot_id) DO UPDATE SET
       last_used_at = GREATEST(selection_interim_snapshots.last_used_at, EXCLUDED.last_used_at)
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

function policyDescriptor(
  network: string,
  usdcAsset: string,
  unverifiedWithApproval: boolean,
): InterimPolicyDescriptor {
  return {
    policy: "czar-registered-interim",
    scr: "SCR-138",
    network,
    usdcAsset,
    offerRule: "scheme-exact,asset-usdc,no-siwx,no-siwx-only,no-batch-settlement",
    unverifiedWithApproval,
    exploration: "lowest-eligible-live-price-then-serviceId",
    ranked: "none",
  };
}

function policyVersion(descriptor: InterimPolicyDescriptor): string {
  return `pol_${H(descriptor).slice(2, 18)}`;
}

function snapshotJcsString(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(snapshotJcsString).join(",")}]`;
  if (isObject(value)) {
    const entries = Object.entries(value).toSorted(([left], [right]) => compareText(left, right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${snapshotJcsString(item)}`)
      .join(",")}}`;
  }
  throw new TypeError(`unsupported snapshot JCS value: ${typeof value}`);
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

function isUsableOffer(offer: SnapshotOffer, usdcAsset: string): boolean {
  return (
    offer.scheme === "exact" &&
    offer.asset === usdcAsset &&
    !offer.siwx &&
    !offer.siwxOnly &&
    !offer.batchSettlement
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
