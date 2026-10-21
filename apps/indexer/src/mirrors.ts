import { getAddress, type Address, type Hex } from "viem";

type EnvelopeView = {
  cap: bigint;
  maxStepAmount: bigint;
  spent: bigint;
  reserved: bigint;
  pocketOutstanding: bigint;
  jobEscrowed: bigint;
  shortfall: bigint;
  categoryId: Hex;
  objectiveHash: Hex;
  planHash: Hex;
  payeeRoot: Hex;
  pocket: Address;
  expiresAt: bigint;
  pocketCapBps: number;
  state: number;
  approverIsOwner: boolean;
};

type ReservationView = {
  envelopeId: bigint;
  stepIndex: number;
  payee: Address;
  unitAmount: bigint;
  count: number;
  validBefore: bigint;
  mode: number;
  state: number;
  settledCount: number;
  releasedCount: number;
  settledMask: bigint;
};

type PocketView = {
  envelopeId: bigint;
  state: number;
  funded: bigint;
  gasGranted: bigint;
  outstanding: bigint;
  pendingPullback: bigint;
};

type JobView = {
  provider: Address;
  envelopeId: bigint;
  stepIndex: number;
  state: number;
  expiredAt: bigint;
  jobId: bigint;
  reservedCap: bigint;
  budget: bigint;
};

export type PullbackMirror = {
  pullbackId: number;
  value: string;
  salt: Hex;
  maxFee: string;
  maxBlockHeight: number;
  transferSpecHash: Hex;
  requestedAtBlock: number;
  state: "Pending" | "Confirmed" | "Cancelled";
  recovery: boolean;
  creditedToEnvelope?: boolean;
};

export const mirrorKey = (vault: Address, id: bigint | Address | Hex): string =>
  `${vault.toLowerCase()}:${String(id).toLowerCase()}`;

export function safeNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new Error(`On-chain integer exceeds JSON safe range: ${value}`);
  return number;
}

export function envelopeMirror(input: {
  vault: Address;
  envelopeId: bigint;
  view: EnvelopeView;
  approvalTx: Hex;
  block: bigint;
  timestamp: bigint;
  closeStarted: boolean;
}) {
  const { vault, envelopeId, view, approvalTx, block, timestamp, closeStarted } = input;
  if (view.state !== 1 && view.state !== 2) {
    throw new Error(`Invalid envelope state ${view.state}`);
  }
  const state =
    view.state === 2 ? "Closed" : timestamp >= view.expiresAt || closeStarted ? "Closing" : "Open";
  const pocket = /^0x0{40}$/i.test(view.pocket) ? {} : { pocket: getAddress(view.pocket) };
  return {
    schemaVersion: "1.1",
    envelopeRef: `eip155:5042002:${vault.toLowerCase()}:${envelopeId}`,
    vault: getAddress(vault),
    envelopeId: safeNumber(envelopeId),
    objectiveHash: view.objectiveHash.toLowerCase(),
    planHash: view.planHash.toLowerCase(),
    payeeRoot: view.payeeRoot.toLowerCase(),
    categoryId: view.categoryId.toLowerCase(),
    cap: view.cap.toString(),
    maxStepAmount: view.maxStepAmount.toString(),
    pocketCapBps: view.pocketCapBps,
    expiresAt: safeNumber(view.expiresAt),
    approver: view.approverIsOwner ? "owner" : "agent",
    approvalTx: approvalTx.toLowerCase(),
    spent: view.spent.toString(),
    reserved: view.reserved.toString(),
    pocketOutstanding: view.pocketOutstanding.toString(),
    jobEscrowed: view.jobEscrowed.toString(),
    shortfall: view.shortfall.toString(),
    state,
    lastEventBlock: safeNumber(block),
    ...pocket,
  };
}

export function reservationMirror(vault: Address, reservationId: bigint, view: ReservationView) {
  const state = ["None", "Active", "Finalizing", "Final"][view.state];
  if (!state || state === "None") throw new Error(`Invalid reservation state ${view.state}`);
  if (view.mode !== 0 && view.mode !== 1) throw new Error(`Invalid reservation mode ${view.mode}`);
  return {
    schemaVersion: "1.0",
    vault: getAddress(vault),
    reservationId: safeNumber(reservationId),
    envelopeId: safeNumber(view.envelopeId),
    stepIndex: view.stepIndex,
    payee: getAddress(view.payee),
    unitAmount: view.unitAmount.toString(),
    count: view.count,
    validBefore: safeNumber(view.validBefore),
    mode: view.mode === 0 ? "envelope" : "digest",
    settledMask: `0x${view.settledMask.toString(16).padStart(64, "0")}`,
    settledCount: view.settledCount,
    releasedCount: view.releasedCount,
    state,
  };
}

// SCR-112: keyRef is server-owned and is joined by T-034, not indexed from chain.
export function pocketMirror(input: {
  vault: Address;
  pocket: Address;
  view: PocketView;
  pullbacks: PullbackMirror[];
  delegateReady: boolean;
}) {
  const { vault, pocket, view, pullbacks, delegateReady } = input;
  const state = ["None", "Registered", "Funded", "Draining", "Closed"][view.state];
  if (!state || state === "None") throw new Error(`Invalid pocket state ${view.state}`);
  return {
    schemaVersion: "1.1",
    vault: getAddress(vault),
    envelopeId: safeNumber(view.envelopeId),
    pocket: getAddress(pocket),
    // T-032 indexes GatewayWallet.DelegateAdded; preserve that derived state.
    state: state === "Registered" && delegateReady ? "DelegateReady" : state,
    funded: view.funded.toString(),
    gasGranted: view.gasGranted.toString(),
    outstanding: view.outstanding.toString(),
    pendingPullback: view.pendingPullback.toString(),
    pullbacks,
  };
}

export function jobState(state: number): string {
  const mapped = ["None", "Opened", "Funded", "Submitted", "Completed", "Refunded", "Released"][
    state
  ];
  if (!mapped || mapped === "None") throw new Error(`Invalid JobSynced.state ${state}`);
  return mapped;
}

export function jobMirror(input: {
  vault: Address;
  jobKey: Hex;
  view: JobView;
  jobEscrow: Address;
  evaluator: Address;
  descriptionHash: Hex;
}) {
  const { vault, jobKey, view, jobEscrow, evaluator, descriptionHash } = input;
  return {
    schemaVersion: "1.1",
    vault: getAddress(vault),
    envelopeId: safeNumber(view.envelopeId),
    stepIndex: view.stepIndex,
    jobEscrow: getAddress(jobEscrow),
    jobId: view.jobId.toString(),
    jobKey: jobKey.toLowerCase(),
    provider: getAddress(view.provider),
    evaluator: getAddress(evaluator),
    reservedCap: view.reservedCap.toString(),
    budget: view.budget.toString(),
    descriptionHash: descriptionHash.toLowerCase(),
    state: jobState(view.state),
    expiredAt: safeNumber(view.expiredAt),
  };
}
