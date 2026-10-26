// What the signer reads from the CZ-19 projections and CZ-13/CZ-16/CZ-17 tables before it signs.
// The signer never trusts the caller for these facts (CZ-27 §5.2). Implementations live with the indexer.
import type { Address, Hash32 } from "@czar/hashing";
import type { PaymentRef } from "@czar/schemas";

export interface FreezeState {
  readonly frozen: boolean;
  readonly guardianPaused: boolean;
  /** Unix seconds of the block the projection last read these flags at. */
  readonly observedAt: number;
}

export interface ReservationView {
  readonly envelopeId: bigint;
  readonly stepIndex: number;
  readonly payee: Address;
  readonly unitAmount: bigint;
  readonly count: number;
  readonly validBefore: bigint;
  readonly state: "Active" | "Finalizing" | "Final";
}

export interface PullbackView {
  readonly pocket: Address;
  readonly value: bigint;
  readonly maxFee: bigint;
  readonly maxBlockHeight: bigint;
  readonly salt: Hash32;
  readonly state: "Pending" | "Confirmed" | "Cancelled";
}

/** A stored plan (CZ-13) as `openEnvelope` must reproduce it (RV-032). */
export interface StoredPlan {
  readonly planHash: Hash32;
  readonly payeeRoot: Hash32;
  readonly objectiveHash: Hash32;
  readonly categoryId: Hash32;
  readonly cap: bigint;
  readonly maxStepAmount: bigint;
  readonly pocketCapBps: number;
  readonly expiresAt: bigint;
  readonly approval: "auto-approvable" | "needs-approval" | "owner-approved";
  readonly hasNanoStep: boolean;
}

/** One payee leaf of an envelope's plan, with how many calls of it are still allowed. */
export interface PlanLeaf {
  readonly stepIndex: number;
  readonly payee: Address;
  /** 1 x402 payTo, 2 ERC-8183 provider, 3 tip repo, 4 pocket (02 §5). */
  readonly kind: number;
  readonly stepCap: bigint;
  readonly stepKind: "x402-exact" | "gateway-nano" | "erc8183-job" | "local" | "tip" | "pocket";
  readonly expectedCalls: number;
  readonly usedCalls: number;
}

export interface EnvelopeView {
  readonly state: "Open" | "Closed";
  readonly leaves: readonly PlanLeaf[];
}

export interface PocketView {
  readonly vault: Address;
  readonly envelopeId: bigint;
  readonly state: "Registered" | "Funded" | "Draining" | "Closed";
  readonly funded: bigint;
  readonly pendingPullback: bigint;
  readonly slowWithdrawalOpen: boolean;
}

export interface AutonomyView {
  readonly autoLimit: bigint;
  readonly userMax: bigint;
  /** The highest `newLimit` the D40 step allows from `autoLimit`. */
  readonly maxStepTo: bigint;
  readonly lastRaiseAt: number;
  readonly periodLength: number;
  readonly nonce: bigint;
}

export interface JobView {
  readonly evaluator: Address;
  readonly clientVault: Address;
}

export interface PocketBalances {
  readonly gatewayApi: bigint;
  readonly gatewayAvailable: bigint;
  readonly gatewayApiObservedAt: number | null;
  readonly gatewayWithdrawing: bigint;
  readonly withdrawalBlock: bigint;
  readonly currentBlock: bigint;
  readonly usdc: bigint;
  readonly native: bigint;
  readonly pendingPullback: boolean;
  readonly gatewayApiFresh: boolean;
}

export type SlowWithdrawTrigger = "api-down" | "closed-dust" | null;

/** Evidence the signer independently checks before a stale-Gateway manual-return write-off. */
export interface OverdueManualReturnFacts {
  readonly pocketStateValid: boolean;
  readonly envelopeOpen: boolean;
  readonly pendingPullbackZero: boolean;
  readonly gatewayWithdrawingZero: boolean;
  readonly pocketUsdcZero: boolean;
  readonly slowWithdrawAudited: boolean;
  readonly pocketReturnAudited: boolean;
  readonly manualReturnRowValid: boolean;
  readonly returnReceiptValid: boolean;
  readonly returnOverdue: boolean;
  readonly manualReturnRecordedAfter: boolean;
}

export interface Projection {
  freezeState(vault: Address): Promise<FreezeState | undefined>;
  isVault(vault: Address): Promise<boolean>;
  reservation(vault: Address, reservationId: bigint): Promise<ReservationView | undefined>;
  pullback(vault: Address, pullbackId: bigint): Promise<PullbackView | undefined>;
  blockNumber(): Promise<bigint>;
  storedPlan(vault: Address, planHash: Hash32): Promise<StoredPlan | undefined>;
  envelope(vault: Address, envelopeId: bigint): Promise<EnvelopeView | undefined>;
  pocket(pocket: Address): Promise<PocketView | undefined>;
  pocketBalances(pocket: Address): Promise<PocketBalances>;
  /** The paying step's `stepIndex` the pocket pays for, cumulative nanopayment totals. */
  nanoSpent(pocket: Address, payTo: Address): Promise<{ step: bigint; pocket: bigint }>;
  settledPayment(vault: Address, paymentRef: PaymentRef): Promise<boolean>;
  autonomy(vault: Address, categoryId: Hash32): Promise<AutonomyView | undefined>;
  job(escrow: Address, jobId: bigint): Promise<JobView | undefined>;
  reportExists(reportHash: Hash32): Promise<boolean>;
  checksCommitExists(checksCommit: Hash32): Promise<boolean>;
  latestEvidenceRoot(publisher: Address, kind: number): Promise<Hash32>;
  evidenceBatchExists(root: Hash32): Promise<boolean>;
  nativeBalance(address: Address): Promise<bigint>;
  /** The permitted slow-withdraw trigger, if any, from CZ-15 / SCR-127. */
  slowWithdrawTrigger(pocket: Address): Promise<SlowWithdrawTrigger>;
  pocketSpendAfterObservation(pocket: Address, observedAt: number): Promise<boolean>;
  /** Reads SCR-145 evidence from chain, CZ-15 storage, signer audit and the indexer. */
  overdueManualReturnFacts?(
    pocket: Address,
    vault: Address,
    now: number,
  ): Promise<OverdueManualReturnFacts>;
}
