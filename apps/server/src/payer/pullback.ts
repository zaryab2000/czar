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
import { Denied, type Signer } from "@czar/signer";
import type { SafeFetch } from "@czar/x402";
import type { Pool } from "pg";
import { keccak256 } from "viem";
import { PULLBACK_CANCEL_DELAY_BLOCKS } from "@czar/vault-client";
import { randomUUID } from "node:crypto";
import {
  acquireExecutorLease,
  appendExecutionPhase,
  getExecutionTrace,
  releaseExecutorLease,
  startExecutorLeaseRenewal,
  type ExecutionPhaseRow,
} from "#src/payer/executions";
import type { PocketBalanceSnapshot } from "#src/payer/indexer-pocket";

export { PULLBACK_CANCEL_DELAY_BLOCKS };
const MILLISECONDS_PER_HOUR = 3_600_000;
const SLOW_WITHDRAW_RETRY_RULES = new Set([
  "gateway-figure-missing",
  "pocket-spend-after-observation",
  "slow-withdraw-value-mismatch",
]);
/** SCR-152 §1: the signer's prepared transaction governs the returnable value; re-read and retry. */
const POCKET_RETURN_RETRY_RULES = new Set(["pocket-return-value-mismatch", "pocket-empty"]);

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
  readonly availableBalanceObservedAt: Date | null;
  readonly apiConsecutiveFailures: number;
  readonly closedPocket?: boolean;
  readonly head: bigint;
  readonly attempt?: number;
  readonly workerId?: string;
}

export interface PullbackChain {
  maxPullbackFee(): Promise<bigint>;
  writeOffPocket(pocket: Address, transaction: `0x${string}`): Promise<string>;
  pocketWriteOffStatus?(pocket: Address): Promise<{
    readonly state: "registered" | "funded" | "draining" | "closed" | "unsupported";
    readonly pendingPullback: bigint;
  }>;
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
  readonly vault: Address;
  readonly gatewayMinter: Address;
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
  readonly vault: Address;
  readonly usdc: Address;
  readonly apiUnavailableSince: Date;
  readonly value: bigint;
  readonly trigger?: "api-down" | "closed-dust";
  readonly closedPocketRecovery?: boolean;
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
    withdrawingBalance(pocket: Address): Promise<bigint>;
    /**
     * SCR-152 `returnable = balanceOf(USDC, pocket) − gasReserve` of a `pocket-return` to `vault`, from fresh
     * reads; `≤ 0` means the pocket EOA is empty.
     */
    pocketReturnable(pocket: Address, vault: Address): Promise<bigint>;
    sendPocketTransaction(transaction: `0x${string}`, kind: string): Promise<string>;
    transactionReceipt(hash: string): Promise<SlowPullbackReceipt | null>;
  };
  /** The pocket's `pocket_balances` row: the SCR-141 Gateway figure SCR-153 "Gateway clear" reads. */
  readonly readGatewayBalance: (pocket: Address) => Promise<PocketBalanceSnapshot>;
  readonly now: () => Date;
}

export type SlowPullbackResult =
  | { readonly state: "waiting-withdrawal" }
  | { readonly state: "waiting-return" }
  | { readonly state: "manual-return-required"; readonly amount: string }
  | { readonly state: "returned-to-vault"; readonly amount: string };

/** The slow-path row's transaction columns that SCR-153 "Gateway clear" reads. */
export interface GatewayClearRow {
  readonly initiateTx: string | null;
  readonly withdrawTx: string | null;
}

/** Fresh chain reads, and the SCR-141 Gateway figure, for one SCR-153 resume pass. */
export interface GatewayClearReads {
  readonly withdrawingBalance: bigint;
  readonly initiateReceipt: SlowPullbackReceipt | null;
  readonly withdrawReceipt: SlowPullbackReceipt | null;
  /** Gateway available, fresh or the last good observation (SCR-141); `null` when none exists. */
  readonly gatewayAvailable: bigint | null;
}

interface SlowPathRow extends GatewayClearRow {
  readonly returnTx: string | null;
}

/** One slow-path pass for one row, under the envelope lease. */
interface SlowPass {
  readonly input: SlowPullbackInput;
  readonly dependencies: SlowPullbackDependencies;
  readonly attempt: number;
  readonly assertLeaseHeld: () => void;
}

export interface SlowPullbackReceipt {
  readonly status: "success" | "reverted";
  readonly blockNumber: bigint;
  readonly logs: readonly {
    readonly address: Address;
    readonly from: Address;
    readonly to: Address;
    readonly value: bigint;
    readonly logIndex: number;
  }[];
}

export function calculatePullbackValue(input: PullbackValueInput): bigint {
  const outstanding = input.outstanding - input.pending;
  const balance = input.availableBalance - input.maxFee - input.safety;
  if (outstanding <= 0n || balance <= 0n) return 0n;
  return outstanding < balance ? outstanding : balance;
}

export function calculateClosedPocketPullbackValue(
  availableBalance: bigint,
  maxFee: bigint,
  safety: bigint,
): bigint {
  const headroom = maxFee + safety;
  return availableBalance > headroom ? availableBalance - headroom : 0n;
}

