import { loadConfig, type Config } from "@czar/config";
import {
  buildTree,
  callInputsHash,
  PAYEE_KIND,
  payeeLeaf,
  planHash,
  pocketLeaf,
  taskSpecHash,
  type Hash32,
} from "@czar/hashing";
import { GATEWAY_EXTRA_NAME, USDC_ADDRESS, type PaymentRequirements } from "@czar/x402";
import { keccak256, stringToHex } from "viem";
import { route, routingParamsFromConfig, type RouteDecision } from "#src/router/index";
import { createSafeProber } from "#src/planner/probe";
import type { PlannerPorts, PlannerService } from "#src/planner/ports";
import type { Plan, RankingDecision, Step, TaskSpec } from "@czar/schemas";
import { validateSchema, validationErrors } from "@czar/schemas";
import { ulid, type RandomSource } from "#src/http/ids";

export interface PlannerRequest {
  readonly objectiveId: string;
  readonly objectiveHash: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly goal: string;
  readonly capabilities: readonly string[];
  readonly taskSpec: TaskSpec;
  readonly constraints?: { readonly maxTotal?: string };
  readonly now: Date;
  readonly random: RandomSource;
  readonly ethGasPriceWei: bigint;
  readonly excludedServices?: ReadonlySet<string>;
  readonly shadow?: boolean;
}

export interface PlannerDependencies {
  readonly config?: Config;
  readonly ports: Omit<PlannerPorts, "prober"> & Partial<Pick<PlannerPorts, "prober">>;
}

export interface PlannerBuild {
  readonly plan: Plan;
  readonly approvalNeeded: boolean;
}

interface Candidate {
  readonly service: PlannerService;
  readonly offer?: import("@czar/x402").PaymentRequirements;
  readonly offers: readonly import("@czar/x402").PaymentRequirements[];
  readonly amount: bigint;
  readonly rank: number;
  readonly fromExploration: boolean;
  readonly unprobed?: boolean;
  readonly jobProvider?: boolean;
}

interface PaidStepDraft {
  readonly kind: "paid";
  readonly candidate: Candidate;
  readonly alternates: readonly Candidate[];
  readonly capability: string;
  readonly callInputs: NonNullable<Step["callInputs"]>;
  readonly template?: string;
  readonly oneStringKey?: string;
}

type CollectedEntry = { readonly kind: "unpaid"; readonly step: Step } | PaidStepDraft;

export interface GatewayVolumeEntry {
  readonly kind: "paid" | "job" | "unpaid";
  readonly expectedCalls: number;
  readonly gatewayUnitAmount?: bigint;
}

export function computeObjectiveGatewayVolume(entries: readonly GatewayVolumeEntry[]): bigint {
  let volume = 0n;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.expectedCalls) || entry.expectedCalls < 0)
      throw new RangeError("Gateway volume expectedCalls must be a non-negative safe integer.");
    if (entry.gatewayUnitAmount !== undefined && entry.gatewayUnitAmount < 0n)
      throw new RangeError("Gateway offer amount must be non-negative.");
    if (entry.kind !== "paid" || entry.gatewayUnitAmount === undefined) continue;
    volume += BigInt(entry.expectedCalls) * entry.gatewayUnitAmount;
  }
  return volume;
}

export function createPlanner(dependencies: PlannerDependencies) {
  const config = dependencies.config ?? loadConfig();
  const ports = {
    ...dependencies.ports,
    prober: dependencies.ports.prober ?? createSafeProber(config),
  };
  return {
    async build(input: PlannerRequest): Promise<PlannerBuild | null> {
      return buildPlan(input, config, ports);
    },
  };
}

