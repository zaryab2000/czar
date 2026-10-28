import type { Config } from "@czar/config";
import {
  derivedNonce,
  PAYEE_KIND,
  payeeLeaf,
  buildTree,
  H,
  slRequestCommit,
  slResponseCommit,
  verifyProof,
  type Hash32,
} from "@czar/hashing";
import {
  validateSchema,
  type PaymentRef,
  type Plan,
  type Step,
  type StepResult,
} from "@czar/schemas";
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
  markStepDoneWithResults,
  markStepFailed,
  markStepHandedOff,
  releaseExecutorLease,
  startExecutorLeaseRenewal,
  type ExecutorLeaseGuard,
  type ExecutionPhaseRow,
} from "#src/payer/executions";
import { MAX_AUTHORIZATIONS_PER_RESERVATION } from "#src/router/index";

export const FINALIZE_CHUNK = 32;
/** The vault's `MIN_RESERVATION_TTL` (`CzarConstants.sol`): `validBefore ≥ block.timestamp + this`. */
export const MIN_RESERVATION_TTL_SECONDS = 30;
const BAD_TTL = "BadTtl";
/**
 * The decoded revert of a stale saved reserve. `StepError` and `reserve.mined` have no field for a decoded
 * error name (SCR-153 §2 `detail` is an open spec gap), so it travels in a message.
 */
export const STALE_RESERVE_MESSAGE = `vault reverted ${BAD_TTL}()`;
const RESERVE_FAILED = "reserve-failed";
/** Marks an attempt whose saved reserve reverted `BadTtl()`: no reservation exists and its nonce is spent. */
const STALE_RESERVE = Symbol("stale-reserve");

/** A `reserve` transaction mined with status 0; `errorName` is the decoded vault error (03 §9.2). */
export class ReserveReverted extends Error {
  readonly txHash: string;
  readonly errorName: string;

  constructor(txHash: string, errorName: string) {
    super(`Vault reserve reverted ${errorName}: ${txHash}`);
    this.name = "ReserveReverted";
    this.txHash = txHash;
    this.errorName = errorName;
  }
}

export type ReserveOutcome =
  | { readonly status: "reserved"; readonly reservationId: bigint }
  | { readonly status: "reverted"; readonly errorName: string };

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
  readonly dispatchLease?: ExecutorLeaseGuard;
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
  readonly recordReceipt: (input: SettledReceiptContext) => Promise<boolean>;
  readonly objects: {
    put(bytes: Uint8Array): Promise<string>;
    get(ref: string): Promise<Uint8Array>;
  };
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly assertLeaseHeld?: () => void;
}

export interface VaultDirectChain {
  stepUsed(envelopeId: bigint, stepIndex: number): Promise<bigint>;
  envelopeCapacity(envelopeId: bigint): Promise<{
    readonly cap: bigint;
    readonly exposure: bigint;
  }>;
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
  /** The mined outcome of a sent `reserve`; `undefined` while the transaction has no receipt. */
  reserveOutcome?(txHash: string): Promise<ReserveOutcome | undefined>;
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
  readonly attempt: number;
  readonly receipt: {
    readonly requestCommit: Hash32;
    readonly responseCommit: Hash32;
    readonly requirementsHashSeen: Hash32;
    readonly requestSize: number;
    readonly responseSize: number;
    readonly mimeType: string;
  };
}

export interface SettledReceiptContext extends BoundaryInput {
  readonly stepResult: unknown;
}

export type VaultDirectResult =
  | { readonly state: "handed_off"; readonly assembly: readonly AssemblyEntry[] }
  | { readonly state: "done"; readonly stepResults: readonly unknown[] }
  | { readonly state: "pending"; readonly stepResults: readonly unknown[] }
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
  if (input.dispatchLease)
    return executeStep(input, { ...dependencies, assertLeaseHeld: input.dispatchLease.assertHeld });
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
  const startAttempt = input.attempt ?? 0;
  const { attempt, trace } = await currentAttempt(
    dependencies.pool,
    input.planId,
    input.step.stepIndex,
    startAttempt,
  );
  const executionInput = {
    ...input,
    attempt,
    step: {
      ...input.step,
      expectedCalls: usage.remaining,
      ...(input.step.callInputs === undefined
        ? {}
        : { callInputs: input.step.callInputs.slice(usage.used) }),
    },
  };
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
  const result = await executeReservedCalls(executionInput, dependencies, prechecked.calls, trace, {
    callsUsedBefore: usage.used,
    afterStaleReserve: attempt > startAttempt,
  });
  // SCR-153 §2: the saved reserve reverted BadTtl, so start again from step 1 as `attempt + 1`.
  if (result === STALE_RESERVE) return executeStep(input, dependencies);
  return result;
}