export async function executeSlowPullbackFallback(
  input: SlowPullbackInput,
  dependencies: SlowPullbackDependencies,
): Promise<SlowPullbackResult> {
  const delayMs =
    Number(dependencies.config.get("payer.pullbackApiDownHours")) * MILLISECONDS_PER_HOUR;
  if (
    input.trigger !== "closed-dust" &&
    dependencies.now().getTime() - input.apiUnavailableSince.getTime() < delayMs
  )
    throw new Error("Gateway API downtime has not reached the slow-withdraw threshold.");
  const initialAttempt = input.attempt ?? 0;
  const workerId = input.workerId ?? `pullback-slow-${process.pid}-${randomUUID()}`;
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
    const attempt = input.closedPocketRecovery
      ? await nextClosedPocketRecoveryAttempt(
          dependencies.pool,
          input.planId,
          input.stepIndex,
          initialAttempt,
        )
      : initialAttempt;
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
): Promise<SlowPullbackResult> {
  await ensureSlowPathRow(input, dependencies, attempt);
  const pass: SlowPass = { input, dependencies, attempt, assertLeaseHeld };
  const withdrawingBalance = await dependencies.chain.withdrawingBalance(input.pocket);
  if (withdrawingBalance > 0n) {
    const observedWithdrawalBlock = await dependencies.chain.withdrawalBlock(input.pocket);
    const head = await dependencies.chain.getBlockNumber();
    if (head < observedWithdrawalBlock) return { state: "waiting-withdrawal" };
    await sendSlowWithdrawal(pass, { step: "withdraw" });
    return { state: "waiting-return" };
  }
  const row = await readSlowPathRow(dependencies, input);
  const initiateReceipt = await receiptOf(dependencies, row.initiateTx);
  const withdrawReceipt = await receiptOf(dependencies, row.withdrawTx);
  const withdrawMined = withdrawReceipt?.status === "success";
  if (initiateReceipt?.status === "success" && !withdrawMined)
    throw new Error(
      "SCR-153: withdrawingBalance is 0 after a mined initiate_tx without a mined withdraw_tx; " +
        "the slow-path resume table has no row for this state.",
    );
  // A mined withdraw is Gateway clear on its own, so the indexer figure is read only when it decides.
  const reads: GatewayClearReads = {
    withdrawingBalance,
    initiateReceipt,
    withdrawReceipt,
    gatewayAvailable: withdrawMined ? null : await readGatewayFigure(dependencies, input.pocket),
  };
  if (!isGatewayClear(row, reads)) return await advanceSlowWithdrawal(pass, row, reads);
  return await returnAfterGatewayClear(pass, row);
}

/**
 * SCR-153 §1 "Gateway clear": the row's `withdraw_tx` is mined with status 1, or nothing is withdrawing, no
 * `initiate_tx` is in flight and the SCR-141 Gateway available figure (fresh or last good) is 0.
 */
export function isGatewayClear(row: GatewayClearRow, reads: GatewayClearReads): boolean {
  if (row.withdrawTx !== null && reads.withdrawReceipt?.status === "success") return true;
  if (reads.withdrawingBalance !== 0n) return false;
  const initiateInFlight = row.initiateTx !== null && reads.initiateReceipt === null;
  return !initiateInFlight && reads.gatewayAvailable === 0n;
}

/** The SCR-141 figure V is read from; `null` when the Gateway API has never been observed for the pocket. */
async function readGatewayFigure(
  dependencies: SlowPullbackDependencies,
  pocket: Address,
): Promise<bigint | null> {
  let snapshot;
  try {
    snapshot = await dependencies.readGatewayBalance(pocket);
  } catch {
    // An unreadable figure is a missing figure: the row waits and records `gateway-figure-missing`.
    return null;
  }
  return snapshot.apiObservedAt === null ? null : snapshot.gatewayAvailableAtomic;
}

/** SCR-153 §1 row 3: not Gateway clear and nothing withdrawing, so K4 `initiate` (or its re-broadcast). */
async function advanceSlowWithdrawal(
  pass: SlowPass,
  row: SlowPathRow,
  reads: GatewayClearReads,
): Promise<{ readonly state: "waiting-withdrawal" }> {
  const { input, dependencies, attempt } = pass;
  const inFlight = row.initiateTx !== null && reads.initiateReceipt === null;
  if (!inFlight && reads.gatewayAvailable === null) {
    await writeSlowPhase(dependencies, input, attempt, "pullback.slow.gateway-figure-missing", {
      pocket: input.pocket,
    });
    return { state: "waiting-withdrawal" };
  }
  const reverted = reads.initiateReceipt?.status === "reverted";
  if (reverted)
    await dependencies.pool.query(
      `UPDATE payer_pullback_gateway_failures SET initiate_tx=NULL
       WHERE plan_id=$1 AND step_index=$2 AND attempt=$3`,
      [input.planId, input.stepIndex, attempt],
    );
  await sendSlowWithdrawal(pass, { step: "initiate", value: reads.gatewayAvailable }, reverted);
  return { state: "waiting-withdrawal" };
}

async function sendSlowWithdrawal(
  pass: SlowPass,
  request:
    | { readonly step: "initiate"; readonly value: bigint | null }
    | { readonly step: "withdraw" },
  forceResign = false,
): Promise<void> {
  const { input, dependencies, attempt } = pass;
  const phase = request.step === "initiate" ? "pullback.slow.initiate" : "pullback.slow.withdraw";
  const trace = await getExecutionTrace(dependencies.pool, input.planId, input.stepIndex, attempt);
  const prior = forceResign ? undefined : trace.findLast((row) => row.phase === `${phase}.sent`);
  let transaction = prior?.payload["transaction"];
  if (typeof transaction !== "string") {
    const signed = await signSlowWithdrawal(pass, request);
    if (signed === null) return;
    transaction = signed;
    await writeSlowPhase(dependencies, input, attempt, `${phase}.sent`, { transaction });
  }
  await persistSlowTransactionHash(
    dependencies,
    input,
    attempt,
    request.step,
    keccak256(transaction as `0x${string}`),
  );
  pass.assertLeaseHeld();
  const txHash = await broadcastSlowTransaction(dependencies, transaction as `0x${string}`, phase);
  await writeSlowPhase(
    dependencies,
    input,
    attempt,
    `${phase === "pullback.slow.initiate" ? "pullback.slow.initiated" : "pullback.slow.withdrawn"}`,
    { txHash },
  );
}

/** Signs `initiate` (V by SCR-141) or `withdraw`; on an SCR-141 denial records it and returns `null`. */
async function signSlowWithdrawal(
  pass: SlowPass,
  request:
    | { readonly step: "initiate"; readonly value: bigint | null }
    | { readonly step: "withdraw" },
): Promise<`0x${string}` | null> {
  const { input, dependencies, attempt } = pass;
  if (request.step === "initiate" && request.value === null)
    throw new Error("Slow pullback initiate_tx is recorded without its signed transaction.");
  let signed;
  try {
    signed = await dependencies.signer.sign("cz-15", {
      keyId: "K4",
      kind: "pocket-slow-withdraw",
      payload: {
        pocket: input.pocket,
        step: request.step,
        ...(request.step === "initiate" ? { value: String(request.value) } : {}),
      },
    });
  } catch (error) {
    if (
      request.step !== "initiate" ||
      !(error instanceof Denied) ||
      !SLOW_WITHDRAW_RETRY_RULES.has(error.rule)
    )
      throw error;
    await writeSlowPhase(dependencies, input, attempt, `pullback.slow.${error.rule}`, {
      pocket: input.pocket,
    });
    return null;
  }
  if (!("signedTransaction" in signed))
    throw new Error(`K4 did not sign slow withdrawal ${request.step}.`);
  return signed.signedTransaction;
}

