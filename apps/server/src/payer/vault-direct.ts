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
  dedupKey,
  obsId,
  paymentRefHash,
  NO_RESPONSE_COMMIT,
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
  SafeFetchError,
  selectOffer,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type SafeFetchOutcome,
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
  type CallError,
  type ExecutorLeaseGuard,
  type ExecutionPhaseRow,
} from "#src/payer/executions";
import {
  savedNonceSpent,
  savedTransactionState,
  type SavedTransactionChain,
} from "#src/payer/saved-transaction";
import { MAX_AUTHORIZATIONS_PER_RESERVATION } from "#src/router/index";
import {
  fillResponse,
  insertAtSign,
  markReleased,
  markSettled,
  observationOwner,
} from "#src/evidence/observations";

export const FINALIZE_CHUNK = 32;
/** The vault's `MIN_RESERVATION_TTL` (`CzarConstants.sol`): `validBefore ≥ block.timestamp + this`. */
export const MIN_RESERVATION_TTL_SECONDS = 30;
/**
 * The vault error name a stale saved reserve is closed with. It goes in `reserve.mined` and in the
 * `StepError` `message`, which never holds user text (SCR-153 §2, SCR-154 G4).
 */
const BAD_TTL = "BadTtl";
/**
 * SCR-155 §2: a step gets at most this many new attempts after its reserve reverts `BadTtl()`. If that attempt
 * also reverts BadTtl the step ends `reserve-failed`. The bound is structural, not a config key.
 */
const NEW_ATTEMPTS_AFTER_BAD_TTL = 1;
const RESERVE_FAILED = "reserve-failed";
/** SCR-159 §2: the outcome a saved transaction's status-0 receipt is recorded with, and the reserve's message. */
const REVERTED = "reverted";
/** Cross-cutting §5.2 `StepError` codes for a call, or a step, without an accepted paid result (SCR-159 §3). */
const UNPAID = "unpaid";
const DELIVERY_FAILED = "delivery-failed";
/** Marks an attempt whose saved reserve reverted `BadTtl()`: no reservation exists and its nonce is spent. */
const STALE_RESERVE = Symbol("stale-reserve");

/** A `reserve` transaction mined with status 0 in a block with timestamp `blockTimestamp`. */
export class ReserveReverted extends Error {
  readonly txHash: string;
  readonly blockTimestamp: bigint;

  constructor(txHash: string, blockTimestamp: bigint) {
    super(`Vault reserve reverted in the block at ${blockTimestamp}: ${txHash}`);
    this.name = "ReserveReverted";
    this.txHash = txHash;
    this.blockTimestamp = blockTimestamp;
  }
}

/** A sent `settle` or `finalize` mined with status 0. */
export class VaultTransactionReverted extends Error {
  readonly txHash: Hex;

  constructor(txHash: Hex) {
    super(`Vault transaction reverted: ${txHash}`);
    this.name = "VaultTransactionReverted";
    this.txHash = txHash;
  }
}

/**
 * The mined outcome of a sent `reserve`. A revert carries only its block's timestamp: a receipt has no revert
 * data, and BadTtl is decided by the vault's condition on that block (SCR-153 §2).
 */
export type ReserveOutcome =
  | { readonly status: "reserved"; readonly reservationId: bigint }
  | { readonly status: "reverted"; readonly blockTimestamp: bigint };

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
  readonly noResponseBoundary?: (input: NoResponseBoundaryInput) => Promise<unknown>;
  readonly findExactTransferTx?: (
    payment: Extract<PaymentRef, { rail: "x402-exact" }>,
  ) => Promise<string | null>;
  readonly recordReceipt: (input: SettledReceiptContext) => Promise<boolean>;
  readonly objects: {
    put(bytes: Uint8Array): Promise<string>;
    get(ref: string): Promise<Uint8Array>;
  };
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly assertLeaseHeld?: () => void;
}

