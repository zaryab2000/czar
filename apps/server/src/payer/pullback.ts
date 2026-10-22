import {
  addressToBytes32,
  transferSpecBytes,
  transferSpecHash,
  type Address,
  type BurnIntent,
  type Hash32,
  type TransferSpec,
} from "@czar/hashing";
import type { Config } from "@czar/config";
import type { Signer } from "@czar/signer";
import type { SafeFetch } from "@czar/x402";
import type { Pool } from "pg";
import {
  acquireExecutorLease,
  appendExecutionPhase,
  getExecutionTrace,
  releaseExecutorLease,
  startExecutorLeaseRenewal,
  type ExecutionPhaseRow,
} from "#src/payer/executions";

export const PULLBACK_CANCEL_DELAY_BLOCKS = 3000n;
const MILLISECONDS_PER_HOUR = 3_600_000;

export interface PullbackValueInput {
  readonly outstanding: bigint;
  readonly pending: bigint;
  readonly availableBalance: bigint;
  readonly maxFee: bigint;
  readonly safety: bigint;
}

export interface PullbackBurnIntentInput {
  readonly vault: Address;
  readonly pocket: Address;
  readonly gatewayWallet: Address;
  readonly gatewayMinter: Address;
  readonly usdc: Address;
  readonly gatewayDomain: number;
  readonly value: bigint;
  readonly maxFee: bigint;
  readonly maxBlockHeight: bigint;
  readonly salt: Hash32;
}

export interface PullbackBurnIntentResult {
  readonly intent: BurnIntent;
  readonly encodedTransferSpec: `0x${string}`;
  readonly transferSpecHash: Hash32;
}

export interface PullbackRecord {
  readonly pullbackId: bigint;
  readonly value: bigint;
  readonly maxFee: bigint;
  readonly maxBlockHeight: bigint;
  readonly salt: Hash32;
  readonly transferSpecHash: Hash32;
  readonly state: "Pending" | "Confirmed" | "Cancelled";
}

export interface PullbackInput extends Omit<
  PullbackBurnIntentInput,
  "value" | "maxFee" | "maxBlockHeight" | "salt"
> {
  readonly planId: string;
  readonly stepIndex: number;
  readonly envelopeRef: string;
  readonly outstanding: bigint;
  readonly pending: bigint;
  readonly availableBalance: bigint;
  readonly head: bigint;
  readonly attempt?: number;
  readonly workerId?: string;
}

export interface PullbackChain {
  findPendingPullback(pocket: Address): Promise<PullbackRecord | undefined>;
  requestPullback(input: {
    readonly pocket: Address;
    readonly value: bigint;
    readonly maxFee: bigint;
    readonly maxBlockHeight: bigint;
    readonly transaction: `0x${string}`;
  }): Promise<PullbackRecord>;
  isTransferSpecHashUsed(hash: Hash32): Promise<boolean>;
  mintAttestation(transaction: `0x${string}`): Promise<string>;
  confirmPullback(input: {
    readonly pullbackId: bigint;
    readonly transaction: `0x${string}`;
  }): Promise<string>;
  cancelPullback(input: {
    readonly pullbackId: bigint;
    readonly transaction: `0x${string}`;
  }): Promise<string>;
  readPullback(pullbackId: bigint): Promise<PullbackRecord | undefined>;
  getBlockNumber(): Promise<bigint>;
}

export interface CancelPullbackInput {
  readonly planId: string;
  readonly stepIndex: number;
  readonly envelopeRef: string;
  readonly pullbackId: bigint;
  readonly attempt?: number;
  readonly workerId?: string;
}

export interface PullbackDependencies {
  readonly pool: Pool;
  readonly config: Config;
  readonly signer: Pick<Signer, "sign">;
  readonly chain: PullbackChain;
  readonly safeFetch: SafeFetch;
  readonly gatewayTransferUrl: string;
  readonly now: () => Date;
}