async function buildPlan(
  input: PlannerRequest,
  config: Config,
  ports: PlannerPorts,
): Promise<PlannerBuild | null> {
  const planId = ulid("pln_", input.now, input.random);
  const network = String(config.get("selection.paymentNetwork"));
  const category = categoryFor(input.capabilities[0] ?? "general", config);
  const categoryId = keccak256(stringToHex(category));
  const hasAgent = await ports.agentHosts.hasAgentHost(input.deviceId);
  const collected = await collectSteps({ input, config, ports, network, hasAgent });
  const { leaves, droppedSteps } = collected;
  const healthByStep = await Promise.all(
    collected.steps.map(async (step) =>
      step.serviceId
        ? ((await ports.health?.openOwnerFacts(input.userId, network, step.serviceId)) ?? [])
        : [],
    ),
  );
  const steps = collected.steps.map((step, index) => {
    if (!step.serviceId || !step.why) return step;
    const health = healthByStep[index]?.length ?? 0;
    const unrated = collected.unratedStepIndices.has(index);
    const explanation = [
      ...(unrated ? [" No ratings yet. Czar will ask before using it."] : []),
      ...(health ? [" A supplier health fact also requires approval."] : []),
    ].join("");
    return { ...step, why: { ...step.why, summary: `${step.why.summary}${explanation}` } };
  });
  const approvalReasons: NonNullable<Plan["approvalReasons"]> = [];
  if (collected.unratedStepIndices.size > 0) approvalReasons.push("unrated");
  if (healthByStep.some((facts) => facts.length > 0)) approvalReasons.push("health-fact");
  if (collected.hasExploration) approvalReasons.push("exploration-slot");
  if (steps.length === 0 && droppedSteps.length === 0) return null;
  const hasPocket = steps.some((step) => step.kind === "gateway-nano");
  const pocket = hasPocket ? await ports.pocketKeys.createPocketKey(planId) : undefined;
  if (pocket) leaves.push({ payee: pocket, kind: 4, stepIndex: 4294967295, stepCap: "0" });
  const tree = buildTree(
    leaves.map((leaf) =>
      leaf.kind === 4
        ? pocketLeaf(leaf.payee as `0x${string}`)
        : payeeLeaf(leaf.payee as `0x${string}`, leaf.kind, leaf.stepIndex, BigInt(leaf.stepCap)),
    ),
  );
  const cap = planCap(steps, hasPocket, config);
  if (input.constraints?.maxTotal !== undefined && cap > BigInt(input.constraints.maxTotal))
    return null;
  const maxStepAmount = steps.reduce(
    (max, step) => (BigInt(step.stepCap) > max ? BigInt(step.stepCap) : max),
    0n,
  );
  const expiresAt = expiry(input.now, collected.jobExpiresMs, config);
  const partial = {
    schemaVersion: "1.3" as const,
    planId,
    objectiveId: input.objectiveId,
    objectiveHash: input.objectiveHash,
    network,
    category,
    cap: cap.toString(),
    slackBps: 2500,
    maxStepAmount: maxStepAmount.toString(),
    pocketCapBps: hasPocket ? 2500 : 0,
    ...(pocket ? { pocket } : {}),
    expiresAt,
    steps,
    payeeLeaves: leaves,
    payeeRoot: tree.root,
    rankingDecisionIds: collected.rankingIds,
    shadow: input.shadow ?? false,
    createdAt: input.now.toISOString(),
    ...(droppedSteps.length ? { droppedSteps } : {}),
    taskSpec: input.taskSpec,
    ...(approvalReasons.length ? { approvalReasons } : {}),
  };
  const hash = recomputePlanHash({ ...partial, planHash: `0x${"0".repeat(64)}` as Hash32 });
  const plan = { ...partial, planHash: hash };
  if (!validateSchema("plan", plan))
    throw new Error(`Planner created an invalid Plan: ${JSON.stringify(validationErrors("plan"))}`);
  const remaining = BigInt(await ports.allowance.remaining(input.userId, categoryId));
  return {
    plan,
    approvalNeeded:
      BigInt(plan.cap) > remaining ||
      (Boolean(config.get("planner.newPayeeNeedsApproval")) && leaves.length > 0) ||
      approvalReasons.length > 0,
  };
}

interface StepCollection {
  readonly steps: Step[];
  readonly leaves: Plan["payeeLeaves"];
  readonly droppedSteps: NonNullable<Plan["droppedSteps"]>;
  readonly rankingIds: string[];
  readonly hasExploration: boolean;
  readonly unratedStepIndices: ReadonlySet<number>;
  readonly jobExpiresMs: number;
}

