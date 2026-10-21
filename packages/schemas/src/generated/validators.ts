// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.
import { validateSchema } from "#/validator";
import type { AcceptanceReport, ActivityEvent, CapabilityCard, DemandProofLeaf, DemandProofLeafV2, Envelope, EvidenceBatch, InterviewSubmission, JobBrief, JobRecord, MarketView, ObjectiveSubmission, Objective, PaymentRef, Plan, PocketRecord, ProposedBelief, RankingDecision, Receipt, Reservation, SoulVersionLeaf, Soul, SourceReceipt, SourceScan, StepError, StepResult, TaskSpec } from "./types.ts";

export function validateAcceptanceReport(value: unknown): value is AcceptanceReport {
  return validateSchema("acceptance-report", value);
}

export function validateActivityEvent(value: unknown): value is ActivityEvent {
  return validateSchema("activity-event", value);
}

export function validateCapabilityCard(value: unknown): value is CapabilityCard {
  return validateSchema("capability-card", value);
}

export function validateDemandProofLeaf(value: unknown): value is DemandProofLeaf {
  return validateSchema("demand-proof-leaf", value);
}

export function validateDemandProofLeafV2(value: unknown): value is DemandProofLeafV2 {
  return validateSchema("demand-proof-leaf-v2", value);
}

export function validateEnvelope(value: unknown): value is Envelope {
  return validateSchema("envelope", value);
}

export function validateEvidenceBatch(value: unknown): value is EvidenceBatch {
  return validateSchema("evidence-batch", value);
}

export function validateInterviewSubmission(value: unknown): value is InterviewSubmission {
  return validateSchema("interview-submission", value);
}

export function validateJobBrief(value: unknown): value is JobBrief {
  return validateSchema("job-brief", value);
}

export function validateJobRecord(value: unknown): value is JobRecord {
  return validateSchema("job-record", value);
}

export function validateMarketView(value: unknown): value is MarketView {
  return validateSchema("market-view", value);
}

export function validateObjectiveSubmission(value: unknown): value is ObjectiveSubmission {
  return validateSchema("objective-submission", value);
}

export function validateObjective(value: unknown): value is Objective {
  return validateSchema("objective", value);
}

export function validatePaymentRef(value: unknown): value is PaymentRef {
  return validateSchema("payment-ref", value);
}

export function validatePlan(value: unknown): value is Plan {
  return validateSchema("plan", value);
}

export function validatePocketRecord(value: unknown): value is PocketRecord {
  return validateSchema("pocket-record", value);
}

export function validateProposedBelief(value: unknown): value is ProposedBelief {
  return validateSchema("proposed-belief", value);
}

export function validateRankingDecision(value: unknown): value is RankingDecision {
  return validateSchema("ranking-decision", value);
}

export function validateReceipt(value: unknown): value is Receipt {
  return validateSchema("receipt", value);
}

export function validateReservation(value: unknown): value is Reservation {
  return validateSchema("reservation", value);
}

export function validateSoulVersionLeaf(value: unknown): value is SoulVersionLeaf {
  return validateSchema("soul-version-leaf", value);
}

export function validateSoul(value: unknown): value is Soul {
  return validateSchema("soul", value);
}

export function validateSourceReceipt(value: unknown): value is SourceReceipt {
  return validateSchema("source-receipt", value);
}

export function validateSourceScan(value: unknown): value is SourceScan {
  return validateSchema("source-scan", value);
}

export function validateStepError(value: unknown): value is StepError {
  return validateSchema("step-error", value);
}

export function validateStepResult(value: unknown): value is StepResult {
  return validateSchema("step-result", value);
}

export function validateTaskSpec(value: unknown): value is TaskSpec {
  return validateSchema("task-spec", value);
}
