import type { Config } from "@czar/config";
import {
  derivedNonce,
  PAYEE_KIND,
  payeeLeaf,
  buildTree,
  verifyProof,
  type Hash32,
} from "@czar/hashing";
import type { PaymentRef, Plan, Step } from "@czar/schemas";
import type { Signer } from "@czar/signer";
import {
  buildExactPaymentPayload,
  encodePaymentSignature,
  readPaymentRequired,
  readSettlement,
  selectOffer,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
} from "@czar/x402";
import type { SafeFetch, SafeFetchOptions, SafeFetchResponse } from "@czar/x402";
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { keccak256, type Hex } from "viem";
import {
  acquireExecutorLease,
  appendExecutionPhase,
  getExecutionTrace,
  markStepDone,
  markStepFailed,
  markStepHandedOff,
  releaseExecutorLease,
  startExecutorLeaseRenewal,
  type ExecutionPhaseRow,
} from "#src/payer/executions";
import { MAX_AUTHORIZATIONS_PER_RESERVATION } from "#src/router/index";

export const FINALIZE_CHUNK = 32;

export interface VaultDirectInput {
  readonly planId: string;
  readonly envelopeRef: string;
  readonly envelopeId: bigint;
  readonly envelopeExpiresAt: Date;
  readonly vault: `0x${string}`;
  readonly plan: Plan;
  readonly step: Step;
  readonly userId: string;
  readonly deviceId: string;
  readonly acceptedDependencies?: readonly DependencyResult[];
  readonly attempt?: number;
  readonly workerId?: string;
}

export interface DependencyResult {
  readonly stepIndex: number;
  readonly subjectIndex?: number;
  readonly accepted: boolean;
  readonly fields: readonly { readonly name: string; readonly value: string }[];
}

export interface VaultDirectDependencies {
  readonly pool: Pool;
  readonly config: Config;
  readonly signer: Pick<Signer, "sign">;
  readonly chain: VaultDirectChain;
  readonly safeFetch: SafeFetch;
  readonly now: () => Date;
  readonly boundary: (input: BoundaryInput) => Promise<unknown>;
  readonly recordReceipt: (input: SettledReceiptContext) => Promise<void>;
  readonly objects: {
    put(bytes: Uint8Array): Promise<string>;
    get(ref: string): Promise<Uint8Array>;
  };
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly assertLeaseHeld?: () => void;
}

export interface VaultDirectChain {
  reserve(
    input: ReserveInput & { readonly signedTransaction: Hex },
  ): Promise<{ readonly reservationId: bigint; readonly txHash: string }>;
  settle(input: {
    readonly signedTransaction: Hex;
    readonly reservationId: bigint;
    readonly indices: readonly number[];
  }): Promise<string>;
  authorizationState(input: {
    readonly reservationId: bigint;
    readonly index: number;
  }): Promise<boolean>;
  isSettled(input: { readonly reservationId: bigint; readonly index: number }): Promise<boolean>;
  finalize(input: {
    readonly signedTransaction: Hex;
    readonly reservationId: bigint;
    readonly start: number;
    readonly count: number;
  }): Promise<{
    readonly txHash: string;
    readonly final: boolean;
  }>;
  reservationFromTransaction?(txHash: string): Promise<bigint | undefined>;
  reservationFinal?(reservationId: bigint): Promise<boolean>;
}

export interface ReserveInput {
  readonly envelopeId: bigint;
  readonly stepIndex: number;
  readonly payee: `0x${string}`;
  readonly stepCap: bigint;
  readonly proof: readonly Hash32[];
  readonly unitAmount: bigint;
  readonly count: number;
  readonly validBefore: bigint;
}

export interface BoundaryInput {
  readonly response: SafeFetchResponse;
  readonly bodyRef: string;
  readonly input: VaultDirectInput;
  readonly paymentRef: PaymentRef;
  readonly paymentPayload: PaymentPayload;
  readonly index: number;
  readonly requestedAt: Date;
  readonly signedAt: Date;
  readonly maxTimeoutSeconds: number;
}

export interface SettledReceiptContext extends BoundaryInput {
  readonly stepResult: unknown;
}