export interface VaultDirectChain extends SavedTransactionChain {
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
  /**
   * The latest block's timestamp from a fresh read. It is "now" for every CZ-15 comparison against a deadline
   * the chain enforces: a new reserve's `validBefore` and its TTL check (CZ-15 §5.2 step 2, SCR-155 §2), call
   * retries within `validBefore`, the reconcile loop and the wait before `finalize` (SCR-157 §1). The server
   * clock is never used there.
   */
  latestBlockTimestamp(): Promise<bigint>;
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
  readonly callIndex: number;
  readonly obsId: string;
  readonly subjectIndex?: number;
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

export interface NoResponseBoundaryInput {
  readonly input: VaultDirectInput;
  readonly paymentRef: PaymentRef;
  readonly index: number;
  readonly obsId: string;
  readonly attempt: number;
  readonly requestedAt: Date;
  readonly maxTimeoutSeconds: number;
}

export type SettledReceiptContext =
  | (BoundaryInput & { readonly stepResult: unknown })
  | (NoResponseBoundaryInput & {
      readonly signedAt: Date;
      readonly stepResult: unknown;
      readonly verifiedTransferTx: string;
      readonly bodyRef?: never;
      readonly response?: never;
    });

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
  if (!input.step.serviceId)
    throw new Error("Approved x402 step has no serviceId for its payment observation.");
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
  // SCR-155 §2: the saved attempts already used the one new attempt BadTtl allows. Fail on the last of them.
  if (attempt - startAttempt > NEW_ATTEMPTS_AFTER_BAD_TTL)
    return failStaleReserve({ ...input, attempt: attempt - 1 }, dependencies);
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
  const prechecked =
    savedPreparedCalls(executionInput, trace) ??
    (await precheckCalls(executionInput, dependencies));
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
  return trace.findLast((row) => row.phase === "reserve.mined")?.payload["message"] === BAD_TTL;
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

/** The pre-check's offer for one call, saved in `reserve.sent` so a resumed attempt needs no new probe. */
interface SavedCall {
  readonly index: number;
  readonly offer: PaymentRequirements;
  readonly paymentRequired: PaymentRequired;
  readonly paymentIdentifier?: { readonly required: boolean };
  readonly resource: PreparedCall["resource"];
}

function savedCall(call: PreparedCall): SavedCall {
  return {
    index: call.index,
    offer: call.offer,
    paymentRequired: call.paymentRequired,
    ...(call.paymentIdentifier === undefined ? {} : { paymentIdentifier: call.paymentIdentifier }),
    resource: call.resource,
  };
}

/**
 * SCR-159 §1: an attempt with a `reserve.sent` row resumes from its last saved phase with the calls its own
 * pre-check prepared. The pre-check (CZ-15 §5.2 step 1) runs only for an attempt without one.
 */
function savedPreparedCalls(
  input: VaultDirectInput,
  trace: readonly ExecutionPhaseRow[],
): { readonly calls: PreparedCall[]; readonly errorCode: undefined } | undefined {
  const sent = trace.findLast((row) => row.phase === "reserve.sent");
  if (!sent) return undefined;
  const saved = sent.payload["calls"];
  if (!Array.isArray(saved))
    throw new Error("Stored reserve.sent phase is missing its prepared calls.");
  return { calls: saved.map((entry) => restorePreparedCall(input, entry)), errorCode: undefined };
}

function restorePreparedCall(input: VaultDirectInput, entry: unknown): PreparedCall {
  const saved = entry as Partial<SavedCall> | null;
  const call = typeof saved?.index === "number" ? input.step.callInputs?.[saved.index] : undefined;
  const request = call ? renderRequest(input, call.input, call.subjectIndex) : null;
  if (
    !saved ||
    typeof saved.index !== "number" ||
    !saved.offer ||
    !saved.paymentRequired ||
    !saved.resource ||
    !request
  )
    throw new Error("Stored prepared call cannot be recovered safely.");
  return {
    index: saved.index,
    request,
    offer: saved.offer,
    paymentRequired: saved.paymentRequired,
    ...(saved.paymentIdentifier === undefined
      ? {}
      : { paymentIdentifier: saved.paymentIdentifier }),
    resource: saved.resource,
  };
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
    if (choice.offer.payTo.toLowerCase() !== input.step.payee?.toLowerCase())
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
    stored?.validBefore ??
    (await newReservationExpiry(
      input,
      dependencies,
      first.offer.maxTimeoutSeconds,
      progress.afterStaleReserve,
    ));
  if (validBefore === undefined) return failStaleReserve(input, dependencies);
  const attempt = input.attempt ?? 0;
  const reservation = await findOrCreateReservation(
    input,
    dependencies,
    trace,
    {
      envelopeId: input.envelopeId,
      stepIndex: input.step.stepIndex,
      payee,
      stepCap: BigInt(input.step.stepCap),
      proof: buildPayeeProof(input, payee),
      unitAmount: amount,
      count,
      validBefore,
      calls,
    },
    attempt,
  );
  if (reservation === STALE_RESERVE) return STALE_RESERVE;
  if ("state" in reservation) return reservation;
  return settleAndFinalize(
    input,
    dependencies,
    calls.slice(0, count),
    reservation.reservationId,
    reservation.validBefore,
    amount,
    attempt,
    trace,
    progress.callsUsedBefore,
    count,
  );
}

/**
 * A new reserve's `validBefore` by the CZ-15 §5.2 step-2 formula, with "now" the latest block timestamp
 * (SCR-155 §2). `undefined` after a BadTtl revert when it does not clear the vault's `MIN_RESERVATION_TTL`
 * from that timestamp (SCR-153 §2).
 */
async function newReservationExpiry(
  input: VaultDirectInput,
  dependencies: VaultDirectDependencies,
  maxTimeoutSeconds: number,
  afterStaleReserve: boolean,
): Promise<bigint | undefined> {
  const chainNow = await dependencies.chain.latestBlockTimestamp();
  const validBefore = reservationExpiry(input, dependencies, maxTimeoutSeconds, chainNow);
  if (afterStaleReserve && validBefore < chainNow + BigInt(MIN_RESERVATION_TTL_SECONDS))
    return undefined;
  return validBefore;
}

/**
 * SCR-153 §2 and SCR-155 §2: `envelope.expiresAt` leaves the step-2 formula no room above the minimum TTL, or
 * the one new attempt after a BadTtl revert also reverted BadTtl.
 */
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
      message: BAD_TTL,
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

/** A reserve's arguments and the pre-checked calls saved with its `reserve.sent`. */
interface ReserveRequest extends ReserveInput {
  readonly calls: readonly PreparedCall[];
}

interface Reservation {
  readonly reservationId: bigint;
  readonly validBefore: bigint;
}

type ReserveResult = Reservation | VaultDirectResult | typeof STALE_RESERVE;

async function findOrCreateReservation(
  input: VaultDirectInput,
  dependencies: VaultDirectDependencies,
  trace: readonly ExecutionPhaseRow[],
  reserve: ReserveRequest,
  attempt: number,
): Promise<ReserveResult> {
  const mined = trace.findLast((row) => row.phase === "reserve.mined");
  if (mined) {
    if (mined.payload["outcome"] === REVERTED)
      return failRevertedReserve(input, dependencies, trace, attempt);
    return {
      reservationId: BigInt(String(mined.payload["reservationId"])),
      validBefore: reserve.validBefore,
    };
  }
  const sent = trace.findLast((row) => row.phase === "reserve.sent");
  if (sent) return resumeSavedReserve(input, dependencies, sent, reserve, attempt);
  const signedTransaction = await signReserve(dependencies, input.vault, reserve);
  return submitReserveOrStale(
    input,
    dependencies,
    { ...reserve, signedTransaction },
    attempt,
    true,
  );
}

/**
 * SCR-159 §2 for a saved `reserve.sent`. The account nonce is read before the receipt, so a reserve that
 * lands between the two reads is seen mined and never signed again.
 * - status 0 with the BadTtl condition: SCR-153 §2; any other status 0: `reserve-failed` / `reverted`
 * - no receipt, account nonce ≤ saved nonce: the same bytes again
 * - no receipt, account nonce > saved nonce: the same arguments signed again, with a new `reserve.sent`
 */
async function resumeSavedReserve(
  input: VaultDirectInput,
  dependencies: VaultDirectDependencies,
  sent: ExecutionPhaseRow,
  reserve: ReserveRequest,
  attempt: number,
): Promise<ReserveResult> {
  const txHash = sent.payload["txHash"];
  const saved = sent.payload["signedTransaction"];
  if (typeof txHash !== "string" || typeof saved !== "string")
    return { state: "failed", errorCode: "reserve-pending" };
  let spent = await savedNonceSpent(dependencies.chain, saved as Hex);
  let outcome = await dependencies.chain.reserveOutcome?.(txHash);
  if (spent && outcome === undefined) {
    // Review M3: confirm "replaced" on a second read before signing another reserve, so a receipt that a
    // lagging RPC node has not served yet never leads to a second reservation.
    await sleepReconcileInterval(dependencies);
    spent = await savedNonceSpent(dependencies.chain, saved as Hex);
    outcome = await dependencies.chain.reserveOutcome?.(txHash);
  }
  if (outcome?.status === "reserved")
    return recordReserved(input, dependencies, attempt, {
      reservationId: outcome.reservationId,
      validBefore: reserve.validBefore,
      txHash,
    });
  if (outcome?.status === "reverted")
    return revertedBadTtl(reserve.validBefore, outcome.blockTimestamp)
      ? recordStaleReserve(input, dependencies, attempt, txHash)
      : recordRevertedReserve(input, dependencies, attempt, txHash);
  if (!spent)
    return submitReserveOrStale(
      input,
      dependencies,
      { ...reserve, signedTransaction: saved as Hex },
      attempt,
      false,
    );
  const validBefore = await resignedReservationExpiry(input, dependencies, reserve);
  if (validBefore === undefined) return failStaleReserve(input, dependencies);
  const resigned = { ...reserve, validBefore };
  const signedTransaction = await signReserve(dependencies, input.vault, resigned);
  return submitReserveOrStale(
    input,
    dependencies,
    { ...resigned, signedTransaction },
    attempt,
    true,
  );
}

/**
 * SCR-159 §2 rule 4: a re-signed reserve keeps its `validBefore` while it still clears `MIN_RESERVATION_TTL`
 * from the latest block; otherwise it takes a new one by the step-2 formula on chain time (SCR-155 §2,
 * SCR-157 §1). `undefined` when that one does not clear it either.
 */
async function resignedReservationExpiry(
  input: VaultDirectInput,
  dependencies: VaultDirectDependencies,
  reserve: ReserveRequest,
): Promise<bigint | undefined> {
  const chainNow = await dependencies.chain.latestBlockTimestamp();
  const minimum = chainNow + BigInt(MIN_RESERVATION_TTL_SECONDS);
  if (reserve.validBefore >= minimum) return reserve.validBefore;
  const first = reserve.calls[0];
  if (!first) throw new Error("A saved reserve has no prepared call.");
  const validBefore = reservationExpiry(
    input,
    dependencies,
    first.offer.maxTimeoutSeconds,
    chainNow,
  );
  return validBefore >= minimum ? validBefore : undefined;
}

function signReserve(
  dependencies: VaultDirectDependencies,
  vault: `0x${string}`,
  reserve: ReserveInput,
): Promise<Hex> {
  return signVaultCall(dependencies, vault, "reserve", {
    envelopeId: reserve.envelopeId.toString(),
    stepIndex: String(reserve.stepIndex),
    payee: reserve.payee,
    stepCap: reserve.stepCap.toString(),
    proof: reserve.proof,
    unitAmount: reserve.unitAmount.toString(),
    count: String(reserve.count),
    validBefore: reserve.validBefore.toString(),
  });
}

async function submitReserveOrStale(
  input: VaultDirectInput,
  dependencies: VaultDirectDependencies,
  reserve: ReserveRequest & { readonly signedTransaction: Hex },
  attempt: number,
  recordSent: boolean,
): Promise<ReserveResult> {
  try {
    return await submitReserve(input, dependencies, reserve, attempt, recordSent);
  } catch (error) {
    if (!(error instanceof ReserveReverted)) throw error;
    if (revertedBadTtl(reserve.validBefore, error.blockTimestamp))
      return recordStaleReserve(input, dependencies, attempt, error.txHash);
    return recordRevertedReserve(input, dependencies, attempt, error.txHash);
  }
}

/**
 * SCR-153 §2: a status-0 `reserve` reverted `BadTtl()` exactly when its `validBefore` is below the mined
 * block's `timestamp + MIN_RESERVATION_TTL` (`ReservationLogic.sol`). Any other status-0 reserve is another
 * revert.
 */
function revertedBadTtl(validBefore: bigint, blockTimestamp: bigint): boolean {
  return validBefore < blockTimestamp + BigInt(MIN_RESERVATION_TTL_SECONDS);
}

/** SCR-153 §2: close the stale attempt with `reserve.mined` carrying `BadTtl` as its outcome. */
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
    payload: { txHash, message: BAD_TTL },
  });
  return STALE_RESERVE;
}