export interface SlowPullbackInput {
  readonly planId: string;
  readonly stepIndex: number;
  readonly envelopeRef: string;
  readonly pocket: Address;
  readonly apiUnavailableSince: Date;
  readonly value: bigint;
  readonly attempt?: number;
  readonly workerId?: string;
}

export interface SlowPullbackDependencies {
  readonly pool: Pool;
  readonly config: Config;
  readonly signer: Pick<Signer, "sign">;
  readonly chain: {
    getBlockNumber(): Promise<bigint>;
    withdrawalBlock(pocket: Address): Promise<bigint>;
    pocketUsdcBalance(pocket: Address): Promise<bigint>;
    sendPocketTransaction(transaction: `0x${string}`, kind: string): Promise<string>;
  };
  readonly now: () => Date;
}

export function calculatePullbackValue(input: PullbackValueInput): bigint {
  const outstanding = input.outstanding - input.pending;
  const balance = input.availableBalance - input.maxFee - input.safety;
  if (outstanding <= 0n || balance <= 0n) return 0n;
  return outstanding < balance ? outstanding : balance;
}

export async function executeSlowPullbackFallback(
  input: SlowPullbackInput,
  dependencies: SlowPullbackDependencies,
): Promise<
  | { readonly state: "waiting-withdrawal" }
  | { readonly state: "waiting-return" }
  | { readonly state: "manual-return-required"; readonly amount: string }
> {
  const delayMs =
    Number(dependencies.config.get("payer.pullbackApiDownHours")) * MILLISECONDS_PER_HOUR;
  if (dependencies.now().getTime() - input.apiUnavailableSince.getTime() < delayMs)
    throw new Error("Gateway API downtime has not reached the slow-withdraw threshold.");
  const attempt = input.attempt ?? 0;
  const workerId = input.workerId ?? `pullback-slow-${process.pid}`;
  const ttl = Number(dependencies.config.get("payer.leaseSeconds"));
  const leased = await acquireExecutorLease(
    dependencies.pool,
    input.envelopeRef,
    workerId,
    ttl,
    dependencies.now,
  );
  if (!leased) throw new Error("Another payer executor holds the envelope lease.");
  const renewal = startExecutorLeaseRenewal(
    dependencies.pool,
    input.envelopeRef,
    workerId,
    ttl,
    dependencies.now,
  );
  try {
    return await runSlowPullback(input, dependencies, attempt, renewal.assertHeld);
  } finally {
    await renewal.stop();
    await releaseExecutorLease(dependencies.pool, input.envelopeRef, workerId);
  }
}

async function runSlowPullback(
  input: SlowPullbackInput,
  dependencies: SlowPullbackDependencies,
  attempt: number,
  assertLeaseHeld: () => void,
): Promise<
  | { readonly state: "waiting-withdrawal" }
  | { readonly state: "waiting-return" }
  | { readonly state: "manual-return-required"; readonly amount: string }
> {
  const trace = await getExecutionTrace(dependencies.pool, input.planId, input.stepIndex, attempt);
  if (!trace.some((row) => row.phase === "pullback.slow.initiated")) {
    await sendSlowWithdrawal(input, dependencies, attempt, "initiate", assertLeaseHeld);
    return { state: "waiting-withdrawal" };
  }
  if (!trace.some((row) => row.phase === "pullback.slow.withdrawn")) {
    const head = await dependencies.chain.getBlockNumber();
    const availableAt = await dependencies.chain.withdrawalBlock(input.pocket);
    if (head < availableAt) return { state: "waiting-withdrawal" };
    await sendSlowWithdrawal(input, dependencies, attempt, "withdraw", assertLeaseHeld);
    return { state: "waiting-return" };
  }
  return await returnSlowWithdrawalBalance(input, dependencies, attempt, assertLeaseHeld);
}