async function broadcastSlowTransaction(
  dependencies: SlowPullbackDependencies,
  transaction: `0x${string}`,
  kind: string,
): Promise<string> {
  const expectedHash = keccak256(transaction);
  const submittedHash = await dependencies.chain.sendPocketTransaction(transaction, kind);
  if (submittedHash.toLowerCase() !== expectedHash.toLowerCase())
    throw new Error(
      "Slow pullback RPC returned a hash that does not match its signed transaction.",
    );
  return expectedHash;
}

/** SCR-153 §1 rows 4–6, once the row is Gateway clear and nothing is withdrawing. */
async function returnAfterGatewayClear(
  pass: SlowPass,
  row: SlowPathRow,
): Promise<SlowPullbackResult> {
  const { input, dependencies } = pass;
  if (row.returnTx !== null) {
    const receipt = await dependencies.chain.transactionReceipt(row.returnTx);
    if (receipt === null) return await rebroadcastPocketReturn(pass, row.returnTx);
    if (receipt.status === "success") return await completeReturn(pass, row.returnTx, receipt);
  }
  const returnable = await dependencies.chain.pocketReturnable(input.pocket, input.vault);
  if (returnable <= 0n) return await recordNothingReturned(pass);
  return await sendPocketReturn(pass, returnable, row.returnTx === null);
}

async function rebroadcastPocketReturn(
  pass: SlowPass,
  returnTx: string,
): Promise<SlowPullbackResult> {
  const { input, dependencies, attempt } = pass;
  const trace = await getExecutionTrace(dependencies.pool, input.planId, input.stepIndex, attempt);
  const transaction = trace.findLast((entry) => entry.phase === "pullback.slow.return.sent")
    ?.payload["transaction"];
  if (
    typeof transaction !== "string" ||
    keccak256(transaction as `0x${string}`).toLowerCase() !== returnTx.toLowerCase()
  )
    throw new Error("Slow pullback return_tx is recorded without its signed transaction.");
  pass.assertLeaseHeld();
  await broadcastSlowTransaction(dependencies, transaction as `0x${string}`, "pocket-return:usdc");
  const receipt = await dependencies.chain.transactionReceipt(returnTx);
  if (receipt?.status !== "success") return { state: "waiting-return" };
  return await completeReturn(pass, returnTx, receipt);
}

async function sendPocketReturn(
  pass: SlowPass,
  amount: bigint,
  reuseSigned: boolean,
): Promise<SlowPullbackResult> {
  const { input, dependencies, attempt } = pass;
  const trace = await getExecutionTrace(dependencies.pool, input.planId, input.stepIndex, attempt);
  const prior = reuseSigned
    ? trace.findLast((entry) => entry.phase === "pullback.slow.return.sent")
    : undefined;
  let transaction = prior?.payload["transaction"];
  if (typeof transaction !== "string") {
    const signed = await signPocketReturn(input, dependencies, attempt, amount);
    if (signed === null) return { state: "waiting-return" };
    transaction = signed;
    await writeSlowPhase(dependencies, input, attempt, "pullback.slow.return.sent", {
      amount: amount.toString(),
      transaction,
    });
  }
  await persistSlowTransactionHash(
    dependencies,
    input,
    attempt,
    "return",
    keccak256(transaction as `0x${string}`),
  );
  pass.assertLeaseHeld();
  const txHash = await broadcastSlowTransaction(
    dependencies,
    transaction as `0x${string}`,
    "pocket-return:usdc",
  );
  await writeSlowPhase(dependencies, input, attempt, "pullback.slow.returned", {
    amount: amount.toString(),
    txHash,
  });
  const receipt = await dependencies.chain.transactionReceipt(txHash);
  if (receipt?.status !== "success") return { state: "waiting-return" };
  return await completeReturn(pass, txHash, receipt);
}

/** SCR-153 completion (c) with a return: its receipt holds one USDC `Transfer(pocket → vault)`. */
async function completeReturn(
  pass: SlowPass,
  returnTx: string,
  receipt: SlowPullbackReceipt,
): Promise<SlowPullbackResult> {
  const transfer = verifiedVaultTransfer(receipt, pass.input);
  if (!transfer)
    throw new Error("Slow pullback return_tx was mined without one USDC Transfer(pocket → vault).");
  return await recordVerifiedReturn(
    pass.input,
    pass.dependencies,
    pass.attempt,
    returnTx,
    receipt,
    transfer,
  );
}

/** SCR-153 §1 row 6: Gateway clear, `returnable ≤ 0` and no return sent: terminal with nothing returned. */
async function recordNothingReturned(pass: SlowPass): Promise<SlowPullbackResult> {
  const { input, dependencies, attempt } = pass;
  const result = await dependencies.pool.query(
    `UPDATE payer_pullback_gateway_failures SET state='returned-to-vault',returned_amount=0
     WHERE plan_id=$1 AND step_index=$2 AND attempt=$3`,
    [input.planId, input.stepIndex, attempt],
  );
  if (result.rowCount !== 1) throw new Error("Empty slow pullback completion was not persisted.");
  return { state: "returned-to-vault", amount: "0" };
}