/**
 * SCR-159 §2 rule 2: a reserve that reverted for any reason but BadTtl ends the step. No reservation exists and
 * nothing was signed against it; the envelope continues by re-plan or close.
 */
async function recordRevertedReserve(
  input: VaultDirectInput,
  dependencies: VaultDirectDependencies,
  attempt: number,
  txHash: string,
): Promise<VaultDirectResult> {
  dependencies.assertLeaseHeld?.();
  await appendExecutionPhase(dependencies.pool, {
    planId: input.planId,
    stepIndex: input.step.stepIndex,
    attempt,
    phase: "reserve.mined",
    payload: { txHash, outcome: REVERTED },
  });
  return failVaultTransaction(input, dependencies, attempt, REVERTED);
}

/** A resume after the reverted reserve was recorded: end the step once, as `recordRevertedReserve` does. */
async function failRevertedReserve(
  input: VaultDirectInput,
  dependencies: VaultDirectDependencies,
  trace: readonly ExecutionPhaseRow[],
  attempt: number,
): Promise<VaultDirectResult> {
  if (trace.some((row) => row.phase === "step.failed"))
    return { state: "failed", errorCode: RESERVE_FAILED };
  return failVaultTransaction(input, dependencies, attempt, REVERTED);
}

/**
 * A vault transaction of the step reverted: the step ends `reserve-failed`, the cross-cutting §5.2 code for a
 * vault revert. `message` names the transaction and never holds user text.
 */