async function sendSlowWithdrawal(
  input: SlowPullbackInput,
  dependencies: SlowPullbackDependencies,
  attempt: number,
  step: "initiate" | "withdraw",
  assertLeaseHeld: () => void,
): Promise<void> {
  const signed = await dependencies.signer.sign("cz-15", {
    keyId: `K4:${input.pocket}`,
    kind: "pocket-slow-withdraw",
    payload: {
      pocket: input.pocket,
      step,
      ...(step === "initiate" ? { value: input.value.toString() } : {}),
    },
  });
  if (!("signedTransaction" in signed)) throw new Error(`K4 did not sign slow withdrawal ${step}.`);
  const phase = step === "initiate" ? "pullback.slow.initiate" : "pullback.slow.withdraw";
  await writeSlowPhase(dependencies, input, attempt, `${phase}.sent`, {
    transaction: signed.signedTransaction,
  });
  assertLeaseHeld();
  const txHash = await dependencies.chain.sendPocketTransaction(signed.signedTransaction, phase);
  await writeSlowPhase(
    dependencies,
    input,
    attempt,
    `${phase === "pullback.slow.initiate" ? "pullback.slow.initiated" : "pullback.slow.withdrawn"}`,
    { txHash },
  );
}

async function returnSlowWithdrawalBalance(
  input: SlowPullbackInput,
  dependencies: SlowPullbackDependencies,
  attempt: number,
  assertLeaseHeld: () => void,
): Promise<{ readonly state: "manual-return-required"; readonly amount: string }> {
  const amount = await dependencies.chain.pocketUsdcBalance(input.pocket);
  if (amount > 0n) {
    const signed = await dependencies.signer.sign("cz-15", {
      keyId: `K4:${input.pocket}`,
      kind: "pocket-return",
      payload: { pocket: input.pocket, kind: "usdc", amount: amount.toString() },
    });
    if (!("signedTransaction" in signed))
      throw new Error("K4 did not sign the USDC pocket return.");
    await writeSlowPhase(dependencies, input, attempt, "pullback.slow.return.sent", {
      amount: amount.toString(),
      transaction: signed.signedTransaction,
    });
    assertLeaseHeld();
    const txHash = await dependencies.chain.sendPocketTransaction(
      signed.signedTransaction,
      "pocket-return:usdc",
    );
    await writeSlowPhase(dependencies, input, attempt, "pullback.slow.returned", {
      amount: amount.toString(),
      txHash,
    });
  }
  return { state: "manual-return-required", amount: amount.toString() };
}