async function readSlowPathRow(
  dependencies: SlowPullbackDependencies,
  input: SlowPullbackInput,
): Promise<SlowPathRow> {
  const result = await dependencies.pool.query<{
    readonly initiate_tx: string | null;
    readonly withdraw_tx: string | null;
    readonly return_tx: string | null;
  }>(
    `SELECT initiate_tx,withdraw_tx,return_tx FROM payer_pullback_gateway_failures
     WHERE plan_id=$1 AND step_index=$2`,
    [input.planId, input.stepIndex],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Slow pullback row is missing after it was written.");
  return { initiateTx: row.initiate_tx, withdrawTx: row.withdraw_tx, returnTx: row.return_tx };
}

async function receiptOf(
  dependencies: SlowPullbackDependencies,
  hash: string | null,
): Promise<SlowPullbackReceipt | null> {
  return hash === null ? null : await dependencies.chain.transactionReceipt(hash);
}

/** Signs the USDC return; on a SCR-152 value denial records it and leaves the retry to the next pass. */
async function signPocketReturn(
  input: SlowPullbackInput,
  dependencies: SlowPullbackDependencies,
  attempt: number,
  amount: bigint,
): Promise<`0x${string}` | null> {
  let signed;
  try {
    signed = await dependencies.signer.sign("cz-15", {
      keyId: "K4",
      kind: "pocket-return",
      payload: { pocket: input.pocket, kind: "usdc", amount: amount.toString() },
    });
  } catch (error) {
    if (!(error instanceof Denied) || !POCKET_RETURN_RETRY_RULES.has(error.rule)) throw error;
    await writeSlowPhase(dependencies, input, attempt, `pullback.slow.${error.rule}`, {
      pocket: input.pocket,
    });
    return null;
  }
  if (!("signedTransaction" in signed)) throw new Error("K4 did not sign the USDC pocket return.");
  return signed.signedTransaction;
}

async function ensureSlowPathRow(
  input: SlowPullbackInput,
  dependencies: SlowPullbackDependencies,
  attempt: number,
): Promise<void> {
  await dependencies.pool.query(
    `INSERT INTO payer_pullback_gateway_failures
       (plan_id,step_index,envelope_ref,pocket,value,unavailable_since,state,
        attempt,closed_pocket,vault_address)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9)
     ON CONFLICT (plan_id,step_index) DO UPDATE SET
       state=CASE WHEN EXCLUDED.attempt > payer_pullback_gateway_failures.attempt
         AND payer_pullback_gateway_failures.state IN ('returned-to-vault','manual-return-required')
         THEN 'pending' ELSE payer_pullback_gateway_failures.state END,
       unavailable_since=CASE WHEN EXCLUDED.attempt > payer_pullback_gateway_failures.attempt
         AND payer_pullback_gateway_failures.state IN ('returned-to-vault','manual-return-required')
         THEN EXCLUDED.unavailable_since ELSE payer_pullback_gateway_failures.unavailable_since END,
       initiate_tx=CASE WHEN EXCLUDED.attempt > payer_pullback_gateway_failures.attempt
         AND payer_pullback_gateway_failures.state IN ('returned-to-vault','manual-return-required')
         THEN NULL ELSE payer_pullback_gateway_failures.initiate_tx END,
       withdraw_tx=CASE WHEN EXCLUDED.attempt > payer_pullback_gateway_failures.attempt
         AND payer_pullback_gateway_failures.state IN ('returned-to-vault','manual-return-required')
         THEN NULL ELSE payer_pullback_gateway_failures.withdraw_tx END,
       return_tx=CASE WHEN EXCLUDED.attempt > payer_pullback_gateway_failures.attempt
         AND payer_pullback_gateway_failures.state IN ('returned-to-vault','manual-return-required')
         THEN NULL ELSE payer_pullback_gateway_failures.return_tx END,
       return_block=CASE WHEN EXCLUDED.attempt > payer_pullback_gateway_failures.attempt
         AND payer_pullback_gateway_failures.state IN ('returned-to-vault','manual-return-required')
         THEN NULL ELSE payer_pullback_gateway_failures.return_block END,
       return_log_index=CASE WHEN EXCLUDED.attempt > payer_pullback_gateway_failures.attempt
         AND payer_pullback_gateway_failures.state IN ('returned-to-vault','manual-return-required')
         THEN NULL ELSE payer_pullback_gateway_failures.return_log_index END,
       returned_amount=CASE WHEN EXCLUDED.attempt > payer_pullback_gateway_failures.attempt
         AND payer_pullback_gateway_failures.state IN ('returned-to-vault','manual-return-required')
         THEN NULL ELSE payer_pullback_gateway_failures.returned_amount END,
       value=COALESCE(EXCLUDED.value,payer_pullback_gateway_failures.value),
       attempt=GREATEST(payer_pullback_gateway_failures.attempt,EXCLUDED.attempt),
       closed_pocket=EXCLUDED.closed_pocket,vault_address=EXCLUDED.vault_address`,
    [
      input.planId,
      input.stepIndex,
      input.envelopeRef,
      input.pocket,
      input.value > 0n ? input.value.toString() : null,
      input.apiUnavailableSince,
      attempt,
      input.closedPocketRecovery ?? input.trigger === "closed-dust",
      input.vault,
    ],
  );
}

async function persistSlowTransactionHash(
  dependencies: SlowPullbackDependencies,
  input: SlowPullbackInput,
  attempt: number,
  step: "initiate" | "withdraw" | "return",
  hash: string,
): Promise<void> {
  const column = `${step}_tx`;
  const result = await dependencies.pool.query(
    `UPDATE payer_pullback_gateway_failures SET ${column}=$3
     WHERE plan_id=$1 AND step_index=$2 AND attempt=$4`,
    [input.planId, input.stepIndex, hash, attempt],
  );
  if (result.rowCount !== 1) throw new Error("Slow pullback transaction hash was not persisted.");
}

function verifiedVaultTransfer(
  receipt: SlowPullbackReceipt,
  input: SlowPullbackInput,
): SlowPullbackReceipt["logs"][number] | null {
  if (receipt.status !== "success") return null;
  const matches = receipt.logs.filter(
    (log) =>
      log.address.toLowerCase() === input.usdc.toLowerCase() &&
      log.from.toLowerCase() === input.pocket.toLowerCase() &&
      log.to.toLowerCase() === input.vault.toLowerCase() &&
      log.value > 0n,
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

async function recordVerifiedReturn(
  input: SlowPullbackInput,
  dependencies: SlowPullbackDependencies,
  attempt: number,
  txHash: string,
  receipt: SlowPullbackReceipt,
  transfer: SlowPullbackReceipt["logs"][number],
): Promise<SlowPullbackResult> {
  const [returnable, withdrawingBalance] = await Promise.all([
    dependencies.chain.pocketReturnable(input.pocket, input.vault),
    dependencies.chain.withdrawingBalance(input.pocket),
  ]);
  // SCR-153 completion (b) and (d): nothing withdrawing on a fresh read, and the EOA empty (SCR-152 §2).
  if (withdrawingBalance !== 0n) return { state: "waiting-return" };
  if (returnable > 0n)
    throw new Error(
      "SCR-153: the pocket EOA is not empty after a mined return_tx; " +
        "the slow-path resume table has no row for this state.",
    );
  const state =
    input.closedPocketRecovery || input.trigger === "closed-dust"
      ? "returned-to-vault"
      : "manual-return-required";
  const result = await dependencies.pool.query(
    `UPDATE payer_pullback_gateway_failures
     SET return_tx=$3,return_block=$4,return_log_index=$5,returned_amount=$6,state=$7,
         manual_return_required_at=CASE WHEN $7='manual-return-required'
           THEN COALESCE(manual_return_required_at,$9) ELSE manual_return_required_at END
     WHERE plan_id=$1 AND step_index=$2 AND attempt=$8`,
    [
      input.planId,
      input.stepIndex,
      txHash,
      receipt.blockNumber.toString(),
      transfer.logIndex,
      transfer.value.toString(),
      state,
      attempt,
      dependencies.now(),
    ],
  );
  if (result.rowCount !== 1) throw new Error("Verified slow pullback return was not persisted.");
  return { state, amount: transfer.value.toString() };
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
): Promise<
  | { readonly state: "confirmed"; readonly pullbackId: string; readonly value: string }
  | { readonly state: "written-off"; readonly pocket: Address }
  | { readonly state: "waiting"; readonly reason: "gateway-balance-stale" }
  | { readonly state: "waiting"; readonly reason: "closed-pocket-dust" }
  | { readonly state: "waiting"; readonly reason: "manual-return-hold" }
> {
  const workerId = input.workerId ?? `pullback-${process.pid}-${randomUUID()}`;
  const initialAttempt = input.attempt ?? 0;
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
    const attempt = input.closedPocket
      ? await nextClosedPocketAttempt(input, dependencies.pool, initialAttempt)
      : initialAttempt;
    return await runPullback(input, dependencies, attempt, renewal.assertHeld);
  } finally {
    await renewal.stop();
    await releaseExecutorLease(dependencies.pool, input.envelopeRef, workerId);
  }
}

async function nextClosedPocketAttempt(
  input: PullbackInput,
  pool: Pool,
  minimumAttempt: number,
): Promise<number> {
  return nextClosedPocketRecoveryAttempt(pool, input.planId, input.stepIndex, minimumAttempt);
}

export async function nextClosedPocketRecoveryAttempt(
  pool: Pool,
  planId: string,
  stepIndex: number,
  minimumAttempt: number,
): Promise<number> {
  const recovery = await pool.query<{ readonly attempt: number | null; readonly state: string }>(
    `SELECT attempt,state FROM payer_pullback_gateway_failures
     WHERE plan_id=$1 AND step_index=$2`,
    [planId, stepIndex],
  );
  const durable = recovery.rows[0];
  if (durable?.attempt !== null && durable?.attempt !== undefined) {
    const next = durable.state === "pending" ? durable.attempt : durable.attempt + 1;
    return Math.max(minimumAttempt, next);
  }
  const result = await pool.query<{ attempt: number; phase: string }>(
    `SELECT attempt,phase FROM step_executions
     WHERE plan_id=$1 AND step_index=$2 AND phase LIKE 'pullback.%'
     ORDER BY execution_id DESC LIMIT 1`,
    [planId, stepIndex],
  );
  const latest = result.rows[0];
  if (!latest) return minimumAttempt;
  const terminal = latest.phase === "pullback.confirmed";
  return Math.max(minimumAttempt, latest.attempt + Number(terminal));
}

export async function cancelExpiredPullback(
  input: CancelPullbackInput,
  dependencies: PullbackDependencies,
): Promise<string> {
  const attempt = input.attempt ?? 0;
  const workerId = input.workerId ?? `pullback-cancel-${process.pid}-${randomUUID()}`;
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
      payload: {
        vault: input.vault,
        selector: "cancelPullback",
        args: { pullbackId: input.pullbackId.toString() },
      },
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
): Promise<
  | { readonly state: "confirmed"; readonly pullbackId: string; readonly value: string }
  | { readonly state: "written-off"; readonly pocket: Address }
  | { readonly state: "waiting"; readonly reason: "gateway-balance-stale" }
  | { readonly state: "waiting"; readonly reason: "closed-pocket-dust" }
  | { readonly state: "waiting"; readonly reason: "manual-return-hold" }
> {
  if (!hasFreshGatewayBalance(input, dependencies)) {
    await writePullbackPhase(dependencies, input, attempt, "pullback.gateway-balance-stale", {
      ageSeconds: gatewayBalanceAgeSeconds(input, dependencies.now()),
      pocket: input.pocket,
    });
    await recordGatewayBalanceOutage(input, dependencies, attempt);
    return { state: "waiting", reason: "gateway-balance-stale" };
  }
  await clearGatewayBalanceOutage(input, dependencies, attempt);
  const configuredMaxFee = BigInt(Number(dependencies.config.get("payer.pullbackMaxFeeAtomic")));
  if (configuredMaxFee > (await dependencies.chain.maxPullbackFee()))
    throw new Error("Configured pullback max fee exceeds the vault maxPullbackFee.");
  const trace = await getExecutionTrace(dependencies.pool, input.planId, input.stepIndex, attempt);
  const pullback = await recoverOrRequestPullback(
    input,
    dependencies,
    attempt,
    trace,
    assertLeaseHeld,
  );
  if (pullback.state === "written-off" || pullback.state === "waiting") return pullback;
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
  const confirmed = await dependencies.chain.readPullback(pullback.pullbackId);
  const savedConfirm = latestTrace.findLast(
    (row) =>
      row.phase === "pullback.confirmed" &&
      row.payload["pullbackId"] === pullback.pullbackId.toString(),
  );
  if (confirmed?.state !== "Confirmed" && !savedConfirm) {
    const savedSent = latestTrace.findLast(
      (row) =>
        row.phase === "pullback.confirm.sent" &&
        row.payload["pullbackId"] === pullback.pullbackId.toString(),
    );
    let transaction = savedSent?.payload["transaction"];
    if (typeof transaction !== "string") {
      transaction = await signVaultCall(dependencies, input.vault, "confirmPullback", {
        pullbackId: pullback.pullbackId.toString(),
      });
      await writePullbackPhase(dependencies, input, attempt, "pullback.confirm.sent", {
        pullbackId: pullback.pullbackId.toString(),
        transaction,
      });
    }
    assertLeaseHeld();
    const txHash = await dependencies.chain.confirmPullback({
      pullbackId: pullback.pullbackId,
      transaction: transaction as `0x${string}`,
    });
    await writePullbackPhase(dependencies, input, attempt, "pullback.confirmed", {
      pullbackId: pullback.pullbackId.toString(),
      txHash,
    });
  } else if (confirmed?.state === "Confirmed" && !savedConfirm) {
    await writePullbackPhase(dependencies, input, attempt, "pullback.confirmed", {
      pullbackId: pullback.pullbackId.toString(),
      recovered: true,
    });
  }
  await dependencies.pool.query(
    "DELETE FROM payer_pullback_gateway_failures WHERE plan_id=$1 AND step_index=$2",
    [input.planId, input.stepIndex],
  );
  return {
    state: "confirmed",
    pullbackId: pullback.pullbackId.toString(),
    value: pullback.value.toString(),
  };
}

function hasFreshGatewayBalance(input: PullbackInput, dependencies: PullbackDependencies): boolean {
  const ageSeconds = gatewayBalanceAgeSeconds(input, dependencies.now());
  return (
    ageSeconds >= 0 &&
    ageSeconds <= Number(dependencies.config.get("indexer.gatewayBalanceMaxAgeSeconds")) &&
    input.apiConsecutiveFailures === 0
  );
}

async function recordGatewayBalanceOutage(
  input: PullbackInput,
  dependencies: PullbackDependencies,
  attempt: number,
): Promise<void> {
  await dependencies.pool.query(
    `INSERT INTO payer_pullback_gateway_failures
       (plan_id,step_index,envelope_ref,pocket,value,unavailable_since,state,
        pullback_id,vault_address,gateway_minter,attempt,closed_pocket)
     VALUES ($1,$2,$3,$4,NULL,$5,'pending',NULL,$6,$7,$8,$9)
     ON CONFLICT (plan_id,step_index) DO UPDATE SET
       value=NULL,unavailable_since=EXCLUDED.unavailable_since,state='pending',
       pullback_id=NULL,vault_address=EXCLUDED.vault_address,
       gateway_minter=EXCLUDED.gateway_minter,attempt=EXCLUDED.attempt,
       closed_pocket=EXCLUDED.closed_pocket
     WHERE payer_pullback_gateway_failures.state='returned-to-vault'`,
    [
      input.planId,
      input.stepIndex,
      input.envelopeRef,
      input.pocket,
      dependencies.now(),
      input.vault,
      input.gatewayMinter,
      attempt,
      input.closedPocket ?? false,
    ],
  );
}

async function clearGatewayBalanceOutage(
  input: PullbackInput,
  dependencies: PullbackDependencies,
  attempt: number,
): Promise<void> {
  await dependencies.pool.query(
    `DELETE FROM payer_pullback_gateway_failures
     WHERE plan_id=$1 AND step_index=$2 AND pullback_id IS NULL AND state='pending'
       AND NOT EXISTS (
         SELECT 1 FROM step_executions
         WHERE plan_id=$1 AND step_index=$2 AND attempt=$3
           AND phase IN (
             'pullback.slow.initiate.sent','pullback.slow.initiated',
             'pullback.slow.withdraw.sent','pullback.slow.withdrawn',
             'pullback.slow.return.sent','pullback.slow.returned'
           )
       )`,
    [input.planId, input.stepIndex, attempt],
  );
}

function gatewayBalanceAgeSeconds(input: PullbackInput, now: Date): number {
  const observedAt = input.availableBalanceObservedAt;
  if (!(observedAt instanceof Date) || Number.isNaN(observedAt.getTime()))
    return Number.POSITIVE_INFINITY;
  return Math.floor((now.getTime() - observedAt.getTime()) / 1000);
}

async function recoverOrRequestPullback(
  input: PullbackInput,
  dependencies: PullbackDependencies,
  attempt: number,
  trace: readonly ExecutionPhaseRow[],
  assertLeaseHeld: () => void,
): Promise<
  | PullbackRecord
  | { readonly state: "written-off"; readonly pocket: Address }
  | { readonly state: "waiting"; readonly reason: "closed-pocket-dust" }
  | { readonly state: "waiting"; readonly reason: "manual-return-hold" }
> {
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
      serializePullback(pending, input.pocket),
    );
    return pending;
  }
  const maxFee = BigInt(Number(dependencies.config.get("payer.pullbackMaxFeeAtomic")));
  const safety = BigInt(Number(dependencies.config.get("payer.pullbackSafetyAtomic")));
  const value = input.closedPocket
    ? calculateClosedPocketPullbackValue(input.availableBalance, maxFee, safety)
    : calculatePullbackValue({
        outstanding: input.outstanding,
        pending: input.pending,
        availableBalance: input.availableBalance,
        maxFee,
        safety,
      });
  if (value <= 0n) {
    if (input.closedPocket) {
      await writePullbackPhase(dependencies, input, attempt, "pullback.closed-dust-waiting", {
        pocket: input.pocket,
      });
      return { state: "waiting", reason: "closed-pocket-dust" };
    }
    if (await isManualReturnWriteOffHeld(input, dependencies)) {
      await writePullbackPhase(dependencies, input, attempt, "pullback.manual-return-hold", {
        pocket: input.pocket,
      });
      return { state: "waiting", reason: "manual-return-hold" };
    }
    const prior = trace.findLast((row) => row.phase === "pullback.write-off.sent");
    let transaction = prior?.payload["transaction"];
    if (typeof transaction !== "string") {
      transaction = await signVaultCall(dependencies, input.vault, "writeOffPocket", {
        pocket: input.pocket,
      });
      await writePullbackPhase(dependencies, input, attempt, "pullback.write-off.sent", {
        pocket: input.pocket,
        transaction,
      });
    }
    assertLeaseHeld();
    const txHash = await dependencies.chain.writeOffPocket(
      input.pocket,
      transaction as `0x${string}`,
    );
    await writePullbackPhase(dependencies, input, attempt, "pullback.write-off", {
      pocket: input.pocket,
      txHash,
    });
    await dependencies.pool.query(
      `UPDATE payer_pullback_gateway_failures SET state='expired'
       WHERE plan_id=$1 AND step_index=$2 AND state='manual-return-required'`,
      [input.planId, input.stepIndex],
    );
    return { state: "written-off", pocket: input.pocket };
  }
  const windowBlocks = BigInt(Number(dependencies.config.get("payer.pullbackWindowBlocks")));
  const maxBlockHeight = pullbackMaxBlockHeight(input.head, windowBlocks);
  const lastCancellationIndex = trace.findLastIndex((row) => row.phase === "pullback.cancelled");
  const savedRequest = trace.findLast(
    (row, index) => row.phase === "pullback.request.sent" && index > lastCancellationIndex,
  );
  let transaction = savedRequest?.payload["transaction"];
  if (typeof transaction !== "string") {
    transaction = await signVaultCall(dependencies, input.vault, "requestPullback", {
      pocket: input.pocket,
      value: value.toString(),
      maxFee: maxFee.toString(),
      maxBlockHeight: maxBlockHeight.toString(),
    });
    await writePullbackPhase(dependencies, input, attempt, "pullback.request.sent", {
      pocket: input.pocket,
      value: value.toString(),
      maxFee: maxFee.toString(),
      maxBlockHeight: maxBlockHeight.toString(),
      transaction,
    });
  }
  assertLeaseHeld();
  const requested = await dependencies.chain.requestPullback({
    pocket: input.pocket,
    value,
    maxFee,
    maxBlockHeight,
    transaction: transaction as `0x${string}`,
  });
  await writePullbackPhase(
    dependencies,
    input,
    attempt,
    "pullback.requested",
    serializePullback(requested, input.pocket),
  );
  return requested;
}