async function failVaultTransaction(
  input: VaultDirectInput,
  dependencies: VaultDirectDependencies,
  attempt: number,
  message: string,
): Promise<VaultDirectResult> {
  await markStepFailed(dependencies.pool, {
    planId: input.planId,
    stepIndex: input.step.stepIndex,
    attempt,
    errorCode: RESERVE_FAILED,
    stepError: { schemaVersion: "1.0", code: RESERVE_FAILED, message, retryable: false },
  });
  return { state: "failed", errorCode: RESERVE_FAILED };
}

async function recordReserved(
  input: VaultDirectInput,
  dependencies: VaultDirectDependencies,
  attempt: number,
  reservation: Reservation & { readonly txHash: string },
): Promise<Reservation> {
  dependencies.assertLeaseHeld?.();
  await appendExecutionPhase(dependencies.pool, {
    planId: input.planId,
    stepIndex: input.step.stepIndex,
    attempt,
    phase: "reserve.mined",
    payload: {
      reservationId: reservation.reservationId.toString(),
      validBefore: Number(reservation.validBefore),
      txHash: reservation.txHash,
    },
  });
  return { reservationId: reservation.reservationId, validBefore: reservation.validBefore };
}

async function submitReserve(
  input: VaultDirectInput,
  dependencies: VaultDirectDependencies,
  reserve: ReserveRequest & { readonly signedTransaction: Hex },
  attempt: number,
  recordSent: boolean,
): Promise<Reservation> {
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
        calls: reserve.calls.map(savedCall),
      },
    });
  const reservation = await dependencies.chain.reserve(reserve);
  return recordReserved(input, dependencies, attempt, {
    reservationId: reservation.reservationId,
    validBefore: reserve.validBefore,
    txHash: reservation.txHash,
  });
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
  const noResponses: number[] = [];
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
    else if (result.noResponse) noResponses.push(call.index);
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
  const completedResults: {
    index: number;
    subjectIndex?: number;
    stepResult: StepResult;
  }[] = [];
  const authorized: number[] = [];
  let receiptPending = false;
  for (const index of [...completed.map((entry) => entry.index), ...noResponses]) {
    const authorizationUsed = await waitForAuthorization(
      dependencies,
      reservationId,
      index,
      validBefore,
    );
    if (!authorizationUsed) continue;
    authorized.push(index);
  }
  const unsettled: number[] = [];
  for (const index of authorized) {
    if (!(await dependencies.chain.isSettled({ reservationId, index }))) unsettled.push(index);
  }
  for (const batch of chunks(unsettled, Number(dependencies.config.get("payer.settleBatchMax")))) {
    const settle = await nextVaultTransaction(input, dependencies, trace, attempt, {
      selector: "settle",
      key: { indices: batch },
      args: { reservationId: reservationId.toString(), indices: batch.map(String) },
    });
    let revertedHash = settle.kind === "reverted" ? settle.txHash : undefined;
    let settledHash: string | undefined = settle.kind === "mined" ? settle.txHash : undefined;
    if (settle.kind === "send") {
      try {
        settledHash = await dependencies.chain.settle({
          reservationId,
          indices: batch,
          signedTransaction: settle.signedTransaction,
        });
      } catch (error) {
        if (!(error instanceof VaultTransactionReverted)) throw error;
        revertedHash = error.txHash;
      }
    }
    if (revertedHash !== undefined) {
      await appendExecutionPhase(dependencies.pool, {
        planId: input.planId,
        stepIndex: input.step.stepIndex,
        attempt,
        phase: "settle.mined",
        payload: { indices: batch, txHash: revertedHash, outcome: REVERTED },
      });
      // Review M2: finalize books used authorizations as settled, so a reverted settle (for example
      // `AlreadyDone` after a third party's permissionless finalize) still goes on to finalize.
      continue;
    }
    await appendExecutionPhase(dependencies.pool, {
      planId: input.planId,
      stepIndex: input.step.stepIndex,
      attempt,
      phase: "settle.mined",
      payload: { indices: batch, ...(settledHash ? { txHash: settledHash } : {}) },
    });
  }
  const receiptsRecorded = new Set<number>();
  const contexts = new Map<number, Parameters<VaultDirectDependencies["recordReceipt"]>[0]>();
  for (const entry of completed) {
    if (!authorized.includes(entry.index)) continue;
    const call = input.step.callInputs?.find((candidate) => candidate.callIndex === entry.index);
    const context = {
      response: entry.response,
      bodyRef: entry.bodyRef,
      input,
      callIndex: entry.index,
      obsId: obsId(dedupKey(entry.paymentRef)),
      ...(call?.subjectIndex === undefined ? {} : { subjectIndex: call.subjectIndex }),
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
      (row) => row.phase === "call.result" && row.payload["callIndex"] === entry.index,
    );
    const candidate = priorResult?.payload ?? (await dependencies.boundary(context));
    if (!validateSchema("step-result", candidate))
      throw new TypeError("Boundary returned an invalid StepResult for the paid call.");
    const stepResult = candidate as StepResult;
    if (stepResult.callIndex !== entry.index || stepResult.obsId !== context.obsId)
      throw new TypeError("Boundary StepResult does not identify its paid authorization.");
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
        phase: "call.result",
        payload: { ...stepResult },
      });
    }
    contexts.set(entry.index, { ...context, stepResult });
    if (await dependencies.chain.isSettled({ reservationId, index: entry.index })) {
      receiptsRecorded.add(entry.index);
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
    const finalize = await nextVaultTransaction(input, dependencies, trace, attempt, {
      selector: "finalize",
      key: { start, count: finalizeCount },
      args: {
        reservationId: reservationId.toString(),
        fromIndex: String(start),
        toIndex: String(start + finalizeCount),
      },
    });
    let finalizeReverted = finalize.kind === "reverted" ? finalize.txHash : undefined;
    let finalized: { readonly txHash: string; readonly final: boolean } | undefined;
    if (finalize.kind === "send") {
      try {
        finalized = await dependencies.chain.finalize({
          reservationId,
          start,
          count: finalizeCount,
          signedTransaction: finalize.signedTransaction,
        });
      } catch (error) {
        if (!(error instanceof VaultTransactionReverted)) throw error;
        finalizeReverted = error.txHash;
      }
    }
    if (finalizeReverted !== undefined) {
      await appendExecutionPhase(dependencies.pool, {
        planId: input.planId,
        stepIndex: input.step.stepIndex,
        attempt,
        phase: "finalize.mined",
        payload: { start, count: finalizeCount, txHash: finalizeReverted, outcome: REVERTED },
      });
      // Review M2: a third party may have made the reservation Final first (`ReservationNotActive`).
      // The step then completes from the on-chain facts; any other revert still ends it.
      if ((await dependencies.chain.reservationFinal?.(reservationId)) === true) {
        final = true;
        break;
      }
      return failVaultTransaction(input, dependencies, attempt, "finalize reverted");
    }
    if (finalized === undefined) {
      if (finalize.kind !== "mined") throw new Error("Finalize has no mined transaction.");
      finalized = {
        txHash: finalize.txHash,
        final: (await dependencies.chain.reservationFinal?.(reservationId)) ?? false,
      };
    }
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
  const signedTrace = await getExecutionTrace(
    dependencies.pool,
    input.planId,
    input.step.stepIndex,
    attempt,
  );
  for (const row of signedTrace.filter((phase) => phase.phase === "auth.signed")) {
    const index = row.payload["index"];
    const payload = row.payload["paymentPayload"];
    const call = calls.find((candidate) => candidate.index === index);
    if (!call || !payload || typeof payload !== "object")
      throw new Error("Signed authorization cannot be reconciled to an observation.");
    const id = obsId(
      dedupKey(
        signedPaymentRef(input, call, reservationId, validBefore, payload as PaymentPayload),
      ),
    );
    if (await dependencies.chain.isSettled({ reservationId, index: call.index })) {
      const noResponse = signedTrace.findLast(
        (phase) => phase.phase === "call.no-response" && phase.payload["index"] === call.index,
      );
      if (noResponse?.payload["sellerFailureEvidenced"] === true)
        await fillResponse(dependencies.pool, id, undefined, 0);
      const settleTx = signedTrace.findLast(
        (phase) =>
          phase.phase === "settle.mined" &&
          phase.payload["outcome"] !== REVERTED &&
          Array.isArray(phase.payload["indices"]) &&
          phase.payload["indices"].includes(call.index),
      )?.payload["txHash"];
      await markSettled(
        dependencies.pool,
        id,
        dependencies.now(),
        !noResponse && typeof settleTx === "string" && /^0x[0-9a-f]{64}$/.test(settleTx)
          ? settleTx
          : undefined,
      );
    } else {
      await markReleased(
        dependencies.pool,
        id,
        dependencies.now(),
        Number(dependencies.config.get("health.consecutiveFailures")),
      );
    }
  }
  for (const index of noResponses) {
    if (!(await dependencies.chain.isSettled({ reservationId, index }))) continue;
    const call = calls.find((candidate) => candidate.index === index);
    const auth = signedTrace.findLast(
      (row) => row.phase === "auth.signed" && row.payload["index"] === index,
    );
    const sent = signedTrace.findLast(
      (row) => row.phase === "call.sent" && row.payload["index"] === index,
    );
    if (!call || !auth || !sent || !dependencies.noResponseBoundary)
      throw new Error("Settled no-response call lacks its durable signed request or boundary.");
    const payload = auth.payload["paymentPayload"] as PaymentPayload;
    const paymentRef = signedPaymentRef(input, call, reservationId, validBefore, payload);
    const observationId = obsId(dedupKey(paymentRef));
    const priorResult = signedTrace.findLast(
      (row) => row.phase === "call.result" && row.payload["callIndex"] === index,
    );
    const candidate =
      priorResult?.payload ??
      (await dependencies.noResponseBoundary({
        input,
        paymentRef,
        index,
        obsId: observationId,
        attempt,
        requestedAt: sent.at,
        maxTimeoutSeconds: call.offer.maxTimeoutSeconds,
      }));
    if (!validateSchema("step-result", candidate))
      throw new TypeError("No-response boundary returned an invalid StepResult.");
    const stepResult = candidate as StepResult;
    if (
      stepResult.status !== "no-response" ||
      stepResult.obsId !== observationId ||
      stepResult.callIndex !== index ||
      stepResult.bodyCommit !== NO_RESPONSE_COMMIT ||
      stepResult.source.paymentRefHash !== paymentRefHash(paymentRef) ||
      stepResult.fields.length !== 0 ||
      stepResult.flags.length !== 0 ||
      "bodyRef" in stepResult
    )
      throw new TypeError("No-response StepResult does not match its paid authorization.");
    completedResults.push({ index, stepResult });
    if (!priorResult)
      await appendExecutionPhase(dependencies.pool, {
        planId: input.planId,
        stepIndex: input.step.stepIndex,
        attempt,
        phase: "call.result",
        payload: { ...stepResult },
      });
    const transferTx = await dependencies.findExactTransferTx?.(paymentRef);
    if (!transferTx) {
      receiptPending = true;
      continue;
    }
    const receiptStored = await dependencies.recordReceipt({
      input,
      paymentRef,
      index,
      obsId: observationId,
      attempt,
      requestedAt: sent.at,
      signedAt: auth.at,
      maxTimeoutSeconds: call.offer.maxTimeoutSeconds,
      stepResult,
      verifiedTransferTx: transferTx,
    });
    if (!receiptStored) receiptPending = true;
  }
  // Review M2: an index left unsettled by a reverted settle is booked by finalize; record its receipt now.
  for (const [index, context] of contexts) {
    if (receiptsRecorded.has(index)) continue;
    if (!(await dependencies.chain.isSettled({ reservationId, index }))) continue;
    if (!(await dependencies.recordReceipt(context))) receiptPending = true;
  }
  return completeFinalizedStep(input, dependencies, {
    calls,
    reservationId,
    attempt,
    authorized,
    completedResults,
    receiptPending,
    callsUsedBefore,
  });
}

