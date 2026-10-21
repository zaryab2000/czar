import { loadConfig, type Config } from "@czar/config";
import {
  buildTree, callInputsHash, PAYEE_KIND, payeeLeaf, planHash, pocketLeaf,
  taskSpecHash,
} from "@czar/hashing";
import { keccak256, stringToHex } from "viem";
import { route, routingParamsFromConfig } from "#src/router/index";
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
  readonly gatewayVolumeAtomic: bigint;
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
  readonly offer: import("@czar/x402").PaymentRequirements;
  readonly offers: readonly import("@czar/x402").PaymentRequirements[];
  readonly amount: bigint;
  readonly rank: number;
  readonly fromExploration: boolean;
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
  const steps: Step[] = [];
  const leaves: Plan["payeeLeaves"] = [];
  const droppedSteps: NonNullable<Plan["droppedSteps"]>[number][] = [];
  let hasGateway = false;
  let hasExploration = false;
  let jobExpiresMs = input.now.getTime();
  const rankingIds: string[] = [];

  for (const capability of input.capabilities.slice(0, Number(config.get("planner.maxSteps")))) {
    const unpaid = await unpaidStep(capability, steps.length, input, config, ports, hasAgent);
    if (unpaid.step) {
      steps.push(unpaid.step);
      continue;
    }
    if (unpaid.drop) {
      droppedSteps.push({ capability, reason: unpaid.drop });
      continue;
    }
    const result = await selectCandidate(capability, input, config, ports, network);
    rankingIds.push(result.decision.query_id);
    if (!result.selected) continue;
    const planStep = await makePaidStep(
      result.selected, result.alternates, capability, steps.length, input, config, ports, network,
    );
    if (!planStep) continue;
    steps.push(planStep.step);
    leaves.push(...planStep.leaves);
    hasGateway ||= planStep.step.kind === "gateway-nano";
    hasExploration ||= result.selected.fromExploration;
    if (planStep.jobExpiresMs) jobExpiresMs = Math.max(jobExpiresMs, planStep.jobExpiresMs);
  }
  if (steps.length === 0 && droppedSteps.length === 0) return null;
  const hasPocket = steps.some((step) => step.kind === "gateway-nano");
  const pocket = hasPocket ? await ports.pocketKeys.createPocketKey(planId) : undefined;
  if (pocket) leaves.push({ payee: pocket, kind: 4, stepIndex: 4294967295, stepCap: "0" });
  const tree = buildTree(leaves.map((leaf) =>
    leaf.kind === 4
      ? pocketLeaf(leaf.payee as `0x${string}`)
      : payeeLeaf(leaf.payee as `0x${string}`, leaf.kind, leaf.stepIndex, BigInt(leaf.stepCap)),
  ));
  const cap = planCap(steps, hasPocket, config);
  if (input.constraints?.maxTotal !== undefined && cap > BigInt(input.constraints.maxTotal)) return null;
  const maxStepAmount = steps.reduce((max, step) => BigInt(step.stepCap) > max ? BigInt(step.stepCap) : max, 0n);
  const ttlMs = Number(config.get("planner.envelopeTtlHours")) * 3_600_000;
  const expiresAt = new Date(Math.min(
    Math.max(input.now.getTime() + ttlMs, jobExpiresMs),
    input.now.getTime() + 30 * 24 * 3_600_000,
  )).toISOString();
  const partial = {
    schemaVersion: "1.2" as const,
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
    rankingDecisionIds: rankingIds,
    shadow: input.shadow ?? false,
    createdAt: input.now.toISOString(),
    ...(droppedSteps.length ? { droppedSteps } : {}),
    taskSpec: input.taskSpec,
  };
  const hash = planHash({
    ...partial,
    taskSpecHash: taskSpecHash(input.taskSpec),
    steps: steps.map((step) => ({
      stepIndex: step.stepIndex, kind: step.kind,
      ...(step.payee ? { payee: step.payee } : {}),
      ...(step.alternates ? { alternates: step.alternates } : []), unitAmount: step.unitAmount,
      expectedCalls: step.expectedCalls, stepCap: step.stepCap,
      acceptanceProfileId: step.acceptanceProfileId,
      ...(step.serviceId ? { serviceId: step.serviceId } : {}),
      ...(step.fanOut ? { fanOut: step.fanOut } : {}),
      ...(step.callInputs ? { callInputsHash: callInputsHash(step.callInputs) } : {}),
    })),
  });
  const plan = { ...partial, planHash: hash };
  if (!validateSchema("plan", plan)) throw new Error(`Planner created an invalid Plan: ${JSON.stringify(validationErrors("plan"))}`);
  const remaining = BigInt(await ports.allowance.remaining(input.userId, categoryId));
  return { plan, approvalNeeded: BigInt(plan.cap) > remaining ||
    (Boolean(config.get("planner.newPayeeNeedsApproval")) && leaves.length > 0) || hasExploration };
}