/**
 * The attempt to run: the first one from `startAttempt` whose reserve did not revert `BadTtl()`. A stale
 * attempt never reserved on chain and signed no authorization, so its successor starts from step 1.
 */
async function currentAttempt(
  pool: Pool,
  planId: string,
  stepIndex: number,
  startAttempt: number,
): Promise<{ readonly attempt: number; readonly trace: readonly ExecutionPhaseRow[] }> {
  let attempt = startAttempt;
  let trace = await getExecutionTrace(pool, planId, stepIndex, attempt);
  while (staleReserve(trace)) {
    attempt += 1;
    trace = await getExecutionTrace(pool, planId, stepIndex, attempt);
  }
  return { attempt, trace };
}

function staleReserve(trace: readonly ExecutionPhaseRow[]): boolean {
  return (
    trace.findLast((row) => row.phase === "reserve.mined")?.payload["message"] ===
    STALE_RESERVE_MESSAGE
  );
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
  progress: { readonly callsUsedBefore: number; readonly afterStaleReserve: boolean },
): Promise<VaultDirectResult | typeof STALE_RESERVE> {
  const first = calls[0];
  if (!first) return { state: "failed", errorCode: "unsupported-offer" };
  // On resume, the reservation's own arguments win over a fresh probe and the current clock:
  // authorizations must carry the reserved payee, unit amount and validBefore (CZ-15 §5.2 crash table).
  const stored = storedReservationArgs(trace);
  const payee = stored?.payee ?? (first.offer.payTo as `0x${string}`);
  const amount = stored?.unitAmount ?? BigInt(first.offer.amount);
  const count = stored?.count ?? (await newReservationCount(input, dependencies, calls, amount));
  if (count === 0) {
    await markStepFailed(dependencies.pool, {
      planId: input.planId,
      stepIndex: input.step.stepIndex,
      attempt: input.attempt ?? 0,
      errorCode: "step-cap-exhausted",
    });
    return { state: "failed", errorCode: "step-cap-exhausted" };
  }
  const validBefore =
    stored?.validBefore ?? reservationExpiry(input, dependencies, first.offer.maxTimeoutSeconds);
  if (!stored && progress.afterStaleReserve && !reservationTtlFits(dependencies, validBefore))
    return failStaleReserve(input, dependencies);
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
  if (existingReservation === STALE_RESERVE) return STALE_RESERVE;
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
    progress.callsUsedBefore,
    count,
  );
}

/** Whether a fresh reserve's `validBefore` clears the vault's `MIN_RESERVATION_TTL` from now. */
function reservationTtlFits(dependencies: VaultDirectDependencies, validBefore: bigint): boolean {
  const now = BigInt(Math.floor(dependencies.now().getTime() / 1000));
  return validBefore >= now + BigInt(MIN_RESERVATION_TTL_SECONDS);
}

/** SCR-153 §2 bound: `envelope.expiresAt` leaves the step-2 formula no room above the minimum TTL. */
async function failStaleReserve(
  input: VaultDirectInput,
  dependencies: VaultDirectDependencies,
): Promise<VaultDirectResult> {
  await markStepFailed(dependencies.pool, {
    planId: input.planId,
    stepIndex: input.step.stepIndex,
    attempt: input.attempt ?? 0,
    errorCode: RESERVE_FAILED,
    stepError: {
      schemaVersion: "1.0",
      code: RESERVE_FAILED,
      message: STALE_RESERVE_MESSAGE,
      retryable: false,
    },
  });
  return { state: "failed", errorCode: RESERVE_FAILED };
}