/**
 * SCR-159 §3, after `finalize`: a call is paid when its index is settled on chain, and accepted when it is
 * paid and its body passed the CZ-16 delivery check. The step ends `done` with the accepted calls' results;
 * every other index is recorded per call as `delivery-failed` (paid) or `unpaid`. With no accepted call the
 * step ends `failed`: `delivery-failed` when any call was paid, else `unpaid`.
 */
async function completeFinalizedStep(
  input: VaultDirectInput,
  dependencies: VaultDirectDependencies,
  outcome: {
    readonly calls: readonly PreparedCall[];
    readonly reservationId: bigint;
    readonly attempt: number;
    readonly authorized: readonly number[];
    readonly completedResults: readonly {
      readonly index: number;
      readonly subjectIndex?: number;
      readonly stepResult: StepResult;
    }[];
    readonly receiptPending: boolean;
    readonly callsUsedBefore: number;
  },
): Promise<VaultDirectResult> {
  const { calls, reservationId, attempt, authorized } = outcome;
  const accepted = outcome.completedResults.filter(({ stepResult }) => deliveredBody(stepResult));
  const stepResults = accepted.map(({ stepResult }) => stepResult);
  // A paid call's receipt is settlement evidence; the step stays open until every one is stored.
  if (outcome.receiptPending) return { state: "pending", stepResults };
  const callErrors: CallError[] = [];
  let paid = 0;
  for (const call of calls) {
    const settled =
      authorized.includes(call.index) ||
      (await dependencies.chain.isSettled({ reservationId, index: call.index }));
    if (settled) paid += 1;
    if (accepted.some(({ index }) => index === call.index)) continue;
    callErrors.push({ index: call.index, code: settled ? DELIVERY_FAILED : UNPAID });
  }
  const callsUsed = outcome.callsUsedBefore + paid;
  if (accepted.length > 0) {
    await markStepDoneWithResults(dependencies.pool, {
      planId: input.planId,
      stepIndex: input.step.stepIndex,
      attempt,
      callsUsed,
      results: accepted,
      callErrors,
    });
    return { state: "done", stepResults };
  }
  const errorCode = paid > 0 ? DELIVERY_FAILED : UNPAID;
  await markStepFailed(dependencies.pool, {
    planId: input.planId,
    stepIndex: input.step.stepIndex,
    attempt,
    errorCode,
    stepError: {
      schemaVersion: "1.0",
      code: errorCode,
      message: errorCode === UNPAID ? "No call was paid." : "Paid calls returned no usable body.",
      retryable: false,
    },
    callsUsed,
    callErrors,
  });
  return { state: "failed", errorCode };
}