async function collectSteps(args: {
  readonly input: PlannerRequest;
  readonly config: Config;
  readonly ports: PlannerPorts;
  readonly network: string;
  readonly hasAgent: boolean;
}): Promise<StepCollection> {
  const { input, config, ports, network, hasAgent } = args;
  const entries: CollectedEntry[] = [];
  const droppedSteps: NonNullable<Plan["droppedSteps"]> = [];
  const rankingIds: string[] = [];
  const maximum = Number(config.get("planner.maxSteps"));
  for (const capability of input.capabilities.slice(0, maximum)) {
    const unpaid = await unpaidStep({
      capability,
      index: entries.length,
      input,
      config,
      ports,
      hasAgent,
    });
    if (unpaid.step) {
      entries.push({ kind: "unpaid", step: unpaid.step });
      continue;
    }
    if (unpaid.drop) {
      droppedSteps.push({ capability, reason: unpaid.drop });
      continue;
    }
    const result = await selectCandidate(capability, input, config, ports, network);
    rankingIds.push(result.decision.query_id);
    if (!result.selected) {
      if (capability !== "web-search" && capability !== "page-extract")
        droppedSteps.push({ capability, reason: "no-template" });
      continue;
    }
    if (
      !result.selected.jobProvider &&
      capability !== "web-search" &&
      capability !== "page-extract"
    ) {
      droppedSteps.push({ capability, reason: "no-template" });
      continue;
    }
    const prepared = preparePaidStep(result.selected, capability, input.taskSpec);
    if (!prepared) continue;
    entries.push({
      kind: "paid",
      candidate: result.selected,
      alternates: result.alternates,
      capability,
      ...prepared,
    });
  }
  const gatewayVolumeAtomic = computeGatewayVolume(entries, config);
  const completed = await completeCollectedSteps({
    entries,
    input,
    config,
    ports,
    network,
    gatewayVolumeAtomic,
  });
  return {
    ...completed,
    droppedSteps,
    rankingIds,
  };
}

async function completeCollectedSteps(args: {
  readonly entries: readonly CollectedEntry[];
  readonly input: PlannerRequest;
  readonly config: Config;
  readonly ports: PlannerPorts;
  readonly network: string;
  readonly gatewayVolumeAtomic: bigint;
}): Promise<
  Pick<
    StepCollection,
    "steps" | "leaves" | "hasExploration" | "unratedStepIndices" | "jobExpiresMs"
  >
> {
  const { entries, input, config, ports, network, gatewayVolumeAtomic } = args;
  const steps: Step[] = [];
  const leaves: Plan["payeeLeaves"] = [];
  let hasExploration = false;
  const unratedStepIndices = new Set<number>();
  let jobExpiresMs = input.now.getTime();
  for (const entry of entries) {
    if (entry.kind === "unpaid") {
      const index = steps.length;
      steps.push({ ...entry.step, stepIndex: index, stepId: stepIdentifier(input, index) });
      continue;
    }
    const planStep = await makePaidStep({
      ...entry,
      index: steps.length,
      input,
      config,
      ports,
      network,
      gatewayVolumeAtomic,
    });
    if (!planStep) continue;
    steps.push(planStep.step);
    if (entry.candidate.fromExploration) unratedStepIndices.add(planStep.step.stepIndex);
    leaves.push(...planStep.leaves);
    hasExploration ||= entry.candidate.fromExploration;
    if (planStep.jobExpiresMs) jobExpiresMs = Math.max(jobExpiresMs, planStep.jobExpiresMs);
  }
  return { steps, leaves, hasExploration, unratedStepIndices, jobExpiresMs };
}

function preparePaidStep(
  candidate: Candidate,
  capability: string,
  taskSpec: TaskSpec,
): Omit<PaidStepDraft, "kind" | "candidate" | "alternates" | "capability"> | null {
  const fields = candidate.service.extensions.czar.card["inputFields"];
  const oneStringKey = getSingleStringInput(fields);
  const template =
    capability === "web-search"
      ? "{{subject}} {{topic}} {{field}}"
      : capability === "page-extract"
        ? "{{dep.0.url}}"
        : null;
  const jobCandidate = candidate.jobProvider === true;
  if ((!template || !oneStringKey) && !jobCandidate) return null;
  const callInputs =
    template && oneStringKey
      ? renderCalls(template, oneStringKey, taskSpec)
      : renderJobCalls(taskSpec);
  return {
    callInputs,
    ...(template && oneStringKey ? { template, oneStringKey } : {}),
  };
}

