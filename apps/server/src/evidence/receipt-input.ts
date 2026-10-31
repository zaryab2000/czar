import { H, NO_RESPONSE_COMMIT, type Hash32 } from "@czar/hashing";
import type { Receipt, StepResult } from "@czar/schemas";
import type { PaymentReceiptInput } from "#src/evidence/receipts";
import type { ExecutionPhaseRow } from "#src/payer/executions";
import type { SettledReceiptContext } from "#src/payer/vault-direct";

export interface AcceptanceReceiptRecord {
  readonly report_hash: string;
  readonly obs_id: string;
  readonly checks: readonly unknown[];
}

export function createReceiptInputFromTrace(
  context: SettledReceiptContext,
  trace: readonly ExecutionPhaseRow[],
  reports: readonly AcceptanceReceiptRecord[],
): PaymentReceiptInput {
  const response = trace.findLast(
    (row) => row.phase === "call.response" && row.payload["index"] === context.index,
  );
  const call =
    response ??
    trace.findLast(
      (row) => row.phase === "call.no-response" && row.payload["index"] === context.index,
    );
  if (!call) throw new Error("Settled call is missing its durable receipt trace.");
  const noResponse = call.phase === "call.no-response";
  const { paymentRef, requestCommit, requirementsHashSeen } = call.payload;
  const responseCommit = noResponse ? NO_RESPONSE_COMMIT : call.payload["responseCommit"];
  const requestSize = call.payload["requestSize"];
  const responseSize = noResponse ? 0 : call.payload["responseSize"];
  if (
    H(paymentRef) !== H(context.paymentRef) ||
    typeof requestCommit !== "string" ||
    typeof responseCommit !== "string" ||
    typeof requirementsHashSeen !== "string" ||
    typeof requestSize !== "number" ||
    typeof responseSize !== "number"
  )
    throw new Error("Settled call receipt trace is incomplete or mismatched.");
  const acceptance = trace.findLast(
    (row) => row.phase === "acceptance.result" && row.payload["index"] === context.index,
  );
  const reportHash = acceptance?.payload["reportHash"];
  const obsId = acceptance?.payload["obsId"];
  if (typeof reportHash !== "string" || typeof obsId !== "string")
    throw new Error("Acceptance report identity is missing for the settled call.");
  const report = reports.find((item) => item.report_hash === reportHash && item.obs_id === obsId);
  if (!report) throw new Error("Acceptance report is missing for the settled call.");
  const result = context.stepResult as StepResult;
  const statusCode = noResponse ? 0 : call.payload["status"];
  const contentType = noResponse ? "" : call.payload["contentType"];
  if (typeof statusCode !== "number" || typeof contentType !== "string")
    throw new Error("Settled call receipt trace has invalid response metadata.");
  if (
    noResponse &&
    (result.status !== "no-response" ||
      result.bodyCommit !== NO_RESPONSE_COMMIT ||
      context.bodyRef !== undefined)
  )
    throw new Error("Settled no-response trace must have no response body.");
  if (noResponse && !("verifiedTransferTx" in context))
    throw new Error("Settled no-response trace is missing verified transfer evidence.");
  const originAsserted = result.source.origin;
  const tRequest = unixSeconds(context.requestedAt);
  const tPaymentSigned = unixSeconds(context.signedAt);
  const tComplete = unixSeconds(call.at);
  const outcome = result.status;
  const attestation = {
    requestCommit: requestCommit as Hash32,
    responseCommit: responseCommit as Hash32,
    statusCode,
    originAsserted,
    requirementsHashSeen: requirementsHashSeen as Hash32,
    tRequest: BigInt(tRequest),
    tPaymentSigned: BigInt(tPaymentSigned),
    tComplete: BigInt(tComplete),
    outcome: receiptOutcomeCode(outcome),
    localChecksCommit: H(report.checks),
    disclosure: 2,
    createdAt: BigInt(tComplete),
  };
  return {
    state: "settled",
    payment: context.paymentRef,
    reportHashes: reports.map((item) => item.report_hash),
    profileId: context.input.step.acceptanceProfileId,
    envelopeRef: context.input.envelopeRef,
    stepIndex: context.input.step.stepIndex,
    obsId: report.obs_id,
    reporterId: "czar",
    originAsserted,
    requestSize,
    responseSize,
    mimeType: contentType,
    outcome,
    disclosure: "hash-only",
    attestation,
    ...(context.bodyRef === undefined ? {} : { bodyRef: context.bodyRef }),
    ...(noResponse && "verifiedTransferTx" in context
      ? { verifiedTransferTx: context.verifiedTransferTx }
      : {}),
  };
}

function unixSeconds(value: Date): number {
  const seconds = Math.floor(value.getTime() / 1000);
  if (!Number.isSafeInteger(seconds) || seconds < 0)
    throw new RangeError("Receipt timestamp must be a non-negative Unix second.");
  return seconds;
}

function receiptOutcomeCode(outcome: Receipt["outcome"]): number {
  const values: Readonly<Record<Receipt["outcome"], number>> = {
    delivered: 0,
    "http-error": 1,
    timeout: 2,
    "no-response": 3,
    unknown: 4,
    skipped: 5,
  };
  return values[outcome];
}