export type VaultDirectResult =
  | { readonly state: "handed_off"; readonly assembly: readonly AssemblyEntry[] }
  | { readonly state: "done"; readonly stepResults: readonly unknown[] }
  | { readonly state: "failed"; readonly errorCode: string };

export interface AssemblyEntry {
  readonly stepIndex: number;
  readonly subjectIndex?: number;
  readonly accepted: boolean;
  readonly fields: readonly { readonly name: string; readonly value: string }[];
}

export async function executeVaultDirectStep(
  input: VaultDirectInput,
  dependencies: VaultDirectDependencies,
): Promise<VaultDirectResult> {
  const workerId = input.workerId ?? randomUUID();
  const ttlSeconds = Number(dependencies.config.get("payer.leaseSeconds"));
  const acquired = await acquireExecutorLease(
    dependencies.pool,
    input.envelopeRef,
    workerId,
    ttlSeconds,
    dependencies.now,
  );
  if (!acquired) return { state: "failed", errorCode: "executor-lease-held" };
  const renewal = startExecutorLeaseRenewal(
    dependencies.pool,
    input.envelopeRef,
    workerId,
    ttlSeconds,
    dependencies.now,
  );
  try {
    return await executeStep(input, { ...dependencies, assertLeaseHeld: renewal.assertHeld });
  } finally {
    await renewal.stop();
    await releaseExecutorLease(dependencies.pool, input.envelopeRef, workerId);
  }
}

async function executeStep(
  input: VaultDirectInput,
  dependencies: VaultDirectDependencies,
): Promise<VaultDirectResult> {
  if (input.step.kind === "local" || input.step.kind === "agent-assist") {
    await markStepHandedOff(dependencies.pool, input.planId, input.step.stepIndex);
    return { state: "handed_off", assembly: input.acceptedDependencies ?? [] };
  }
  if (input.step.kind !== "x402-exact")
    return { state: "failed", errorCode: "unsupported-step-kind" };
  const usage = await remainingExpectedCalls(
    dependencies.pool,
    input.planId,
    input.step.stepIndex,
    input.step.expectedCalls,
  );
  if (usage.remaining === 0) return { state: "done", stepResults: [] };
  const executionInput = {
    ...input,
    step: {
      ...input.step,
      expectedCalls: usage.remaining,
      ...(input.step.callInputs === undefined
        ? {}
        : { callInputs: input.step.callInputs.slice(usage.used) }),
    },
  };
  const attempt = input.attempt ?? 0;
  const trace = await getExecutionTrace(
    dependencies.pool,
    input.planId,
    input.step.stepIndex,
    attempt,
  );
  const prechecked = await precheckCalls(executionInput, dependencies);
  if (prechecked.errorCode) {
    await markStepFailed(dependencies.pool, {
      planId: input.planId,
      stepIndex: input.step.stepIndex,
      attempt,
      errorCode: prechecked.errorCode,
    });
    return { state: "failed", errorCode: prechecked.errorCode };
  }
  return executeReservedCalls(executionInput, dependencies, prechecked.calls, trace, usage.used);
}

async function remainingExpectedCalls(
  pool: Pool,
  planId: string,
  stepIndex: number,
  expectedCalls: number,
): Promise<{ readonly used: number; readonly remaining: number }> {
  const result = await pool.query<{ calls_used: number }>(
    "SELECT calls_used FROM steps WHERE plan_id=$1 AND step_index=$2",
    [planId, stepIndex],
  );
  const used = result.rows[0]?.calls_used;
  if (used === undefined) throw new Error("Payer step is missing from the steps table.");
  return { used, remaining: Math.max(0, expectedCalls - used) };
}

interface PreparedCall {
  readonly index: number;
  readonly request: RenderedRequest;
  readonly offer: PaymentRequirements;
  readonly paymentRequired: PaymentRequired;
  readonly paymentIdentifier?: { readonly required: boolean };
  readonly resource: {
    readonly url: string;
    readonly description?: string;
    readonly mimeType?: string;
  };
}

interface RenderedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
}

