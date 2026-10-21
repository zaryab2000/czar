// Named hashes (02 §5.2). Each builds the exact preimage object the spec lists and returns H(preimage).
// Inputs are the 02 objects; optional fields left undefined are omitted from the preimage.
import { H, jcs } from "./jcs.ts";
import type { Hash32 } from "./eip712.ts";
import type { TaskSpec } from "@czar/schemas";
import { keccak256 } from "viem";

export const HASH_RULE = "czar-hash-v1";

/** Computes the content-addressed Selection Layer profile id (SCR-122). */
export function profileId(profile: Readonly<Record<string, unknown>>): string {
  const { profile_id: _profileId, ...profileCore } = profile;
  return `prof_${H(profileCore).slice(2, 34)}`;
}

/** Builds the structural key-tree used by shapeHash (02 §5.2, SCR-122). */
export function keyTree(value: unknown): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length ? [keyTree(value[0])] : [];
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, keyTree(item)]),
    );
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return typeof value;
  throw new TypeError(`Unsupported value in shape key-tree: ${typeof value}`);
}

/** Hashes the canonical key-tree of a JSON response body. */
export function shapeHash(bodyText: string): Hash32 {
  const parsed: unknown = JSON.parse(bodyText);
  return keccak256(jcs(keyTree(parsed)));
}

export function taskSpecHash(taskSpec: TaskSpec): Hash32 {
  return H({ hashRule: HASH_RULE, kind: "task-spec", taskSpec });
}

const sortedAscending = (hashes: readonly string[]) =>
  [...hashes].map((h) => h.toLowerCase()).toSorted();

export interface ObservationInput {
  readonly host: string;
  readonly sessionRef: string;
  readonly projectRef: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly toolName?: string;
  readonly summary: string;
  readonly fileRefs?: readonly string[];
  readonly errorClass?: string;
  readonly provenance: unknown;
}

/** Excludes eventId, redaction, durationMs, agentRef, mcp, hostVersion. */
export function observationHash(e: ObservationInput): Hash32 {
  return H({
    hashRule: HASH_RULE,
    kind: "observation",
    host: e.host,
    sessionRef: e.sessionRef,
    projectRef: e.projectRef,
    eventType: e.eventType,
    occurredAt: e.occurredAt,
    toolName: e.toolName,
    summary: e.summary,
    fileRefs: e.fileRefs,
    errorClass: e.errorClass,
    provenance: e.provenance,
  });
}

export interface ObjectiveInput {
  readonly objectiveId: string;
  readonly soulVersionHash: string;
  readonly observationHashes: readonly string[];
  readonly detector: string;
  readonly goal: string;
  readonly capabilities: readonly string[];
  readonly deadline?: string;
  readonly minutesSaved: number;
  readonly hourlyBand: string;
  readonly taskSpecHash: string;
}

/** `observationHashes` sorted ascending; `capabilities` as given; `goal` is the redacted text. */
export function objectiveHash(o: ObjectiveInput): Hash32 {
  return H({
    hashRule: HASH_RULE,
    kind: "objective",
    objectiveId: o.objectiveId,
    soulVersionHash: o.soulVersionHash,
    observationHashes: sortedAscending(o.observationHashes),
    detector: o.detector,
    goal: o.goal,
    capabilities: o.capabilities,
    deadline: o.deadline,
    minutesSaved: o.minutesSaved,
    hourlyBand: o.hourlyBand,
    taskSpecHash: o.taskSpecHash,
  });
}

export interface BeliefInput {
  readonly beliefId: string;
  readonly text: string;
  readonly confidence: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly receipts: readonly string[];
}

/** `sectionHashes[s] = H({section: s, beliefs: [{beliefId, text, confidence, firstSeen, lastSeen, receipts(sorted)}]})`. */
export function sectionHash(section: string, beliefs: readonly BeliefInput[]): Hash32 {
  return H({
    section,
    beliefs: beliefs.map((b) => ({
      beliefId: b.beliefId,
      text: b.text,
      confidence: b.confidence,
      firstSeen: b.firstSeen,
      lastSeen: b.lastSeen,
      receipts: [...b.receipts].toSorted(),
    })),
  });
}

export interface SoulVersionInput {
  readonly version: number;
  readonly compiledAt: string;
  readonly previousHash?: string;
  readonly sections: Readonly<Record<string, readonly BeliefInput[]>>;
}