async function writeSlowPhase(
  dependencies: SlowPullbackDependencies,
  input: SlowPullbackInput,
  attempt: number,
  phase: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<void> {
  await appendExecutionPhase(dependencies.pool, {
    planId: input.planId,
    stepIndex: input.stepIndex,
    attempt,
    phase,
    payload,
  });
}

export function pullbackMaxBlockHeight(head: bigint, windowBlocks: bigint): bigint {
  if (head < 0n || windowBlocks <= 0n) throw new RangeError("Invalid pullback block window.");
  return head + windowBlocks;
}

export function buildPullbackBurnIntent(input: PullbackBurnIntentInput): PullbackBurnIntentResult {
  const gatewayWallet = addressToBytes32(input.gatewayWallet);
  const gatewayMinter = addressToBytes32(input.gatewayMinter);
  const usdc = addressToBytes32(input.usdc);
  const vault = addressToBytes32(input.vault);
  const spec: TransferSpec = {
    version: 1,
    sourceDomain: input.gatewayDomain,
    destinationDomain: input.gatewayDomain,
    sourceContract: gatewayWallet,
    destinationContract: gatewayMinter,
    sourceToken: usdc,
    destinationToken: usdc,
    sourceDepositor: addressToBytes32(input.pocket),
    destinationRecipient: vault,
    sourceSigner: vault,
    destinationCaller: `0x${"0".repeat(64)}`,
    value: input.value,
    salt: input.salt,
    hookData: "0x",
  };
  return {
    intent: { maxBlockHeight: input.maxBlockHeight, maxFee: input.maxFee, spec },
    encodedTransferSpec: transferSpecBytes(spec),
    transferSpecHash: transferSpecHash(spec),
  };
}

export async function executePullback(
  input: PullbackInput,
  dependencies: PullbackDependencies,
): Promise<{ readonly state: "confirmed"; readonly pullbackId: string; readonly value: string }> {
  const workerId = input.workerId ?? `pullback-${process.pid}`;
  const attempt = input.attempt ?? 0;
  const leaseSeconds = Number(dependencies.config.get("payer.leaseSeconds"));
  const leased = await acquireExecutorLease(
    dependencies.pool,
    input.envelopeRef,
    workerId,
    leaseSeconds,
    dependencies.now,
  );
  if (!leased) throw new Error("Another payer executor holds the envelope lease.");
  const renewal = startExecutorLeaseRenewal(
    dependencies.pool,
    input.envelopeRef,
    workerId,
    leaseSeconds,
    dependencies.now,
  );
  try {
    return await runPullback(input, dependencies, attempt, renewal.assertHeld);
  } finally {
    await renewal.stop();
    await releaseExecutorLease(dependencies.pool, input.envelopeRef, workerId);
  }
}

export async function cancelExpiredPullback(
  input: CancelPullbackInput,
  dependencies: PullbackDependencies,
): Promise<string> {
  const attempt = input.attempt ?? 0;
  const workerId = input.workerId ?? `pullback-cancel-${process.pid}`;
  const ttl = Number(dependencies.config.get("payer.leaseSeconds"));
  const leased = await acquireExecutorLease(
    dependencies.pool,
    input.envelopeRef,
    workerId,
    ttl,
    dependencies.now,
  );
  if (!leased) throw new Error("Another payer executor holds the envelope lease.");
  const renewal = startExecutorLeaseRenewal(
    dependencies.pool,
    input.envelopeRef,
    workerId,
    ttl,
    dependencies.now,
  );
  try {
    return await runCancelExpiredPullback(input, dependencies, attempt, renewal.assertHeld);
  } finally {
    await renewal.stop();
    await releaseExecutorLease(dependencies.pool, input.envelopeRef, workerId);
  }
}

async function runCancelExpiredPullback(
  input: CancelPullbackInput,
  dependencies: PullbackDependencies,
  attempt: number,
  assertLeaseHeld: () => void,
): Promise<string> {
  const record = await dependencies.chain.readPullback(input.pullbackId);
  if (!record || record.state !== "Pending") throw new Error("Pullback is not pending.");
  const head = await dependencies.chain.getBlockNumber();
  if (head < record.maxBlockHeight + PULLBACK_CANCEL_DELAY_BLOCKS)
    throw new Error("Pullback cancellation delay has not elapsed.");
  if (await dependencies.chain.isTransferSpecHashUsed(record.transferSpecHash))
    throw new Error("A minted pullback cannot be cancelled.");
  const trace = await getExecutionTrace(dependencies.pool, input.planId, input.stepIndex, attempt);
  const saved = trace.findLast(
    (row) =>
      row.phase === "pullback.cancel.sent" &&
      row.payload["pullbackId"] === input.pullbackId.toString(),
  );
  let transaction = saved?.payload["transaction"];
  if (typeof transaction !== "string") {
    const signed = await dependencies.signer.sign("cz-15", {
      keyId: "K3",
      kind: "vault-call",
      payload: { selector: "cancelPullback", args: [input.pullbackId] },
    });
    if (!("signedTransaction" in signed)) throw new Error("K3 did not sign cancelPullback.");
    transaction = signed.signedTransaction;
    await appendExecutionPhase(dependencies.pool, {
      planId: input.planId,
      stepIndex: input.stepIndex,
      attempt,
      phase: "pullback.cancel.sent",
      payload: { pullbackId: input.pullbackId.toString(), transaction },
    });
  }
  assertLeaseHeld();
  const txHash = await dependencies.chain.cancelPullback({
    pullbackId: input.pullbackId,
    transaction: transaction as `0x${string}`,
  });
  await appendExecutionPhase(dependencies.pool, {
    planId: input.planId,
    stepIndex: input.stepIndex,
    attempt,
    phase: "pullback.cancelled",
    payload: { pullbackId: input.pullbackId.toString(), txHash },
  });
  return txHash;
}

async function runPullback(
  input: PullbackInput,
  dependencies: PullbackDependencies,
  attempt: number,
  assertLeaseHeld: () => void,
): Promise<{ readonly state: "confirmed"; readonly pullbackId: string; readonly value: string }> {
  const trace = await getExecutionTrace(dependencies.pool, input.planId, input.stepIndex, attempt);
  const pullback = await recoverOrRequestPullback(
    input,
    dependencies,
    attempt,
    trace,
    assertLeaseHeld,
  );
  const intent = buildPullbackBurnIntent({
    vault: input.vault,
    pocket: input.pocket,
    gatewayWallet: input.gatewayWallet,
    gatewayMinter: input.gatewayMinter,
    usdc: input.usdc,
    gatewayDomain: input.gatewayDomain,
    value: pullback.value,
    maxFee: pullback.maxFee,
    maxBlockHeight: pullback.maxBlockHeight,
    salt: pullback.salt,
  });
  const transfer = await obtainAttestation(
    input,
    dependencies,
    attempt,
    pullback,
    intent,
    trace,
    assertLeaseHeld,
  );
  const used = await dependencies.chain.isTransferSpecHashUsed(pullback.transferSpecHash);
  if (!used)
    await mintAttestation(input, dependencies, attempt, pullback, transfer, trace, assertLeaseHeld);
  if (!(await dependencies.chain.isTransferSpecHashUsed(pullback.transferSpecHash)))
    throw new Error("Gateway attestation has not been minted yet.");
  const latestTrace = await getExecutionTrace(
    dependencies.pool,
    input.planId,
    input.stepIndex,
    attempt,
  );
  const savedConfirm = latestTrace.findLast((row) => row.phase === "pullback.confirmed");
  if (!savedConfirm) {
    const transaction = await signVaultCall(dependencies, input.vault, "confirmPullback", [
      pullback.pullbackId,
    ]);
    await writePullbackPhase(dependencies, input, attempt, "pullback.confirm.sent", {
      pullbackId: pullback.pullbackId.toString(),
      transaction,
    });
    assertLeaseHeld();
    const txHash = await dependencies.chain.confirmPullback({
      pullbackId: pullback.pullbackId,
      transaction,
    });
    await writePullbackPhase(dependencies, input, attempt, "pullback.confirmed", {
      pullbackId: pullback.pullbackId.toString(),
      txHash,
    });
  }
  return {
    state: "confirmed",
    pullbackId: pullback.pullbackId.toString(),
    value: pullback.value.toString(),
  };
}

async function recoverOrRequestPullback(
  input: PullbackInput,
  dependencies: PullbackDependencies,
  attempt: number,
  trace: readonly ExecutionPhaseRow[],
  assertLeaseHeld: () => void,
): Promise<PullbackRecord> {
  const stored = trace.findLast((row) => row.phase === "pullback.requested");
  const cancelled = trace.findLast((row) => row.phase === "pullback.cancelled");
  if (stored && (!cancelled || cancelled.payload["pullbackId"] !== stored.payload["pullbackId"]))
    return parsePullbackRecord(stored.payload);
  const pending = await dependencies.chain.findPendingPullback(input.pocket);
  if (pending) {
    await writePullbackPhase(
      dependencies,
      input,
      attempt,
      "pullback.requested",
      serializePullback(pending),
    );
    return pending;
  }
  const maxFee = BigInt(Number(dependencies.config.get("payer.pullbackMaxFeeAtomic")));
  const safety = BigInt(Number(dependencies.config.get("payer.pullbackSafetyAtomic")));
  const value = calculatePullbackValue({
    outstanding: input.outstanding,
    pending: input.pending,
    availableBalance: input.availableBalance,
    maxFee,
    safety,
  });
  if (value <= 0n)
    throw new Error("Pocket has no pullback value after pending, fee, and safety headroom.");
  const windowBlocks = BigInt(Number(dependencies.config.get("payer.pullbackWindowBlocks")));
  const maxBlockHeight = pullbackMaxBlockHeight(input.head, windowBlocks);
  const transaction = await signVaultCall(dependencies, input.vault, "requestPullback", [
    input.pocket,
    value,
    maxFee,
    maxBlockHeight,
  ]);
  await writePullbackPhase(dependencies, input, attempt, "pullback.request.sent", {
    pocket: input.pocket,
    value: value.toString(),
    maxFee: maxFee.toString(),
    maxBlockHeight: maxBlockHeight.toString(),
    transaction,
  });
  assertLeaseHeld();
  const requested = await dependencies.chain.requestPullback({
    pocket: input.pocket,
    value,
    maxFee,
    maxBlockHeight,
    transaction,
  });
  await writePullbackPhase(
    dependencies,
    input,
    attempt,
    "pullback.requested",
    serializePullback(requested),
  );
  return requested;
}

async function obtainAttestation(
  input: PullbackInput,
  dependencies: PullbackDependencies,
  attempt: number,
  pullback: PullbackRecord,
  intent: PullbackBurnIntentResult,
  trace: readonly ExecutionPhaseRow[],
  assertLeaseHeld: () => void,
): Promise<{ readonly attestation: `0x${string}`; readonly signature: `0x${string}` }> {
  const saved = trace.findLast((row) => row.phase === "pullback.transfer.result");
  if (
    saved &&
    typeof saved.payload["attestation"] === "string" &&
    typeof saved.payload["signature"] === "string"
  )
    return {
      attestation: saved.payload["attestation"] as `0x${string}`,
      signature: saved.payload["signature"] as `0x${string}`,
    };
  const signed = await dependencies.signer.sign("cz-15", {
    keyId: "K3",
    kind: "gateway-burn",
    payload: { vault: input.vault, pullbackId: pullback.pullbackId.toString() },
  });
  if (!("signature" in signed)) throw new Error("K3 did not return a GATEWAY_BURN signature.");
  await writePullbackPhase(dependencies, input, attempt, "pullback.transfer.sent", {
    pullbackId: pullback.pullbackId.toString(),
    transferSpecHash: pullback.transferSpecHash,
    signature: signed.signature,
  });
  assertLeaseHeld();
  const response = await dependencies.safeFetch(dependencies.gatewayTransferUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    timeoutMs: Number(dependencies.config.get("fetch.timeoutMs")),
    body: new TextEncoder().encode(
      JSON.stringify({
        transferSpec: intent.encodedTransferSpec,
        signature: signed.signature,
        contractSigner: true,
      }),
    ),
  });
  if (response.status < 200 || response.status >= 300)
    throw new Error(`Gateway transfer API failed with HTTP ${response.status}.`);
  const result = parseTransferAttestation(response.body);
  await writePullbackPhase(dependencies, input, attempt, "pullback.transfer.result", {
    pullbackId: pullback.pullbackId.toString(),
    transferId: result.transferId,
    attestation: result.attestation,
    signature: result.signature,
  });
  return result;
}