async function precheckCalls(input: VaultDirectInput, dependencies: VaultDirectDependencies) {
  const calls = input.step.callInputs ?? [];
  const prepared: PreparedCall[] = [];
  const maxCount = Math.min(
    input.step.expectedCalls,
    calls.length,
    MAX_AUTHORIZATIONS_PER_RESERVATION,
  );
  for (let index = 0; index < maxCount; index += 1) {
    const call = calls[index];
    if (!call) continue;
    const request = renderRequest(input, call.input, call.subjectIndex);
    if (!request) return { calls: prepared, errorCode: "dependency-missing" };
    dependencies.assertLeaseHeld?.();
    const response = await dependencies.safeFetch(
      request.url,
      requestOptions(request, Number(dependencies.config.get("payer.callTimeoutMs"))),
    );
    if (response.status !== 402) return { calls: prepared, errorCode: "unsupported-offer" };
    const read = readPaymentRequired({
      status: response.status,
      headers: response.headers,
      body: new TextDecoder().decode(response.body),
    });
    if (!read.ok) return { calls: prepared, errorCode: "unsupported-offer" };
    const choice = selectOffer(read.paymentRequired, {
      network: input.plan.network,
      rail: "vault-direct",
      stepCap: BigInt(input.step.stepCap),
      payees: [input.step.payee, ...(input.step.alternates ?? [])].filter(isAddress),
      trustedPayees: [],
    });
    if (!choice.ok || BigInt(choice.offer.amount) > BigInt(input.step.stepCap) / BigInt(maxCount))
      return { calls: prepared, errorCode: "price-or-payee-drift" };
    const firstOffer = prepared[0]?.offer;
    if (
      firstOffer &&
      (firstOffer.payTo.toLowerCase() !== choice.offer.payTo.toLowerCase() ||
        firstOffer.amount !== choice.offer.amount)
    )
      return { calls: prepared, errorCode: "price-or-payee-drift" };
    prepared.push({
      index,
      request,
      offer: choice.offer,
      paymentRequired: read.paymentRequired,
      ...(read.extensions.paymentIdentifier === undefined
        ? {}
        : { paymentIdentifier: read.extensions.paymentIdentifier }),
      resource: read.resource,
    });
  }
  return { calls: prepared, errorCode: prepared.length === 0 ? "unsupported-offer" : undefined };
}

async function executeReservedCalls(
  input: VaultDirectInput,
  dependencies: VaultDirectDependencies,
  calls: readonly PreparedCall[],
  trace: readonly ExecutionPhaseRow[],
  callsUsedBefore: number,
): Promise<VaultDirectResult> {
  const first = calls[0];
  if (!first) return { state: "failed", errorCode: "unsupported-offer" };
  // On resume, the reservation's own arguments win over a fresh probe and the current clock:
  // authorizations must carry the reserved payee, unit amount and validBefore (CZ-15 §5.2 crash table).
  const stored = storedReservationArgs(trace);
  const payee = stored?.payee ?? (first.offer.payTo as `0x${string}`);
  const amount = stored?.unitAmount ?? BigInt(first.offer.amount);
  const count =
    stored?.count ??
    Math.min(
      calls.length,
      input.step.expectedCalls,
      Number(BigInt(input.step.stepCap) / amount),
      MAX_AUTHORIZATIONS_PER_RESERVATION,
    );
  const validBefore =
    stored?.validBefore ?? reservationExpiry(input, dependencies, first.offer.maxTimeoutSeconds);
  const proof = buildPayeeProof(input, payee);
  const attempt = input.attempt ?? 0;
  const existingReservation = await findOrCreateReservation(
    input,
    dependencies,
    trace,
    payee,
    amount,
    count,
    validBefore,
    proof,
    attempt,
  );
  if (existingReservation === undefined) return { state: "failed", errorCode: "reserve-pending" };
  return settleAndFinalize(
    input,
    dependencies,
    calls.slice(0, count),
    existingReservation,
    validBefore,
    amount,
    attempt,
    trace,
    callsUsedBefore,
  );
}