function computeGatewayVolume(entries: readonly CollectedEntry[], config: Config): bigint {
  const jobThreshold = routingParamsFromConfig(config).jobThresholdAtomic;
  const volumeEntries: GatewayVolumeEntry[] = entries.map((entry) => {
    if (entry.kind === "unpaid") return { kind: "unpaid", expectedCalls: entry.step.expectedCalls };
    const job = entry.candidate.jobProvider === true || entry.candidate.amount >= jobThreshold;
    const gatewayOffer =
      !job && !entry.candidate.unprobed
        ? entry.candidate.offers.find(
            (offer) => offer.extra["name"] === GATEWAY_EXTRA_NAME && isUsablePlannerOffer(offer),
          )
        : undefined;
    return {
      kind: job ? "job" : "paid",
      expectedCalls: entry.callInputs.length,
      ...(gatewayOffer ? { gatewayUnitAmount: BigInt(gatewayOffer.amount) } : {}),
    };
  });
  return computeObjectiveGatewayVolume(volumeEntries);
}

function getSingleStringInput(fields: unknown): string | null {
  if (!Array.isArray(fields) || fields.length !== 1) return null;
  const field = fields[0];
  if (
    typeof field !== "object" ||
    field === null ||
    !("name" in field) ||
    !("type" in field) ||
    field.type !== "string" ||
    typeof field.name !== "string"
  )
    return null;
  return field.name;
}

async function unpaidStep(args: {
  readonly capability: string;
  readonly index: number;
  readonly input: PlannerRequest;
  readonly config: Config;
  readonly ports: PlannerPorts;
  readonly hasAgent: boolean;
}): Promise<{ step?: Step; drop?: "no-agent" }> {
  const { capability, index, input, config, ports, hasAgent } = args;
  const locals = config.get("planner.localTemplates") as string[];
  const assistants = config.get("planner.agentAssistCapabilities") as string[];
  const kind = locals.includes(capability)
    ? "local"
    : assistants.includes(capability)
      ? "agent-assist"
      : null;
  if (!kind) return {};
  if (kind === "agent-assist" && !hasAgent) return { drop: "no-agent" };
  const taskClass = taskClassFor(capability, config);
  return {
    step: {
      stepIndex: index,
      stepId: stepIdentifier(input, index),
      capability,
      kind,
      unitAmount: "0",
      expectedCalls: 1,
      stepCap: "0",
      routingReason: "unpaid",
      acceptanceProfileId: ports.profiles.profileIdFor(taskClass),
      ...(kind === "local" ? { inputTemplate: { expectedKeys: input.taskSpec.fields } } : {}),
      fanOut: input.taskSpec.subjects.length ? "subjects" : "none",
    },
  };
}

async function selectCandidate(
  capability: string,
  input: PlannerRequest,
  config: Config,
  ports: PlannerPorts,
  network: string,
): Promise<{ decision: RankingDecision; selected?: Candidate; alternates: Candidate[] }> {
  const defaultMax = BigInt(Number(config.get("planner.defaultMaxUnitAtomic")));
  const max =
    input.constraints?.maxTotal === undefined
      ? defaultMax
      : min(
          BigInt(input.constraints.maxTotal) / BigInt(Math.max(input.capabilities.length, 1)),
          defaultMax,
        );
  const decision = await ports.ranking.rank({
    userId: input.userId,
    taskClass: taskClassFor(capability, config),
    capability,
    taskSpec: {
      kind: input.taskSpec.kind,
      topic: input.taskSpec.topic,
      fields: input.taskSpec.fields,
      ...(input.taskSpec.output ? { output: input.taskSpec.output } : {}),
    },
    networks: [network],
    rails: ["x402-exact", "gateway-batched", "erc8183-job"],
    max_price_atomic: max.toString(),
    unknown_policy: "exclude",
  });
  const topK = Number(config.get("planner.probeTopK"));
  const ranked = decision.ranked.slice(0, topK).map((row) => ({ serviceId: row.service_id }));
  const exploration = decision.exploration_slot?.service_id;
  if (exploration && !ranked.some((row) => row.serviceId === exploration))
    ranked.push({ serviceId: exploration });
  const { candidates, failures } = await probeRanked({
    ranked,
    input,
    ports,
    network,
    max,
    ...(exploration ? { exploration } : {}),
  });
  const probed =
    candidates.length === 0 && failures.length > 0 && failures.every((value) => value === "timeout")
      ? await indexFallback({
          ranked,
          input,
          ports,
          network,
          max,
          ...(exploration ? { exploration } : {}),
        })
      : candidates;
  probed.sort((a, b) => a.rank - b.rank);
  const selected = probed[0];
  return {
    decision,
    ...(selected ? { selected } : {}),
    alternates: selected ? probed.slice(1) : [],
  };
}