export function soulVersionHash(s: SoulVersionInput): Hash32 {
  const sectionHashes = Object.fromEntries(
    Object.entries(s.sections).map(([name, beliefs]) => [name, sectionHash(name, beliefs)]),
  );
  return H({
    hashRule: HASH_RULE,
    kind: "soul",
    version: s.version,
    compiledAt: s.compiledAt,
    previousHash: s.previousHash,
    sectionHashes,
  });
}

export interface PlanStepInput {
  readonly stepIndex: number;
  readonly kind: string;
  readonly payee?: string;
  readonly alternates?: readonly string[];
  readonly unitAmount: string;
  readonly expectedCalls: number;
  readonly stepCap: string;
  readonly acceptanceProfileId: string;
  readonly serviceId?: string;
  readonly fanOut?: "none" | "subjects";
  readonly callInputsHash?: string;
}

export interface PlanInput {
  readonly planId: string;
  readonly objectiveHash: string;
  readonly network: string;
  readonly category: string;
  readonly cap: string;
  readonly slackBps: number;
  readonly maxStepAmount: string;
  readonly pocketCapBps: number;
  readonly expiresAt: string;
  readonly payeeRoot: string;
  readonly taskSpecHash: string;
  readonly steps: readonly PlanStepInput[];
}

/** Excludes `resource` URLs and `inputTemplate` (server-only). */
export function planHash(p: PlanInput): Hash32 {
  return H({
    hashRule: HASH_RULE,
    kind: "plan",
    planId: p.planId,
    objectiveHash: p.objectiveHash,
    network: p.network,
    category: p.category,
    cap: p.cap,
    slackBps: p.slackBps,
    maxStepAmount: p.maxStepAmount,
    pocketCapBps: p.pocketCapBps,
    expiresAt: p.expiresAt,
    payeeRoot: p.payeeRoot,
    taskSpecHash: p.taskSpecHash,
    steps: p.steps.map((s) => ({
      stepIndex: s.stepIndex,
      kind: s.kind,
      payee: s.payee,
      alternates: s.alternates,
      unitAmount: s.unitAmount,
      expectedCalls: s.expectedCalls,
      stepCap: s.stepCap,
      acceptanceProfileId: s.acceptanceProfileId,
      serviceId: s.serviceId,
      fanOut: s.fanOut,
      callInputsHash: s.callInputsHash,
    })),
  });
}

/** `callInputsHash = H(callInputs)`; `H` applies JCS exactly once (SCR-120). */
export function callInputsHash(callInputs: readonly unknown[]): Hash32 {
  return H(callInputs);
}

/** `reportHash = keccak256(jcs(AcceptanceReport minus reportHash))`. */
export function reportHash(report: Readonly<Record<string, unknown>>): Hash32 {
  const { reportHash: _omitted, ...rest } = report;
  return H(rest);
}

/** `paymentRefHash = keccak256(jcs(PaymentRef without the ★ fields reservationId and index))` (02 §4.12). */
export function paymentRefHash(ref: Readonly<Record<string, unknown>>): Hash32 {
  const { reservationId: _r, index: _i, ...rest } = ref;
  return H(rest);
}

/** `inputCommit = H({hashRule, kind: "job-input", inputs, inputSalt})` (RV-025). */
export function inputCommit(inputs: Readonly<Record<string, unknown>>, inputSalt: string): Hash32 {
  return H({ hashRule: HASH_RULE, kind: "job-input", inputs, inputSalt });
}

export interface DescriptionInput {
  readonly planHash: string;
  readonly stepIndex: number;
  readonly acceptanceProfileId: string;
  readonly inputCommit: string;
}

export function descriptionHash(d: DescriptionInput): Hash32 {
  return H({
    hashRule: HASH_RULE,
    kind: "job-description",
    planHash: d.planHash,
    stepIndex: d.stepIndex,
    acceptanceProfileId: d.acceptanceProfileId,
    inputCommit: d.inputCommit,
  });
}

/** The ERC-8183 `description` string: `"czar:" + descriptionHash`. */
export const jobDescription = (d: DescriptionInput): string => `czar:${descriptionHash(d)}`;

/** `descriptionHash` from a `JobBrief` (02 §4.21): recompute `inputCommit` first, as the provider does. */
export function descriptionHashFromBrief(brief: {
  readonly planHash: string;
  readonly stepIndex: number;
  readonly acceptanceProfileId: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly inputSalt: string;
}): Hash32 {
  return descriptionHash({
    planHash: brief.planHash,
    stepIndex: brief.stepIndex,
    acceptanceProfileId: brief.acceptanceProfileId,
    inputCommit: inputCommit(brief.inputs, brief.inputSalt),
  });
}