/** Returns whether a manual return is still inside its owner response window. */
export async function isManualReturnWriteOffHeld(
  input: Pick<PullbackInput, "planId" | "stepIndex">,
  dependencies: Pick<PullbackDependencies, "pool" | "config" | "now">,
): Promise<boolean> {
  return (await manualReturnWriteOffStatus(input, dependencies)) === "held";
}

export interface ManualReturnWriteOffInput {
  readonly planId: string;
  readonly stepIndex: number;
  readonly attempt: number;
  readonly envelopeRef: string;
  readonly vault: Address;
  readonly pocket: Address;
}

export interface ManualReturnWriteOffDependencies {
  readonly pool: Pool;
  readonly config: Config;
  readonly signer: Pick<Signer, "sign">;
  readonly chain: Pick<PullbackChain, "pocketWriteOffStatus" | "writeOffPocket">;
  readonly now: () => Date;
}

/** Writes off an overdue manual return without requiring a Gateway API observation. */
export async function writeOffOverdueManualReturn(
  input: ManualReturnWriteOffInput,
  dependencies: ManualReturnWriteOffDependencies,
): Promise<"written-off" | "already-closed" | "held" | "recorded" | "pending-pullback"> {
  const workerId = `manual-return-${process.pid}-${randomUUID()}`;
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
    const status = await manualReturnWriteOffStatus(input, dependencies);
    if (status === "held") return "held";
    if (status === "recorded") return "recorded";
    if (status !== "due") return "already-closed";
    const readStatus = dependencies.chain.pocketWriteOffStatus;
    if (!readStatus)
      throw new Error("Manual-return write-off requires an on-chain pocket state read.");
    const pocketStatus = await readStatus(input.pocket);
    if (pocketStatus.state === "closed") {
      await expireManualReturn(input, dependencies.pool);
      return "already-closed";
    }
    if (pocketStatus.state === "unsupported")
      throw new Error("Manual-return write-off found an unsupported pocket state.");
    if (pocketStatus.pendingPullback > 0n) return "pending-pullback";
    const trace = await getExecutionTrace(
      dependencies.pool,
      input.planId,
      input.stepIndex,
      input.attempt,
    );
    if (trace.some((entry) => entry.phase === "pullback.write-off")) {
      await expireManualReturn(input, dependencies.pool);
      return "written-off";
    }
    const transaction = await writeOffTransaction(input, dependencies, trace);
    const txHash = await dependencies.chain.writeOffPocket(input.pocket, transaction);
    await appendExecutionPhase(dependencies.pool, {
      planId: input.planId,
      stepIndex: input.stepIndex,
      attempt: input.attempt,
      phase: "pullback.write-off",
      payload: { pocket: input.pocket, txHash },
    });
    await expireManualReturn(input, dependencies.pool);
    return "written-off";
  } finally {
    await renewal.stop();
    await releaseExecutorLease(dependencies.pool, input.envelopeRef, workerId);
  }
}