/** False when the CZ-16 delivery check failed for a paid body (`http-error`, `timeout`, `no-response`). */
function deliveredBody(stepResult: StepResult): boolean {
  return (
    stepResult.status !== "http-error" &&
    stepResult.status !== "timeout" &&
    stepResult.status !== "no-response"
  );
}

/**
 * SCR-157 §1: the vault finalizes only when `block.timestamp > validBefore` (`NotExpired`), so the wait ends
 * once the latest block is past `validBefore`; every following block is too. Chain time is re-read after each
 * `payer.reconcileSeconds` sleep; the server clock is never used.
 */
async function waitUntilValidBefore(
  dependencies: VaultDirectDependencies,
  validBefore: bigint,
): Promise<void> {
  while ((await dependencies.chain.latestBlockTimestamp()) <= validBefore) {
    await sleepReconcileInterval(dependencies);
  }
}

type NextVaultTransaction =
  | { readonly kind: "send"; readonly signedTransaction: Hex }
  | { readonly kind: "mined" | "reverted"; readonly txHash: Hex };

/**
 * SCR-159 §2 for a `settle` or `finalize` this attempt saved for the same indices: its bytes again while they
 * can still land, its receipt when it has one, else the same arguments signed again and saved with a new
 * `*.sent` row.
 */