async function unpaidStep(
  capability: string,
  index: number,
  input: PlannerRequest,
  config: Config,
  ports: PlannerPorts,
  hasAgent: boolean,
): Promise<{ step?: Step; drop?: "no-agent" }> {
  const locals = config.get("planner.localTemplates") as string[];
  const assistants = config.get("planner.agentAssistCapabilities") as string[];
  const kind = locals.includes(capability) ? "local" : assistants.includes(capability) ? "agent-assist" : null;
  if (!kind) return {};
  if (kind === "agent-assist" && !hasAgent) return { drop: "no-agent" };
  const taskClass = taskClassFor(capability, config);
  return { step: {
    stepIndex: index, stepId: stepIdentifier(input, index), capability, kind,
    unitAmount: "0", expectedCalls: 1, stepCap: "0", routingReason: "unpaid",
    acceptanceProfileId: ports.profiles.profileIdFor(taskClass),
    fanOut: input.taskSpec.subjects.length ? "subjects" : "none",
  } };
}

async function selectCandidate(
  capability: string, input: PlannerRequest, config: Config, ports: PlannerPorts, network: string,
): Promise<{ decision: RankingDecision; selected?: Candidate; alternates: Candidate[] }> {
  const defaultMax = BigInt(Number(config.get("planner.defaultMaxUnitAtomic")));
  const max = input.constraints?.maxTotal === undefined
    ? defaultMax
    : min(BigInt(input.constraints.maxTotal) / BigInt(Math.max(input.capabilities.length, 1)), defaultMax);
  const decision = await ports.ranking.rank({
    taskClass: taskClassFor(capability, config), capability,
    taskSpec: { kind: input.taskSpec.kind, topic: input.taskSpec.topic,
      fields: input.taskSpec.fields, ...(input.taskSpec.output ? { output: input.taskSpec.output } : {}) },
    networks: [network], rails: ["x402-exact", "gateway-batched", "erc8183-job"],
    max_price_atomic: max.toString(), unknown_policy: "exclude",
  });
  const probed: Candidate[] = [];
  const failures: string[] = [];
  for (const [rank, row] of decision.ranked.slice(0, Number(config.get("planner.probeTopK"))).entries()) {
    if (input.excludedServices?.has(row.service_id)) continue;
    const service = await ports.directory.get(row.service_id);
    if (!service || !/^svc_[0-9a-f]{32}$/.test(service.serviceId)) continue;
    const probe = await ports.prober.probe(service.resource);
    if (!probe.ok) { failures.push(probe.reason); continue; }
    const offers = probe.offers.filter((offer) => offer.network === network);
    const offer = offers[0];
    if (!offer) continue;
    const amount = BigInt(offer.amount);
    if (amount > max || (service.extensions.czar.claim.status !== "claimed" &&
      service.accepts.some((old) => old.payTo.toLowerCase() !== offer.payTo.toLowerCase()))) continue;
    probed.push({ service, offer, offers, amount, rank,
      fromExploration: service.extensions.czar.source === "exploration_slot" });
  }
  if (!probed.length && failures.length && failures.every((value) => value === "timeout")) {
    for (const [rank, row] of decision.ranked.slice(0, Number(config.get("planner.probeTopK"))).entries()) {
      if (input.excludedServices?.has(row.service_id)) continue;
      const service = await ports.directory.get(row.service_id);
      const offer = service?.accepts.find((item) => item.network === network);
      if (service && offer && BigInt(offer.amount) <= max) {
        probed.push({ service, offer, offers: [offer], amount: BigInt(offer.amount), rank, fromExploration: false });
      }
    }
  }
  probed.sort((a, b) => a.rank - b.rank);
  const selected = probed[0];
  return { decision, ...(selected ? { selected } : {}), alternates: selected ? probed.slice(1) : [] };
}