async function writeOffTransaction(
  input: ManualReturnWriteOffInput,
  dependencies: ManualReturnWriteOffDependencies,
  trace: readonly ExecutionPhaseRow[],
): Promise<`0x${string}`> {
  const sent = trace.findLast((entry) => entry.phase === "pullback.write-off.sent");
  const prior = sent?.payload["transaction"];
  if (typeof prior === "string") return prior as `0x${string}`;
  const signed = await dependencies.signer.sign("cz-15", {
    keyId: "K3",
    kind: "vault-call",
    payload: { vault: input.vault, selector: "writeOffPocket", args: { pocket: input.pocket } },
  });
  if (!("signedTransaction" in signed)) throw new Error("K3 did not sign writeOffPocket.");
  await appendExecutionPhase(dependencies.pool, {
    planId: input.planId,
    stepIndex: input.stepIndex,
    attempt: input.attempt,
    phase: "pullback.write-off.sent",
    payload: { pocket: input.pocket, transaction: signed.signedTransaction },
  });
  return signed.signedTransaction;
}

async function manualReturnWriteOffStatus(
  input: Pick<PullbackInput, "planId" | "stepIndex">,
  dependencies: Pick<PullbackDependencies, "pool" | "config" | "now">,
): Promise<"none" | "held" | "due" | "recorded" | "expired"> {
  const requiredAt = await dependencies.pool.query<{
    readonly state: string;
    readonly at: Date | null;
  }>(
    `SELECT state,manual_return_required_at AS at
     FROM payer_pullback_gateway_failures
     WHERE plan_id=$1 AND step_index=$2
       AND state IN ('manual-return-required','recorded','expired')`,
    [input.planId, input.stepIndex],
  );
  const row = requiredAt.rows[0];
  if (!row) return "none";
  if (row.state === "recorded") return "recorded";
  if (row.state === "expired") return "expired";
  const start = row.at;
  if (!start) {
    await dependencies.pool.query(
      `UPDATE payer_pullback_gateway_failures SET manual_return_required_at=$3
       WHERE plan_id=$1 AND step_index=$2 AND state='manual-return-required'
         AND manual_return_required_at IS NULL`,
      [input.planId, input.stepIndex, dependencies.now()],
    );
    return "held";
  }
  const holdMs =
    Number(dependencies.config.get("payer.manualReturnHoldHours")) * MILLISECONDS_PER_HOUR;
  return dependencies.now().getTime() < start.getTime() + holdMs ? "held" : "due";
}