async function findOrCreateReservation(
  input: VaultDirectInput,
  dependencies: VaultDirectDependencies,
  trace: readonly ExecutionPhaseRow[],
  payee: `0x${string}`,
  amount: bigint,
  count: number,
  validBefore: bigint,
  proof: readonly Hash32[],
  attempt: number,
): Promise<bigint | undefined> {
  const mined = trace.findLast((row) => row.phase === "reserve.mined");
  if (mined) return BigInt(String(mined.payload["reservationId"]));
  const sent = trace.findLast((row) => row.phase === "reserve.sent");
  if (sent) {
    const txHash = sent.payload["txHash"];
    if (typeof txHash !== "string") return undefined;
    const existing = await dependencies.chain.reservationFromTransaction?.(txHash);
    if (existing !== undefined) return existing;
    const savedTransaction = sent.payload["signedTransaction"];
    if (typeof savedTransaction !== "string") return undefined;
    const reservation = await submitReserve(
      input,
      dependencies,
      {
        envelopeId: input.envelopeId,
        stepIndex: input.step.stepIndex,
        payee,
        stepCap: BigInt(input.step.stepCap),
        proof,
        unitAmount: amount,
        count,
        validBefore,
        signedTransaction: savedTransaction as Hex,
      },
      attempt,
      false,
    );
    return reservation.reservationId;
  }
  const reserveArgs = {
    envelopeId: input.envelopeId.toString(),
    stepIndex: String(input.step.stepIndex),
    payee,
    stepCap: input.step.stepCap,
    proof,
    unitAmount: amount.toString(),
    count: String(count),
    validBefore: validBefore.toString(),
  };
  const signedTransaction = await signVaultCall(dependencies, input.vault, "reserve", reserveArgs);
  return (
    await submitReserve(
      input,
      dependencies,
      {
        envelopeId: input.envelopeId,
        stepIndex: input.step.stepIndex,
        payee,
        stepCap: BigInt(input.step.stepCap),
        proof,
        unitAmount: amount,
        count,
        validBefore,
        signedTransaction,
      },
      attempt,
      true,
    )
  ).reservationId;
}

async function submitReserve(
  input: VaultDirectInput,
  dependencies: VaultDirectDependencies,
  reserve: ReserveInput & { readonly signedTransaction: Hex },
  attempt: number,
  recordSent: boolean,
): Promise<{ readonly reservationId: bigint; readonly txHash: string }> {
  dependencies.assertLeaseHeld?.();
  if (recordSent)
    await appendExecutionPhase(dependencies.pool, {
      planId: input.planId,
      stepIndex: input.step.stepIndex,
      attempt,
      phase: "reserve.sent",
      payload: {
        count: reserve.count,
        payee: reserve.payee,
        unitAmount: reserve.unitAmount.toString(),
        validBefore: reserve.validBefore.toString(),
        txHash: keccak256(reserve.signedTransaction),
        signedTransaction: reserve.signedTransaction,
      },
    });
  const reservation = await dependencies.chain.reserve(reserve);
  await appendExecutionPhase(dependencies.pool, {
    planId: input.planId,
    stepIndex: input.step.stepIndex,
    attempt,
    phase: "reserve.mined",
    payload: {
      reservationId: reservation.reservationId.toString(),
      validBefore: Number(reserve.validBefore),
      txHash: reservation.txHash,
    },
  });
  return reservation;
}