async function makePaidStep(
  candidate: Candidate, alternates: readonly Candidate[], capability: string, index: number,
  input: PlannerRequest, config: Config, ports: PlannerPorts, network: string,
): Promise<{ step: Step; leaves: Plan["payeeLeaves"]; jobExpiresMs?: number } | null> {
  const taskClass = taskClassFor(capability, config);
  const profile = ports.profiles.profileIdFor(taskClass);
  const fields = candidate.service.extensions.czar.card["inputFields"];
  const oneStringKey = Array.isArray(fields) && fields.length === 1 &&
    typeof fields[0] === "object" && fields[0] !== null &&
    "name" in fields[0] && "type" in fields[0] && fields[0].type === "string" && typeof fields[0].name === "string"
      ? fields[0].name : null;
  const template = capability === "web-search" ? "{{subject}} {{topic}} {{field}}"
    : capability === "page-extract" ? "{{dep.0.url}}" : null;
  if (!template || !oneStringKey) return null;
  const subjects = input.taskSpec.subjects;
  const callInputs = renderCalls(template, oneStringKey, input.taskSpec);
  const expectedCalls = callInputs.length;
  const decision = route({
    step: { stepIndex: index, stepId: stepIdentifier(input, index), capability, kind: "x402-exact",
      unitAmount: candidate.offer.amount, expectedCalls, stepCap: candidate.offer.amount,
      routingReason: "fallback-planner", acceptanceProfileId: profile },
    offers: candidate.offers, planNetwork: network, unitAmount: candidate.amount,
    expectedCalls, V: input.gatewayVolumeAtomic, supplierIsAgent: candidate.service.providerAddress !== undefined,
    needsAcceptanceBeforePayment: false, eth_gasPrice: input.ethGasPriceWei,
    params: routingParamsFromConfig(config),
  });
  if (!("kind" in decision)) return null;
  const job = decision.kind === "erc8183-job";
  const listedPrice = candidate.service.listedPrice;
  if (job && !listedPrice) return null;
  const selectedOffer = decision.kind === "gateway-nano"
    ? candidate.offers.find((offer) => offer.extra["name"] === "GatewayWalletBatched")
    : candidate.offer;
  if (!job && !selectedOffer) return null;
  const baseAmount = job ? BigInt(listedPrice as string) : BigInt(selectedOffer!.amount);
  const stepCap = job
    ? ceil(baseAmount * BigInt(10_000 + Number(config.get("planner.jobSlackBps"))), 10_000n)
    : min(ceil(baseAmount * BigInt(expectedCalls) * BigInt(10_000 + Number(config.get("planner.stepSlackBps"))), 10_000n), BigInt(Number(config.get("planner.maxStepAtomic"))));
  const paidTo = job ? candidate.service.providerAddress : selectedOffer!.payTo;
  if (!paidTo) return null;
  const altRows = alternates.filter((row) => row.offer.extra["name"] === selectedOffer?.extra["name"] &&
    row.amount * BigInt(expectedCalls) <= stepCap).slice(0, Number(config.get("planner.maxAlternates")));
  const pays = [paidTo, ...altRows.map((row) => job ? row.service.providerAddress : row.offer.payTo).filter((x): x is string => Boolean(x))];
  const kind = job ? PAYEE_KIND.ERC8183_PROVIDER : PAYEE_KIND.X402_PAY_TO;
  const leaves = pays.map((payee) => ({ payee, kind, stepIndex: index, stepCap: stepCap.toString() } as const));
  const step: Step = {
    stepIndex: index, stepId: stepIdentifier(input, index), capability, serviceId: candidate.service.serviceId,
    resource: candidate.service.resource, kind: decision.kind, payee: paidTo,
    ...(pays.length > 1 ? { alternates: pays.slice(1) } : {}),
    unitAmount: baseAmount.toString(), expectedCalls, stepCap: stepCap.toString(),
    routingReason: `${decision.routingReason}${candidate.fromExploration ? "" : ";fallback-planner"}`,
    acceptanceProfileId: profile,
    inputTemplate: { inputKeys: [{ name: oneStringKey, type: "string", maxLength: 1000 }] },
    fanOut: subjects.length ? "subjects" : "none", callInputs,
    ...(job ? { contextNotice: "task-description-only" as const } : {}),
  };
  if (stepCap < baseAmount * BigInt(expectedCalls)) return null;
  const durationMs = Number(candidate.service.jobDurationSeconds ?? 0) * 1000 +
    Number(config.get("acceptance.evaluationWindowSeconds")) * 1000 +
    Number(config.get("payer.jobBudgetWaitHours")) * 3_600_000;
  return { step, leaves, ...(job ? { jobExpiresMs: input.now.getTime() + durationMs } : {}) };
}