async function mintAttestation(
  input: PullbackInput,
  dependencies: PullbackDependencies,
  attempt: number,
  pullback: PullbackRecord,
  transfer: { readonly attestation: `0x${string}`; readonly signature: `0x${string}` },
  trace: readonly ExecutionPhaseRow[],
  assertLeaseHeld: () => void,
): Promise<void> {
  const prior = trace.findLast((row) => row.phase === "pullback.mint.sent");
  let transaction = prior?.payload["transaction"];
  if (typeof transaction !== "string") {
    const signed = await dependencies.signer.sign("cz-15", {
      keyId: "relayer",
      kind: "relayer-tx",
      payload: {
        to: input.gatewayMinter,
        selector: "gatewayMint",
        args: { attestationPayload: transfer.attestation, signature: transfer.signature },
      },
    });
    if (!("signedTransaction" in signed)) throw new Error("Relayer did not sign gatewayMint.");
    transaction = signed.signedTransaction;
    await writePullbackPhase(dependencies, input, attempt, "pullback.mint.sent", {
      pullbackId: pullback.pullbackId.toString(),
      transaction,
    });
  }
  assertLeaseHeld();
  const txHash = await dependencies.chain.mintAttestation(transaction as `0x${string}`);
  await writePullbackPhase(dependencies, input, attempt, "pullback.minted", {
    pullbackId: pullback.pullbackId.toString(),
    txHash,
  });
}