async function nextVaultTransaction(
  input: VaultDirectInput,
  dependencies: VaultDirectDependencies,
  trace: readonly ExecutionPhaseRow[],
  attempt: number,
  transaction: {
    readonly selector: "settle" | "finalize";
    readonly key: Readonly<Record<string, unknown>>;
    readonly args: Readonly<Record<string, unknown>>;
  },
): Promise<NextVaultTransaction> {
  const sentPhase = `${transaction.selector}.sent`;
  const saved = trace.findLast(
    (row) =>
      row.phase === sentPhase &&
      Object.entries(transaction.key).every(
        ([name, value]) => JSON.stringify(row.payload[name]) === JSON.stringify(value),
      ),
  )?.payload["signedTransaction"];
  if (typeof saved === "string") {
    const state = await savedTransactionState(dependencies.chain, saved as Hex, () =>
      sleepReconcileInterval(dependencies),
    );
    if (state === "pending") return { kind: "send", signedTransaction: saved as Hex };
    if (state === "mined" || state === "reverted")
      return { kind: state, txHash: keccak256(saved as Hex) };
  }
  const signedTransaction = await signVaultCall(
    dependencies,
    input.vault,
    transaction.selector,
    transaction.args,
  );
  dependencies.assertLeaseHeld?.();
  await appendExecutionPhase(dependencies.pool, {
    planId: input.planId,
    stepIndex: input.step.stepIndex,
    attempt,
    phase: sentPhase,
    payload: { ...transaction.key, txHash: keccak256(signedTransaction), signedTransaction },
  });
  return { kind: "send", signedTransaction };
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
  const nonce = derivedNonce(input.vault, reservationId, call.index);
  const signedAt = dependencies.now();
  const savedAuth = trace.findLast(
    (row) => row.phase === "auth.signed" && row.payload["index"] === call.index,
  );
  const storedPayload = savedAuth?.payload["paymentPayload"];
  let payload: PaymentPayload;
  let paymentSignature: string | undefined;
  let paymentId: string;
  if (storedPayload && typeof storedPayload === "object") {
    payload = storedPayload as PaymentPayload;
    const savedPaymentId = savedAuth?.payload["paymentId"];
    if (typeof savedPaymentId !== "string")
      throw new Error("Stored signed authorization is missing its paymentId.");
    paymentId = savedPaymentId;
    const storedSignature = savedAuth?.payload["paymentSignature"];
    if (typeof storedSignature === "string") paymentSignature = storedSignature;
  } else if (savedAuth) {
    throw new Error("Stored signed payment payload is invalid.");
  } else {
    if (call.offer.payTo.toLowerCase() !== input.step.payee?.toLowerCase())
      return { errorCode: "price-or-payee-drift" };
    paymentId = `pay_${randomUUID().replaceAll("-", "")}`;
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
      ...(call.paymentIdentifier ? { paymentId } : {}),
      ...(call.paymentIdentifier ? { advertised: call.paymentIdentifier } : {}),
    });
    paymentSignature = encodePaymentSignature(payload);
    await appendExecutionPhase(dependencies.pool, {
      planId: input.planId,
      stepIndex: input.step.stepIndex,
      attempt,
      phase: "auth.signed",
      payload: { index: call.index, paymentPayload: payload, paymentSignature, paymentId },
    });
  }
  const signedRef = signedPaymentRef(input, call, reservationId, validBefore, payload);
  const serviceId = input.step.serviceId;
  if (!serviceId) throw new Error("Signed x402 step is missing its serviceId.");
  const owner = await observationOwner(dependencies.pool, input.planId);
  if (owner.userId !== input.userId)
    throw new Error("Signed x402 step owner does not match its plan objective.");
  const observationId = await insertAtSign(dependencies.pool, {
    ...owner,
    vault: input.vault,
    network: call.offer.network,
    rail: "x402-exact",
    serviceId,
    versionId: "ver_unknown",
    taskClass: input.step.capability,
    envelopeRef: input.envelopeRef,
    stepIndex: input.step.stepIndex,
    paymentRef: signedRef,
    paymentId,
  });
  const priorResult = trace.findLast(
    (row) => row.phase === "call.response" && row.payload["index"] === call.index,
  );
  if (priorResult) return restoreCallResult(dependencies, priorResult, call);
  const priorNoResponse = trace.findLast(
    (row) => row.phase === "call.no-response" && row.payload["index"] === call.index,
  );
  if (priorNoResponse) return { noResponse: true };
  const priorUnpaid = trace.findLast(
    (row) => row.phase === "call.unpaid" && row.payload["index"] === call.index,
  );
  if (priorUnpaid) return { errorCode: String(priorUnpaid.payload["errorCode"] ?? "unpaid") };
  const expiredBeforeSend =
    Boolean(savedAuth) && (await dependencies.chain.latestBlockTimestamp()) >= validBefore;
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
  // SCR-159 §3: a merchant that settled and then answered without a 2xx body still took the payment. Its
  // response is kept so the call reaches settle, the boundary (CZ-16 delivery fails) and the receipt.
  let settledResponse: SafeFetchResponse | undefined;
  let errorCode = "unpaid";
  let responseArrived = false;
  let finalOutcome: SafeFetchOutcome = "unknown-transport";
  for (let retry = 0; retry < Number(dependencies.config.get("payer.callRetries")); retry += 1) {
    // 02 §7.5: retries only within validBefore, by chain time (SCR-157 §1); USDC refuses the authorization
    // once `block.timestamp ≥ validBefore`.
    if (retry > 0 && (await dependencies.chain.latestBlockTimestamp()) >= validBefore) break;
    dependencies.assertLeaseHeld?.();
    let response: SafeFetchResponse;
    try {
      response = await dependencies.safeFetch(call.request.url, {
        ...requestOptions(call.request),
        headers,
        timeoutMs: Math.min(
          Number(dependencies.config.get("payer.callTimeoutMs")),
          call.offer.maxTimeoutSeconds * 1000,
        ),
      });
    } catch (error) {
      if (
        !(error instanceof SafeFetchError) ||
        (error.code !== "upstream-unavailable" && error.rule !== "dns")
      )
        throw error;
      finalOutcome = error.outcome;
      await appendExecutionPhase(dependencies.pool, {
        planId: input.planId,
        stepIndex: input.step.stepIndex,
        attempt,
        phase: "call.attempt",
        payload: { index: call.index, retry, outcome: finalOutcome },
      });
      errorCode = "upstream-unavailable";
      continue;
    }
    responseArrived = true;
    await appendExecutionPhase(dependencies.pool, {
      planId: input.planId,
      stepIndex: input.step.stepIndex,
      attempt,
      phase: "call.attempt",
      payload: { index: call.index, retry, outcome: "response" },
    });
    await fillResponse(dependencies.pool, observationId, dependencies.now(), undefined);
    const attemptSettlement = readSettlement(response.headers);
    const moved = attemptSettlement.state === "settled" || attemptSettlement.state === "pending";
    if (moved) settledResponse = response;
    if (response.status === 409) {
      errorCode = "idempotency-conflict";
      break;
    }
    if (attemptSettlement.state === "unpaid") break;
    if (response.status >= 200 && response.status < 300 && moved) break;
  }
  const response = settledResponse;
  if (!response) {
    dependencies.assertLeaseHeld?.();
    if (responseArrived || expiredBeforeSend)
      return { errorCode: expiredBeforeSend ? "authorization-expired" : errorCode };
    await appendExecutionPhase(dependencies.pool, {
      planId: input.planId,
      stepIndex: input.step.stepIndex,
      attempt,
      phase: "call.no-response",
      payload: {
        index: call.index,
        paymentRef: signedRef,
        requestCommit: slRequestCommit({
          ...call.request,
          body: call.request.body ?? new Uint8Array(),
        }),
        requirementsHashSeen: H(call.paymentRequired),
        requestSize: call.request.body?.byteLength ?? 0,
        sellerFailureEvidenced:
          !savedAuth &&
          ["connection-refused", "connection-reset", "connected-timeout"].includes(finalOutcome),
      },
    });
    return { noResponse: true };
  }
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
    phase: "call.response",
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