async function settleAndFinalize(
  input: VaultDirectInput,
  dependencies: VaultDirectDependencies,
  calls: readonly PreparedCall[],
  reservationId: bigint,
  validBefore: bigint,
  amount: bigint,
  attempt: number,
  trace: readonly ExecutionPhaseRow[],
  callsUsedBefore: number,
): Promise<VaultDirectResult> {
  const completed: {
    index: number;
    response: SafeFetchResponse;
    bodyRef: string;
    payload: PaymentPayload;
    paymentRef: PaymentRef;
    requestedAt: Date;
    signedAt: Date;
    maxTimeoutSeconds: number;
  }[] = [];
  for (const call of calls) {
    const result = await authorizeAndCall(
      input,
      dependencies,
      call,
      reservationId,
      validBefore,
      amount,
      attempt,
      trace,
    );
    if (result.response)
      completed.push({ ...result.response, maxTimeoutSeconds: call.offer.maxTimeoutSeconds });
    else if (result.errorCode) {
      await appendExecutionPhase(dependencies.pool, {
        planId: input.planId,
        stepIndex: input.step.stepIndex,
        attempt,
        phase: "call.unpaid",
        payload: { index: call.index, errorCode: result.errorCode },
      });
    }
  }
  const results: unknown[] = [];
  const authorized: number[] = [];
  for (const entry of completed) {
    const authorizationUsed = await waitForAuthorization(
      dependencies,
      reservationId,
      entry.index,
      validBefore,
    );
    if (!authorizationUsed) continue;
    authorized.push(entry.index);
  }
  const unsettled: number[] = [];
  for (const index of authorized) {
    if (!(await dependencies.chain.isSettled({ reservationId, index }))) unsettled.push(index);
  }
  for (const batch of chunks(unsettled, Number(dependencies.config.get("payer.settleBatchMax")))) {
    const signedTransaction = await signVaultCall(dependencies, input.vault, "settle", {
      reservationId: reservationId.toString(),
      indices: batch.map(String),
    });
    dependencies.assertLeaseHeld?.();
    await appendExecutionPhase(dependencies.pool, {
      planId: input.planId,
      stepIndex: input.step.stepIndex,
      attempt,
      phase: "settle.sent",
      payload: { indices: batch, txHash: keccak256(signedTransaction) },
    });
    await dependencies.chain.settle({ reservationId, indices: batch, signedTransaction });
    await appendExecutionPhase(dependencies.pool, {
      planId: input.planId,
      stepIndex: input.step.stepIndex,
      attempt,
      phase: "settle.mined",
      payload: { indices: batch },
    });
  }
  for (const entry of completed) {
    if (!authorized.includes(entry.index)) continue;
    const context = {
      response: entry.response,
      bodyRef: entry.bodyRef,
      input,
      paymentRef: entry.paymentRef,
      paymentPayload: entry.payload,
      index: entry.index,
      requestedAt: entry.requestedAt,
      signedAt: entry.signedAt,
      maxTimeoutSeconds: entry.maxTimeoutSeconds,
    };
    const stepResult = await dependencies.boundary(context);
    results.push(stepResult);
    if (await dependencies.chain.isSettled({ reservationId, index: entry.index }))
      await dependencies.recordReceipt({ ...context, stepResult });
  }
  let start = 0;
  let final = false;
  const finalizeCount = FINALIZE_CHUNK;
  if (dependencies.chain.reservationFinal)
    final = await dependencies.chain.reservationFinal(reservationId);
  if (!final) await waitUntilValidBefore(dependencies, validBefore);
  while (!final) {
    const signedTransaction = await signVaultCall(dependencies, input.vault, "finalize", {
      reservationId: reservationId.toString(),
      fromIndex: String(start),
      toIndex: String(start + finalizeCount),
    });
    dependencies.assertLeaseHeld?.();
    await appendExecutionPhase(dependencies.pool, {
      planId: input.planId,
      stepIndex: input.step.stepIndex,
      attempt,
      phase: "finalize.sent",
      payload: { start, count: finalizeCount, txHash: keccak256(signedTransaction) },
    });
    const finalized = await dependencies.chain.finalize({
      reservationId,
      start,
      count: finalizeCount,
      signedTransaction,
    });
    await appendExecutionPhase(dependencies.pool, {
      planId: input.planId,
      stepIndex: input.step.stepIndex,
      attempt,
      phase: "finalize.mined",
      payload: { start, count: finalizeCount, txHash: finalized.txHash },
    });
    final = finalized.final;
    start += finalizeCount;
  }
  if (authorized.length !== calls.length) {
    await markStepFailed(dependencies.pool, {
      planId: input.planId,
      stepIndex: input.step.stepIndex,
      attempt,
      errorCode: "unpaid-index",
    });
    return { state: "failed", errorCode: "unpaid-index" };
  }
  await markStepDone(dependencies.pool, {
    planId: input.planId,
    stepIndex: input.step.stepIndex,
    attempt,
    callsUsed: callsUsedBefore + authorized.length,
  });
  return { state: "done", stepResults: results };
}