const TRUSTED_JOB_CLAIMS: ReadonlySet<string> = new Set(["wallet-verified", "erc8004-claimed"]);

async function probeRanked(args: {
  readonly ranked: readonly { serviceId: string }[];
  readonly input: PlannerRequest;
  readonly ports: PlannerPorts;
  readonly network: string;
  readonly max: bigint;
  readonly exploration?: string;
}): Promise<{ candidates: Candidate[]; failures: string[] }> {
  const { ranked, input, ports, network, max, exploration } = args;
  const candidates: Candidate[] = [];
  const failures: string[] = [];
  for (const [rank, row] of ranked.entries()) {
    if (input.excludedServices?.has(row.serviceId)) continue;
    if (await ports.health?.isInjectionBlocked(network, row.serviceId)) continue;
    const service = await ports.directory.get(row.serviceId);
    if (
      !service ||
      service.serviceId !== row.serviceId ||
      !/^svc_[0-9a-f]{32}$/.test(service.serviceId)
    )
      continue;
    // SCR-121: a job provider's address is trusted only when the provider proved control of it
    // (wallet-verified or ERC-8004 claim) or it is one of Czar's own registered providers.
    const jobProvider =
      service.extensions.czar.card["rail"] === "erc8183-job" &&
      service.providerAddress !== undefined &&
      service.listedPrice !== undefined &&
      (TRUSTED_JOB_CLAIMS.has(service.extensions.czar.claim.status) ||
        service.extensions.czar.source === "czar-registered");
    if (jobProvider) {
      const amount = BigInt(service.listedPrice as string);
      if (amount <= max) {
        candidates.push({
          service,
          offers: [],
          amount,
          rank,
          fromExploration: row.serviceId === exploration,
          jobProvider: true,
        });
      }
      continue;
    }
    const probe = await ports.prober.probe(service.resource, service.probeInput);
    if (!probe.ok) {
      failures.push(probe.reason);
      continue;
    }
    const offers = probe.offers.filter((offer) => offer.network === network);
    const offer = offers.find(isUsablePlannerOffer);
    if (!offer) continue;
    const amount = BigInt(offer.amount);
    if (
      amount > max ||
      (service.extensions.czar.claim.status === "unclaimed" &&
        service.accepts.some((old) => old.payTo.toLowerCase() !== offer.payTo.toLowerCase()))
    )
      continue;
    candidates.push({
      service,
      offer,
      offers,
      amount,
      rank,
      fromExploration: row.serviceId === exploration,
    });
  }
  return { candidates, failures };
}

async function indexFallback(args: {
  readonly ranked: readonly { serviceId: string }[];
  readonly input: PlannerRequest;
  readonly ports: PlannerPorts;
  readonly network: string;
  readonly max: bigint;
  readonly exploration?: string;
}): Promise<Candidate[]> {
  const { ranked, input, ports, network, max, exploration } = args;
  const candidates: Candidate[] = [];
  for (const [rank, row] of ranked.entries()) {
    if (input.excludedServices?.has(row.serviceId)) continue;
    if (await ports.health?.isInjectionBlocked(network, row.serviceId)) continue;
    const service = await ports.directory.get(row.serviceId);
    const offer = service?.accepts.find(
      (item) => item.network === network && isUsablePlannerOffer(item),
    );
    if (!service || service.serviceId !== row.serviceId || !offer || BigInt(offer.amount) > max)
      continue;
    candidates.push({
      service,
      offer,
      offers: [offer],
      amount: BigInt(offer.amount),
      rank,
      fromExploration: row.serviceId === exploration,
      unprobed: true,
    });
  }
  return candidates;
}