async function newReservationCount(
  input: VaultDirectInput,
  dependencies: VaultDirectDependencies,
  calls: readonly PreparedCall[],
  unitAmount: bigint,
): Promise<number> {
  const stepCap = BigInt(input.step.stepCap);
  const used = await dependencies.chain.stepUsed(input.envelopeId, input.step.stepIndex);
  const stepRemaining = stepCap > used ? stepCap - used : 0n;
  const envelope = await dependencies.chain.envelopeCapacity(input.envelopeId);
  const envelopeRemaining =
    envelope.cap > envelope.exposure ? envelope.cap - envelope.exposure : 0n;
  const remaining = stepRemaining < envelopeRemaining ? stepRemaining : envelopeRemaining;
  if (unitAmount <= 0n) throw new RangeError("x402 unit amount must be positive.");
  const affordable = remaining / unitAmount;
  const maxCount = Math.min(
    calls.length,
    input.step.expectedCalls,
    MAX_AUTHORIZATIONS_PER_RESERVATION,
  );
  const affordableCount = affordable >= BigInt(maxCount) ? maxCount : Number(affordable);
  return Math.min(maxCount, affordableCount);
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
): Promise<bigint | undefined | typeof STALE_RESERVE> {
  const mined = trace.findLast((row) => row.phase === "reserve.mined");
  if (mined) return BigInt(String(mined.payload["reservationId"]));
  const sent = trace.findLast((row) => row.phase === "reserve.sent");
  if (sent) {
    const txHash = sent.payload["txHash"];
    if (typeof txHash !== "string") return undefined;
    const outcome = await dependencies.chain.reserveOutcome?.(txHash);
    if (outcome?.status === "reserved") return outcome.reservationId;
    if (outcome?.status === "reverted" && outcome.errorName === BAD_TTL)
      return recordStaleReserve(input, dependencies, attempt, txHash);
    const savedTransaction = sent.payload["signedTransaction"];
    if (typeof savedTransaction !== "string") return undefined;
    const reservation = await submitReserveOrStale(
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
    return reservation === STALE_RESERVE ? reservation : reservation.reservationId;
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
  const reservation = await submitReserveOrStale(
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
  );
  return reservation === STALE_RESERVE ? reservation : reservation.reservationId;
}

async function submitReserveOrStale(
  input: VaultDirectInput,
  dependencies: VaultDirectDependencies,
  reserve: ReserveInput & { readonly signedTransaction: Hex },
  attempt: number,
  recordSent: boolean,
): Promise<{ readonly reservationId: bigint; readonly txHash: string } | typeof STALE_RESERVE> {
  try {
    return await submitReserve(input, dependencies, reserve, attempt, recordSent);
  } catch (error) {
    if (!(error instanceof ReserveReverted) || error.errorName !== BAD_TTL) throw error;
    return recordStaleReserve(input, dependencies, attempt, error.txHash);
  }
}

/** SCR-153 §2: close the stale attempt with `reserve.mined` carrying the decoded error. */
async function recordStaleReserve(
  input: VaultDirectInput,
  dependencies: VaultDirectDependencies,
  attempt: number,
  txHash: string,
): Promise<typeof STALE_RESERVE> {
  dependencies.assertLeaseHeld?.();
  await appendExecutionPhase(dependencies.pool, {
    planId: input.planId,
    stepIndex: input.step.stepIndex,
    attempt,
    phase: "reserve.mined",
    payload: { txHash, message: STALE_RESERVE_MESSAGE },
  });
  return STALE_RESERVE;
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
  reservedCount: number,
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
    requestCommit: Hash32;
    responseCommit: Hash32;
    requirementsHashSeen: Hash32;
    requestSize: number;
    responseSize: number;
    mimeType: string;
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
  const completedResults: {
    index: number;
    subjectIndex?: number;
    stepResult: StepResult;
  }[] = [];
  const authorized: number[] = [];
  let receiptPending = false;
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
      attempt,
      receipt: {
        requestCommit: entry.requestCommit,
        responseCommit: entry.responseCommit,
        requirementsHashSeen: entry.requirementsHashSeen,
        requestSize: entry.requestSize,
        responseSize: entry.responseSize,
        mimeType: entry.mimeType,
      },
    };
    const priorResult = trace.findLast(
      (row) =>
        (row.phase === "step.result" || row.phase === "step.result.prepared") &&
        row.payload["index"] === entry.index,
    );
    if (priorResult && !Object.hasOwn(priorResult.payload, "stepResult"))
      throw new Error("Stored step result cannot be recovered safely.");
    const candidate = priorResult
      ? priorResult.payload["stepResult"]
      : await dependencies.boundary(context);
    if (!validateSchema("step-result", candidate))
      throw new TypeError("Boundary returned an invalid StepResult for the paid call.");
    const stepResult = candidate as StepResult;
    results.push(stepResult);
    const call = input.step.callInputs?.find(
      (callCandidate) => callCandidate.callIndex === entry.index,
    );
    completedResults.push({
      index: entry.index,
      ...(call?.subjectIndex === undefined ? {} : { subjectIndex: call.subjectIndex }),
      stepResult,
    });
    if (!priorResult) {
      await appendExecutionPhase(dependencies.pool, {
        planId: input.planId,
        stepIndex: input.step.stepIndex,
        attempt,
        phase: "step.result.prepared",
        payload: {
          index: entry.index,
          ...(call?.subjectIndex === undefined ? {} : { subjectIndex: call.subjectIndex }),
          stepResult,
        },
      });
    }
    if (await dependencies.chain.isSettled({ reservationId, index: entry.index })) {
      const receiptStored = await dependencies.recordReceipt({ ...context, stepResult });
      if (!receiptStored) receiptPending = true;
    }
  }
  let start = 0;
  let final = false;
  if (dependencies.chain.reservationFinal)
    final = await dependencies.chain.reservationFinal(reservationId);
  if (!final) await waitUntilValidBefore(dependencies, validBefore);
  while (!final && start < reservedCount) {
    // The vault refuses a range past the reservation's count (`BadParams`).
    const finalizeCount = Math.min(FINALIZE_CHUNK, reservedCount - start);
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
  if (!final) throw new Error("Reservation is not final after finalizing every reserved index.");
  if (authorized.length !== calls.length) {
    await markStepFailed(dependencies.pool, {
      planId: input.planId,
      stepIndex: input.step.stepIndex,
      attempt,
      errorCode: "unpaid-index",
    });
    return { state: "failed", errorCode: "unpaid-index" };
  }
  if (receiptPending) return { state: "pending", stepResults: results };
  await markStepDoneWithResults(dependencies.pool, {
    planId: input.planId,
    stepIndex: input.step.stepIndex,
    attempt,
    callsUsed: callsUsedBefore + authorized.length,
    results: completedResults,
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
  if (priorResult) return restoreCallResult(dependencies, priorResult, call);
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
  const mimeType = getHeader(response.headers, "content-type") ?? "";
  const requestCommit = slRequestCommit({
    ...call.request,
    body: call.request.body ?? new Uint8Array(),
  });
  const responseCommit = slResponseCommit(response.status, mimeType, response.body);
  const requirementsHashSeen = H(call.paymentRequired);
  const requestSize = call.request.body?.byteLength ?? 0;
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
      contentType: mimeType,
      bodyRef,
      paymentPayload: payload,
      paymentRef,
      requestedAt: requestedAt.toISOString(),
      signedAt: signedAt.toISOString(),
      requestCommit,
      responseCommit,
      requirementsHashSeen,
      requestSize,
      responseSize: response.body.byteLength,
    },
  });
  return {
    response: {
      index: call.index,
      response,
      bodyRef,
      payload,
      paymentRef,
      requestedAt,
      signedAt,
      requestCommit,
      responseCommit,
      requirementsHashSeen,
      requestSize,
      responseSize: response.body.byteLength,
      mimeType,
    },
  };
}