function parseTransferAttestation(body: Uint8Array): {
  readonly transferId: string;
  readonly attestation: `0x${string}`;
  readonly signature: `0x${string}`;
} {
  const value = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
  if (
    typeof value["transferId"] !== "string" ||
    typeof value["attestation"] !== "string" ||
    typeof value["signature"] !== "string"
  )
    throw new Error("Gateway transfer response is missing attestation fields.");
  return {
    transferId: value["transferId"],
    attestation: value["attestation"] as `0x${string}`,
    signature: value["signature"] as `0x${string}`,
  };
}

function serializePullback(pullback: PullbackRecord): Readonly<Record<string, unknown>> {
  return {
    pullbackId: pullback.pullbackId.toString(),
    value: pullback.value.toString(),
    maxFee: pullback.maxFee.toString(),
    maxBlockHeight: pullback.maxBlockHeight.toString(),
    salt: pullback.salt,
    transferSpecHash: pullback.transferSpecHash,
    state: pullback.state,
  };
}

function parsePullbackRecord(value: Readonly<Record<string, unknown>>): PullbackRecord {
  if (
    typeof value["pullbackId"] !== "string" ||
    typeof value["value"] !== "string" ||
    typeof value["maxFee"] !== "string" ||
    typeof value["maxBlockHeight"] !== "string" ||
    typeof value["salt"] !== "string" ||
    typeof value["transferSpecHash"] !== "string" ||
    (value["state"] !== "Pending" &&
      value["state"] !== "Confirmed" &&
      value["state"] !== "Cancelled")
  )
    throw new Error("Stored pullback record is malformed.");
  return {
    pullbackId: BigInt(value["pullbackId"]),
    value: BigInt(value["value"]),
    maxFee: BigInt(value["maxFee"]),
    maxBlockHeight: BigInt(value["maxBlockHeight"]),
    salt: value["salt"] as Hash32,
    transferSpecHash: value["transferSpecHash"] as Hash32,
    state: value["state"],
  };
}

async function writePullbackPhase(
  dependencies: PullbackDependencies,
  input: PullbackInput,
  attempt: number,
  phase: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<void> {
  await appendExecutionPhase(dependencies.pool, {
    planId: input.planId,
    stepIndex: input.stepIndex,
    attempt,
    phase,
    payload,
  });
}

async function signVaultCall(
  dependencies: PullbackDependencies,
  vault: Address,
  selector: string,
  args: readonly unknown[],
): Promise<`0x${string}`> {
  const result = await dependencies.signer.sign("cz-15", {
    keyId: "K3",
    kind: "vault-call",
    payload: { vault, selector, args },
  });
  if (!("signedTransaction" in result)) throw new Error(`K3 did not sign ${selector}.`);
  return result.signedTransaction;
}