async function makePaidStep(args: {
  readonly candidate: Candidate;
  readonly alternates: readonly Candidate[];
  readonly capability: string;
  readonly index: number;
  readonly input: PlannerRequest;
  readonly config: Config;
  readonly ports: PlannerPorts;
  readonly network: string;
  readonly gatewayVolumeAtomic: bigint;
  readonly callInputs: NonNullable<Step["callInputs"]>;
  readonly template?: string;
  readonly oneStringKey?: string;
}): Promise<{ step: Step; leaves: Plan["payeeLeaves"]; jobExpiresMs?: number } | null> {
  const {
    candidate,
    alternates,
    capability,
    index,
    input,
    config,
    ports,
    network,
    gatewayVolumeAtomic,
    callInputs,
    template,
    oneStringKey,
  } = args;
  const taskClass = taskClassFor(capability, config);
  const profile = ports.profiles.profileIdFor(taskClass);
  const subjects = input.taskSpec.subjects;
  const expectedCalls = callInputs.length;
  const decision = routeCandidate({
    candidate,
    capability,
    index,
    input,
    config,
    network,
    profile,
    expectedCalls,
    gatewayVolumeAtomic,
  });
  if (!decision) return null;
  const details = paymentDetails({ decision, candidate, alternates, expectedCalls, index, config });
  if (!details) return null;
  const { job, baseAmount, stepCap, paidTo, pays, leaves } = details;
  const step: Step = {
    stepIndex: index,
    stepId: stepIdentifier(input, index),
    capability,
    serviceId: candidate.service.serviceId,
    resource: candidate.service.resource,
    kind: decision.kind,
    payee: paidTo,
    ...(pays.length > 1 ? { alternates: pays.slice(1) } : {}),
    unitAmount: baseAmount.toString(),
    expectedCalls,
    stepCap: stepCap.toString(),
    routingReason: candidate.unprobed
      ? "unprobed;fallback-planner"
      : `${decision.routingReason};fallback-planner`,
    acceptanceProfileId: profile,
    ...(template && oneStringKey
      ? {
          inputTemplate: {
            [oneStringKey]: template,
            inputKeys: [{ name: oneStringKey, type: "string" as const, maxLength: 1000 }],
          },
        }
      : {}),
    fanOut: subjects.length ? "subjects" : "none",
    callInputs,
    ...(job ? { contextNotice: "task-description-only" as const } : {}),
    why: {
      fills: matchedFields(
        input.taskSpec.fields,
        candidate.service.extensions.czar.card["outputFields"],
      ),
      summary: stepWhy(candidate.service.extensions.czar.evidence, expectedCalls, baseAmount),
      alternativesLost: [],
    },
  };
  const jobExpiresMs = job ? jobExpiry(candidate.service, input.now, config) : undefined;
  return { step, leaves, ...(jobExpiresMs ? { jobExpiresMs } : {}) };
}

function routeCandidate(args: {
  readonly candidate: Candidate;
  readonly capability: string;
  readonly index: number;
  readonly input: PlannerRequest;
  readonly config: Config;
  readonly network: string;
  readonly profile: string;
  readonly expectedCalls: number;
  readonly gatewayVolumeAtomic: bigint;
}): RouteDecision | null {
  const {
    candidate,
    capability,
    index,
    input,
    config,
    network,
    profile,
    expectedCalls,
    gatewayVolumeAtomic,
  } = args;
  const result = route({
    step: {
      stepIndex: index,
      stepId: stepIdentifier(input, index),
      capability,
      kind: "x402-exact",
      unitAmount: candidate.amount.toString(),
      expectedCalls,
      stepCap: candidate.offer?.amount ?? candidate.amount.toString(),
      routingReason: "fallback-planner",
      acceptanceProfileId: profile,
    },
    offers: candidate.offers,
    planNetwork: network,
    unitAmount: candidate.amount,
    expectedCalls,
    V: gatewayVolumeAtomic,
    supplierIsAgent: candidate.jobProvider === true,
    needsAcceptanceBeforePayment: false,
    eth_gasPrice: input.ethGasPriceWei,
    params: routingParamsFromConfig(config),
  });
  return "calls" in result ? result : null;
}