async function restoreCallResult(
  dependencies: VaultDirectDependencies,
  row: ExecutionPhaseRow,
  call: PreparedCall,
) {
  const { bodyRef, status, contentType, paymentPayload, paymentRef } = row.payload;
  const requestCommit = row.payload["requestCommit"];
  const responseCommit = row.payload["responseCommit"];
  const requirementsHashSeen = row.payload["requirementsHashSeen"];
  const requestSize = row.payload["requestSize"];
  const responseSize = row.payload["responseSize"];
  const requestedAt = row.payload["requestedAt"];
  const signedAt = row.payload["signedAt"];
  if (
    typeof bodyRef !== "string" ||
    typeof status !== "number" ||
    typeof contentType !== "string" ||
    !paymentPayload ||
    typeof paymentPayload !== "object" ||
    !paymentRef ||
    typeof paymentRef !== "object" ||
    typeof requestCommit !== "string" ||
    typeof responseCommit !== "string" ||
    typeof requirementsHashSeen !== "string" ||
    typeof requestSize !== "number" ||
    typeof responseSize !== "number" ||
    typeof requestedAt !== "string" ||
    typeof signedAt !== "string"
  )
    throw new Error("Stored call result cannot be recovered safely.");
  return {
    response: {
      index: Number(row.payload["index"]),
      response: {
        body: await dependencies.objects.get(bodyRef),
        url: call.request.url,
        status,
        headers: contentType ? { "content-type": contentType } : {},
      },
      bodyRef,
      payload: paymentPayload as PaymentPayload,
      paymentRef: paymentRef as PaymentRef,
      requestedAt: new Date(requestedAt),
      signedAt: new Date(signedAt),
      requestCommit: requestCommit as Hash32,
      responseCommit: responseCommit as Hash32,
      requirementsHashSeen: requirementsHashSeen as Hash32,
      requestSize,
      responseSize,
      mimeType: contentType,
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