function signedPaymentRef(
  input: VaultDirectInput,
  call: PreparedCall,
  reservationId: bigint,
  validBefore: bigint,
  payload: PaymentPayload,
): Extract<PaymentRef, { rail: "x402-exact" }> {
  const reservationNumber = Number(reservationId);
  const expiryNumber = Number(validBefore);
  if (!Number.isSafeInteger(reservationNumber) || !Number.isSafeInteger(expiryNumber))
    throw new RangeError("PaymentRef reservation and expiry must fit safe integer fields.");
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
    reservationId: reservationNumber,
    index: call.index,
  };
}

function makePaymentRef(
  input: VaultDirectInput,
  call: PreparedCall,
  reservationId: bigint,
  validBefore: bigint,
  payload: PaymentPayload,
  settlement: ReturnType<typeof readSettlement>,
): PaymentRef {
  if (settlement.state !== "settled" && settlement.state !== "pending")
    throw new Error("PaymentRef requires a facilitator transaction response.");
  return {
    ...signedPaymentRef(input, call, reservationId, validBefore, payload),
    settlementTx: settlement.transaction,
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
  chainNow: bigint,
): bigint {
  const ttl = Math.min(
    maxTimeoutSeconds,
    Number(dependencies.config.get("payer.reservationTtlSeconds")),
  );
  const expiresAt = BigInt(Math.floor(input.envelopeExpiresAt.getTime() / 1000));
  const capped = chainNow + BigInt(ttl);
  return capped < expiresAt ? capped : expiresAt;
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
    validBefore + BigInt(Number(dependencies.config.get("payer.reconcileGraceSeconds")));
  // CZ-15 §5.5 by chain time (SCR-157 §1): the deadline is the one USDC enforces on the authorization.
  while ((await dependencies.chain.latestBlockTimestamp()) <= until) {
    if (await dependencies.chain.authorizationState({ reservationId, index })) return true;
    await sleepReconcileInterval(dependencies);
  }
  return false;
}

function sleepReconcileInterval(dependencies: VaultDirectDependencies): Promise<void> {
  const milliseconds = Number(dependencies.config.get("payer.reconcileSeconds")) * 1000;
  return (dependencies.sleep ?? delay)(milliseconds);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