async function waitUntilValidBefore(
  dependencies: VaultDirectDependencies,
  validBefore: bigint,
): Promise<void> {
  const pollMs = Number(dependencies.config.get("payer.reconcileSeconds")) * 1000;
  while (Math.floor(dependencies.now().getTime() / 1000) < Number(validBefore)) {
    const remainingMs = Number(validBefore) * 1000 - dependencies.now().getTime();
    await (dependencies.sleep ?? delay)(Math.min(pollMs, remainingMs));
  }
}

async function signVaultCall(
  dependencies: VaultDirectDependencies,
  vault: `0x${string}`,
  selector: string,
  args: Readonly<Record<string, unknown>>,
): Promise<Hex> {
  dependencies.assertLeaseHeld?.();
  const signed = await dependencies.signer.sign("cz-15", {
    keyId: "K3",
    kind: "vault-call",
    payload: { vault, selector, args },
  });
  if (!("signedTransaction" in signed))
    throw new Error("K3 did not return a signed vault transaction.");
  return signed.signedTransaction;
}

async function authorizeAndCall(
  input: VaultDirectInput,
  dependencies: VaultDirectDependencies,
  call: PreparedCall,
  reservationId: bigint,
  validBefore: bigint,
  amount: bigint,
  attempt: number,
  trace: readonly ExecutionPhaseRow[],
) {
  const priorResult = trace.findLast(
    (row) => row.phase === "call.result" && row.payload["index"] === call.index,
  );
  if (priorResult) return restoreCallResult(dependencies, priorResult, call.request.url);
  const priorUnpaid = trace.findLast(
    (row) => row.phase === "call.unpaid" && row.payload["index"] === call.index,
  );
  if (priorUnpaid) return { errorCode: String(priorUnpaid.payload["errorCode"] ?? "unpaid") };
  const nonce = derivedNonce(input.vault, reservationId, call.index);
  const signedAt = dependencies.now();
  const savedAuth = trace.findLast(
    (row) => row.phase === "auth.signed" && row.payload["index"] === call.index,
  );
  const storedPayload = savedAuth?.payload["paymentPayload"];
  let payload: PaymentPayload;
  let paymentSignature: string | undefined;
  if (storedPayload && typeof storedPayload === "object") {
    payload = storedPayload as PaymentPayload;
    const storedSignature = savedAuth?.payload["paymentSignature"];
    if (typeof storedSignature === "string") paymentSignature = storedSignature;
  } else if (savedAuth) {
    throw new Error("Stored signed payment payload is invalid.");
  } else {
    const signed = await dependencies.signer.sign("cz-15", {
      keyId: "K3",
      kind: "usdc-3009",
      payload: {
        vault: input.vault,
        reservationId: reservationId.toString(),
        index: String(call.index),
        to: call.offer.payTo,
        value: amount.toString(),
        validBefore: validBefore.toString(),
      },
    });
    if (!("signature" in signed)) throw new Error("K3 did not return a USDC_3009 signature.");
    payload = buildExactPaymentPayload({
      resource: call.resource,
      accepted: call.offer,
      authorization: {
        from: input.vault,
        to: call.offer.payTo,
        value: amount.toString(),
        validAfter: "0",
        validBefore: validBefore.toString(),
        nonce,
      },
      signature: signed.signature,
      ...(call.paymentIdentifier ? { paymentId: randomUUID().replaceAll("-", "") } : {}),
      ...(call.paymentIdentifier ? { advertised: call.paymentIdentifier } : {}),
    });
    paymentSignature = encodePaymentSignature(payload);
    await appendExecutionPhase(dependencies.pool, {
      planId: input.planId,
      stepIndex: input.step.stepIndex,
      attempt,
      phase: "auth.signed",
      payload: { index: call.index, paymentPayload: payload, paymentSignature },
    });
  }
  paymentSignature ??= encodePaymentSignature(payload);
  const headers = { ...call.request.headers, "payment-signature": paymentSignature };
  const requestedAt = dependencies.now();
  await appendExecutionPhase(dependencies.pool, {
    planId: input.planId,
    stepIndex: input.step.stepIndex,
    attempt,
    phase: "call.sent",
    payload: { index: call.index, headerHash: keccak256(headers["payment-signature"] as Hex) },
  });
  let response: SafeFetchResponse | undefined;
  let errorCode = "unpaid";
  for (let retry = 0; retry < Number(dependencies.config.get("payer.callRetries")); retry += 1) {
    dependencies.assertLeaseHeld?.();
    response = await dependencies.safeFetch(call.request.url, {
      ...requestOptions(call.request),
      headers,
      timeoutMs: Math.min(
        Number(dependencies.config.get("payer.callTimeoutMs")),
        call.offer.maxTimeoutSeconds * 1000,
      ),
    });
    if (response.status === 409) {
      errorCode = "idempotency-conflict";
      break;
    }
    const settlement = readSettlement(response.headers);
    if (settlement.state === "unpaid") break;
    if (
      response.status >= 200 &&
      response.status < 300 &&
      (settlement.state === "settled" || settlement.state === "pending")
    )
      break;
    response = undefined;
  }
  if (!response || response.status < 200 || response.status >= 300) return { errorCode };
  const settlement = readSettlement(response.headers);
  if (settlement.state !== "settled" && settlement.state !== "pending")
    return { errorCode: "unpaid" };
  const paymentRef = makePaymentRef(input, call, reservationId, validBefore, payload, settlement);
  const bodyRef = await dependencies.objects.put(response.body);
  await appendExecutionPhase(dependencies.pool, {
    planId: input.planId,
    stepIndex: input.step.stepIndex,
    attempt,
    phase: "call.result",
    payload: {
      index: call.index,
      status: response.status,
      settlement: settlement.state,
      settlementTx: settlement.transaction,
      contentType: getHeader(response.headers, "content-type") ?? "",
      bodyRef,
      paymentPayload: payload,
      paymentRef,
    },
  });
  return {
    response: { index: call.index, response, bodyRef, payload, paymentRef, requestedAt, signedAt },
  };
}