function paymentDetails(args: {
  readonly decision: RouteDecision;
  readonly candidate: Candidate;
  readonly alternates: readonly Candidate[];
  readonly expectedCalls: number;
  readonly index: number;
  readonly config: Config;
}): {
  readonly job: boolean;
  readonly baseAmount: bigint;
  readonly stepCap: bigint;
  readonly paidTo: string;
  readonly pays: string[];
  readonly leaves: Plan["payeeLeaves"];
} | null {
  const { decision, candidate, alternates, expectedCalls, index, config } = args;
  const job = decision.kind === "erc8183-job";
  const listedPrice = candidate.service.listedPrice;
  if (job && listedPrice === undefined) return null;
  const offer =
    decision.kind === "gateway-nano"
      ? candidate.offers.find((item) => item.extra["name"] === GATEWAY_EXTRA_NAME)
      : candidate.offer;
  if (!job && !offer) return null;
  const baseAmount = job ? BigInt(listedPrice as string) : BigInt(offer!.amount);
  const slackBps = Number(config.get(job ? "planner.jobSlackBps" : "planner.stepSlackBps"));
  const amountWithSlack = ceil(
    baseAmount * BigInt(expectedCalls) * BigInt(10_000 + slackBps),
    10_000n,
  );
  const stepCap = job
    ? amountWithSlack
    : min(amountWithSlack, BigInt(Number(config.get("planner.maxStepAtomic"))));
  if (stepCap < baseAmount * BigInt(expectedCalls)) return null;
  const paidTo = job ? candidate.service.providerAddress : offer!.payTo;
  if (!paidTo) return null;
  const matchingAlternates = alternates
    .filter(
      (row) =>
        (row.jobProvider ?? false) === job &&
        (job || row.offer?.extra["name"] === offer?.extra["name"]) &&
        row.amount * BigInt(expectedCalls) <= stepCap,
    )
    .slice(0, Number(config.get("planner.maxAlternates")));
  const pays = [
    paidTo,
    ...matchingAlternates
      .map((row) => (job ? row.service.providerAddress : row.offer?.payTo))
      .filter((value): value is string => Boolean(value)),
  ];
  const kind = job ? PAYEE_KIND.ERC8183_PROVIDER : PAYEE_KIND.X402_PAY_TO;
  const leaves = pays.map(
    (payee) => ({ payee, kind, stepIndex: index, stepCap: stepCap.toString() }) as const,
  );
  return { job, baseAmount, stepCap, paidTo, pays, leaves };
}

function jobExpiry(service: PlannerService, now: Date, config: Config): number {
  return (
    now.getTime() +
    Number(service.jobDurationSeconds ?? 0) * 1000 +
    Number(config.get("acceptance.evaluationWindowSeconds")) * 1000 +
    Number(config.get("payer.jobBudgetWaitHours")) * 3_600_000
  );
}

function renderCalls(
  template: string,
  key: string,
  task: TaskSpec,
): NonNullable<Step["callInputs"]> {
  const subjects = task.subjects.length ? task.subjects : [{ label: "" }];
  return subjects.map((subject, subjectIndex) => {
    const input = template
      .replaceAll("{{subject}}", subject.label)
      .replaceAll("{{topic}}", task.topic)
      .replaceAll("{{field}}", task.fields[0] ?? "")
      .replaceAll("{{fields}}", task.fields.join(", "));
    return {
      callIndex: subjectIndex,
      ...(task.subjects.length ? { subjectIndex } : {}),
      input: { [key]: input.trim().slice(0, 1000) },
    };
  });
}

function renderJobCalls(task: TaskSpec): NonNullable<Step["callInputs"]> {
  if (task.subjects.length === 0) return [{ callIndex: 0, input: {} }];
  return task.subjects.map((_subject, subjectIndex) => ({
    callIndex: subjectIndex,
    subjectIndex,
    input: {},
  }));
}