async function expireManualReturn(input: ManualReturnWriteOffInput, pool: Pool): Promise<void> {
  const result = await pool.query(
    `UPDATE payer_pullback_gateway_failures SET state='expired'
     WHERE plan_id=$1 AND step_index=$2 AND state='manual-return-required'`,
    [input.planId, input.stepIndex],
  );
  if (result.rowCount !== 1)
    throw new Error("Manual-return state changed before the write-off was recorded.");
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
  const saved = trace.findLast(
    (row) =>
      row.phase === "pullback.transfer.result" &&
      row.payload["pullbackId"] === pullback.pullbackId.toString(),
  );
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
  let response;
  try {
    response = await dependencies.safeFetch(dependencies.gatewayTransferUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      timeoutMs: Number(dependencies.config.get("fetch.timeoutMs")),
      body: new TextEncoder().encode(
        JSON.stringify([
          {
            burnIntent: {
              maxBlockHeight: intent.intent.maxBlockHeight.toString(),
              maxFee: intent.intent.maxFee.toString(),
              spec: { ...intent.intent.spec, value: intent.intent.spec.value.toString() },
            },
            signature: signed.signature,
            contractSigner: true,
          },
        ]),
      ),
    });
  } catch (error) {
    await recordGatewayPullbackFailure(input, pullback, dependencies, attempt);
    throw error;
  }
  if (response.status < 200 || response.status >= 300) {
    if (response.status >= 500)
      await recordGatewayPullbackFailure(input, pullback, dependencies, attempt);
    throw new Error(`Gateway transfer API failed with HTTP ${response.status}.`);
  }
  const result = parseTransferAttestation(response.body);
  await writePullbackPhase(dependencies, input, attempt, "pullback.transfer.result", {
    pullbackId: pullback.pullbackId.toString(),
    transferId: result.transferId,
    attestation: result.attestation,
    signature: result.signature,
  });
  return result;
}