async function restoreCallResult(
  dependencies: VaultDirectDependencies,
  row: ExecutionPhaseRow,
  url: string,
) {
  const { bodyRef, status, contentType, paymentPayload, paymentRef } = row.payload;
  if (
    typeof bodyRef !== "string" ||
    typeof status !== "number" ||
    typeof contentType !== "string" ||
    !paymentPayload ||
    typeof paymentPayload !== "object" ||
    !paymentRef ||
    typeof paymentRef !== "object"
  )
    throw new Error("Stored call result cannot be recovered safely.");
  return {
    response: {
      index: Number(row.payload["index"]),
      response: {
        body: await dependencies.objects.get(bodyRef),
        url,
        status,
        headers: contentType ? { "content-type": contentType } : {},
      },
      bodyRef,
      payload: paymentPayload as PaymentPayload,
      paymentRef: paymentRef as PaymentRef,
      requestedAt: new Date(0),
      signedAt: new Date(0),
    },
  };
}

function getHeader(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

function makePaymentRef(
  input: VaultDirectInput,
  call: PreparedCall,
  reservationId: bigint,
  validBefore: bigint,
  payload: PaymentPayload,
  settlement: ReturnType<typeof readSettlement>,
): PaymentRef {
  const reservationNumber = Number(reservationId);
  const expiryNumber = Number(validBefore);
  if (!Number.isSafeInteger(reservationNumber) || !Number.isSafeInteger(expiryNumber))
    throw new RangeError("PaymentRef reservation and expiry must fit safe integer fields.");
  if (settlement.state !== "settled" && settlement.state !== "pending")
    throw new Error("PaymentRef requires a facilitator transaction response.");
  return {
    schemaVersion: "1.0",
    rail: "x402-exact",
    network: call.offer.network,
    asset: call.offer.asset,
    payer: input.vault,
    payTo: payload.payload.authorization.to,
    amount: payload.payload.authorization.value,
    nonce: payload.payload.authorization.nonce,
    validBefore: expiryNumber,
    settlementTx: settlement.transaction,
    reservationId: reservationNumber,
    index: call.index,
  };
}

function storedReservationArgs(trace: readonly ExecutionPhaseRow[]):
  | {
      readonly payee: `0x${string}`;
      readonly unitAmount: bigint;
      readonly count: number;
      readonly validBefore: bigint;
    }
  | undefined {
  const sent = trace.findLast((row) => row.phase === "reserve.sent");
  if (!sent) return undefined;
  const { payee, unitAmount, count, validBefore } = sent.payload;
  if (
    typeof payee !== "string" ||
    typeof unitAmount !== "string" ||
    typeof count !== "number" ||
    typeof validBefore !== "string"
  )
    throw new Error("Stored reserve.sent phase is missing its reservation arguments.");
  return {
    payee: payee as `0x${string}`,
    unitAmount: BigInt(unitAmount),
    count,
    validBefore: BigInt(validBefore),
  };
}

function reservationExpiry(
  input: VaultDirectInput,
  dependencies: VaultDirectDependencies,
  maxTimeoutSeconds: number,
): bigint {
  const now = Math.floor(dependencies.now().getTime() / 1000);
  const ttl = Math.min(
    maxTimeoutSeconds,
    Number(dependencies.config.get("payer.reservationTtlSeconds")),
  );
  return BigInt(Math.min(now + ttl, Math.floor(input.envelopeExpiresAt.getTime() / 1000)));
}

function buildPayeeProof(input: VaultDirectInput, payee: `0x${string}`): readonly Hash32[] {
  const leaves = input.plan.payeeLeaves.map((entry) =>
    payeeLeaf(entry.payee as `0x${string}`, entry.kind, entry.stepIndex, BigInt(entry.stepCap)),
  );
  const tree = buildTree(leaves);
  const leaf = payeeLeaf(
    payee,
    PAYEE_KIND.X402_PAY_TO,
    input.step.stepIndex,
    BigInt(input.step.stepCap),
  );
  if (
    tree.root.toLowerCase() !== input.plan.payeeRoot.toLowerCase() ||
    !verifyProof(tree.proof(leaf), tree.root, leaf)
  )
    throw new Error("Plan payee root or step leaf failed verification.");
  return tree.proof(leaf);
}

function renderRequest(
  input: VaultDirectInput,
  values: Readonly<Record<string, string | number | boolean>>,
  subjectIndex?: number,
): RenderedRequest | null {
  const resolved = { ...values };
  for (const [key, value] of Object.entries(resolved)) {
    if (typeof value !== "string") continue;
    const dependency = /^\{\{dep\.(\d+)\.([a-zA-Z0-9_-]+)\}\}$/.exec(value);
    if (!dependency) continue;
    const fields = input.acceptedDependencies?.find(
      (entry) =>
        entry.stepIndex === Number(dependency[1]) &&
        entry.subjectIndex === subjectIndex &&
        entry.accepted,
    )?.fields;
    const found = fields?.find(
      (field) => field.name === dependency[2] && field.value.trim().length > 0,
    );
    if (!found) return null;
    resolved[key] = found.value;
  }
  const resource = input.step.resource;
  if (!resource) return null;
  const url = new URL(resource.url);
  const method = resource.method;
  if (method === "GET")
    for (const [key, value] of Object.entries(resolved)) url.searchParams.set(key, String(value));
  const headers = method === "GET" ? {} : { "content-type": "application/json" };
  const body = method === "GET" ? undefined : new TextEncoder().encode(JSON.stringify(resolved));
  return { url: url.href, method, headers, ...(body === undefined ? {} : { body }) };
}

function requestOptions(request: RenderedRequest, timeoutMs?: number): SafeFetchOptions {
  return {
    method: request.method,
    headers: request.headers,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(request.body ? { body: request.body } : {}),
  };
}

function isAddress(value: string | undefined): value is `0x${string}` {
  return value !== undefined && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    result.push(items.slice(index, index + size));
  return result;
}

async function waitForAuthorization(
  dependencies: VaultDirectDependencies,
  reservationId: bigint,
  index: number,
  validBefore: bigint,
): Promise<boolean> {
  const until =
    Number(validBefore) + Number(dependencies.config.get("payer.reconcileGraceSeconds"));
  while (Math.floor(dependencies.now().getTime() / 1000) <= until) {
    if (await dependencies.chain.authorizationState({ reservationId, index })) return true;
    await (dependencies.sleep ?? delay)(
      Number(dependencies.config.get("payer.reconcileSeconds")) * 1000,
    );
  }
  return false;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