function planCap(steps: readonly Step[], pocket: boolean, config: Config): bigint {
  const sum = steps.reduce((total, step) => total + BigInt(step.stepCap), 0n);
  const slack = ceil(sum * 12_500n, 10_000n) - sum;
  const pocketGrant = pocket ? BigInt(Number(config.get("payer.pocketGasUnits"))) : 0n;
  return sum + slack + pocketGrant;
}

function expiry(now: Date, jobExpiresMs: number, config: Config): string {
  const baseTtl = Number(config.get("planner.envelopeTtlHours")) * 3_600_000;
  const maxDuration = 30 * 24 * 3_600_000;
  return new Date(
    Math.min(Math.max(now.getTime() + baseTtl, jobExpiresMs), now.getTime() + maxDuration),
  ).toISOString();
}

function categoryFor(capability: string, config: Config): string {
  const mapping = config.get("planner.categoryByCapability") as Record<string, string>;
  return (
    mapping[capability] ??
    (capability.startsWith("data-")
      ? mapping["data-*"]
      : capability.startsWith("image-")
        ? mapping["image-*"]
        : mapping["*"]) ??
    "general"
  );
}

function taskClassFor(capability: string, config: Config): string {
  const mapping = config.get("planner.capabilityToTaskClass") as Record<string, string>;
  return mapping[capability] ?? capability;
}

function matchedFields(fields: readonly string[], outputs: unknown): string[] {
  if (!Array.isArray(outputs)) return [];
  const available = new Set(
    outputs.flatMap((entry) =>
      typeof entry === "object" &&
      entry !== null &&
      "name" in entry &&
      typeof entry.name === "string"
        ? [entry.name.trim().toLowerCase()]
        : [],
    ),
  );
  return fields.filter((field) => available.has(field.trim().toLowerCase()));
}

function isUsablePlannerOffer(offer: PaymentRequirements): boolean {
  return (
    offer.scheme === "exact" &&
    offer.asset.toLowerCase() === USDC_ADDRESS.toLowerCase() &&
    offer.extra["siwx"] !== true &&
    offer.extra["siwxOnly"] !== true &&
    offer.extra["paymentFlow"] !== "batch-settlement"
  );
}

function stepWhy(
  evidence: PlannerService["extensions"]["czar"]["evidence"],
  expectedCalls: number,
  price: bigint,
): string {
  const nEff = evidence?.nEff ?? expectedCalls;
  const delivery = evidence?.deliveryLcb ?? 0;
  return `${nEff} checked calls; delivery at least ${delivery}; ${price} per call`;
}

export function recomputePlanHash(plan: Plan): Hash32 {
  if (!plan.taskSpec) throw new Error("Cannot recompute planHash without the committed TaskSpec.");
  return planHash({
    planId: plan.planId,
    objectiveHash: plan.objectiveHash,
    network: plan.network,
    category: plan.category,
    cap: plan.cap,
    slackBps: plan.slackBps,
    maxStepAmount: plan.maxStepAmount,
    pocketCapBps: plan.pocketCapBps,
    expiresAt: plan.expiresAt,
    payeeRoot: plan.payeeRoot,
    taskSpecHash: taskSpecHash(plan.taskSpec),
    steps: plan.steps.map((step) => ({
      stepIndex: step.stepIndex,
      kind: step.kind,
      ...(step.payee ? { payee: step.payee } : {}),
      ...(step.alternates ? { alternates: step.alternates } : {}),
      unitAmount: step.unitAmount,
      expectedCalls: step.expectedCalls,
      stepCap: step.stepCap,
      acceptanceProfileId: step.acceptanceProfileId,
      ...(step.serviceId ? { serviceId: step.serviceId } : {}),
      ...(step.fanOut ? { fanOut: step.fanOut } : {}),
      ...(step.callInputs ? { callInputsHash: callInputsHash(step.callInputs) } : {}),
    })),
  });
}

function ceil(n: bigint, d: bigint): bigint {
  return (n + d - 1n) / d;
}
function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function stepIdentifier(input: PlannerRequest, index: number): string {
  return ulid("stp_", input.now, {
    bytes: (length) => {
      const bytes = Buffer.from(input.random.bytes(length));
      bytes[bytes.length - 1] = ((bytes.at(-1) ?? 0) + index + 1) % 256;
      return bytes;
    },
  });
}