function renderCalls(template: string, key: string, task: TaskSpec): NonNullable<Step["callInputs"]> {
  const subjects = task.subjects.length ? task.subjects : [{ label: "" }];
  return subjects.map((subject, subjectIndex) => {
    const input = template.replaceAll("{{subject}}", subject.label).replaceAll("{{topic}}", task.topic)
      .replaceAll("{{field}}", task.fields[0] ?? "").replaceAll("{{fields}}", task.fields.join(", "));
    return { callIndex: subjectIndex, ...(task.subjects.length ? { subjectIndex } : {}),
      input: { [key]: input.trim().slice(0, 1000) } };
  });
}

function planCap(steps: readonly Step[], pocket: boolean, config: Config): bigint {
  const sum = steps.reduce((total, step) => total + BigInt(step.stepCap), 0n);
  const slack = ceil(sum * 12_500n, 10_000n) - sum;
  const pocketGrant = pocket ? BigInt(Number(config.get("payer.pocketGasUnits"))) : 0n;
  return sum + slack + pocketGrant;
}

function categoryFor(capability: string, config: Config): string {
  const mapping = config.get("planner.categoryByCapability") as Record<string, string>;
  return mapping[capability] ?? (capability.startsWith("data-") ? mapping["data-*"] :
    capability.startsWith("image-") ? mapping["image-*"] : mapping["*"]) ?? "general";
}

function taskClassFor(capability: string, config: Config): string {
  const mapping = config.get("planner.capabilityToTaskClass") as Record<string, string>;
  return mapping[capability] ?? capability;
}

function ceil(n: bigint, d: bigint): bigint { return (n + d - 1n) / d; }
function min(a: bigint, b: bigint): bigint { return a < b ? a : b; }

function stepIdentifier(input: PlannerRequest, index: number): string {
  return ulid("stp_", input.now, {
    bytes: (length) => {
      const bytes = Buffer.from(input.random.bytes(length));
      bytes[bytes.length - 1] = ((bytes.at(-1) ?? 0) + index + 1) % 256;
      return bytes;
    },
  });
}