async function recordGatewayPullbackFailure(
  input: PullbackInput,
  pullback: PullbackRecord,
  dependencies: PullbackDependencies,
  attempt: number,
): Promise<void> {
  await dependencies.pool.query(
    `INSERT INTO payer_pullback_gateway_failures
       (plan_id,step_index,envelope_ref,pocket,value,unavailable_since,state,
        pullback_id,vault_address,gateway_minter,attempt,closed_pocket)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,$10,$11)
     ON CONFLICT (plan_id,step_index) DO UPDATE SET
       state=CASE WHEN payer_pullback_gateway_failures.state='returned-to-vault'
         THEN 'pending' ELSE payer_pullback_gateway_failures.state END,
       unavailable_since=CASE WHEN payer_pullback_gateway_failures.state='returned-to-vault'
         THEN EXCLUDED.unavailable_since
         ELSE payer_pullback_gateway_failures.unavailable_since END,
       value=EXCLUDED.value,pullback_id=EXCLUDED.pullback_id,
       vault_address=EXCLUDED.vault_address,gateway_minter=EXCLUDED.gateway_minter,
       attempt=EXCLUDED.attempt,closed_pocket=EXCLUDED.closed_pocket`,
    [
      input.planId,
      input.stepIndex,
      input.envelopeRef,
      input.pocket,
      pullback.value.toString(),
      dependencies.now(),
      pullback.pullbackId.toString(),
      input.vault,
      input.gatewayMinter,
      attempt,
      input.closedPocket ?? false,
    ],
  );
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
  const prior = trace.findLast(
    (row) =>
      row.phase === "pullback.mint.sent" &&
      row.payload["pullbackId"] === pullback.pullbackId.toString(),
  );
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
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(value["attestation"]) ||
    typeof value["signature"] !== "string" ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(value["signature"])
  )
    throw new Error("Gateway transfer response is missing attestation fields.");
  return {
    transferId: value["transferId"],
    attestation: value["attestation"] as `0x${string}`,
    signature: value["signature"] as `0x${string}`,
  };
}

function serializePullback(
  pullback: PullbackRecord,
  pocket: Address,
): Readonly<Record<string, unknown>> {
  return {
    pocket,
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
  args: Readonly<Record<string, unknown>>,
): Promise<`0x${string}`> {
  const result = await dependencies.signer.sign("cz-15", {
    keyId: "K3",
    kind: "vault-call",
    payload: { vault, selector, args },
  });
  if (!("signedTransaction" in result)) throw new Error(`K3 did not sign ${selector}.`);
  return result.signedTransaction;
}
