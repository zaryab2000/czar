import type { Config } from "@czar/config";
import type { Signer } from "@czar/signer";
import type { Address } from "viem";
import type { Pool } from "pg";
import type { ManualReturnProjection, PocketBalanceSnapshot } from "#src/payer/indexer-pocket";
import { appendExecutionPhase, getExecutionTrace } from "#src/payer/executions";
import {
  executeSlowPullbackFallback,
  type CancelPullbackInput,
  type SlowPullbackDependencies,
} from "#src/payer/pullback";

const MILLISECONDS_PER_HOUR = 3_600_000;

interface PendingFallback {
  readonly plan_id: string;
  readonly step_index: number;
  readonly envelope_ref: string;
  readonly pocket: Address;
  readonly unavailable_since: Date;
  readonly value: string | null;
  readonly pullback_id: string | null;
  readonly vault_address: Address | null;
  readonly gateway_minter: Address | null;
  readonly attempt: number | null;
  readonly closed_pocket: boolean;
}

export interface PullbackFallbackSchedulerDependencies {
  readonly pool: Pool;
  readonly config: Config;
  readonly signer: Pick<Signer, "sign">;
  readonly chain: SlowPullbackDependencies["chain"];
  readonly readGatewayBalance: (pocket: Address) => Promise<PocketBalanceSnapshot>;
  readonly cancelPendingPullback: (input: CancelPullbackInput) => Promise<unknown>;
  readonly now: () => Date;
}

interface ManualReturnRow {
  readonly plan_id: string;
  readonly step_index: number;
  readonly pocket: Address;
  readonly vault_address: Address | null;
  readonly return_block: string | null;
  readonly return_log_index: number | null;
}

export interface ManualReturnWriteOffCandidate {
  readonly plan_id: string;
  readonly step_index: number;
  readonly envelope_ref: string;
  readonly pocket: Address;
  readonly vault_address: Address | null;
  readonly gateway_minter: Address | null;
  readonly attempt: number | null;
}

export interface ManualReturnSummary {
  readonly envelopeRef: string;
  readonly vault: Address;
  readonly pocket: Address;
  readonly returnedAmount: string;
  readonly returnTx: string;
  readonly state: "manual-return-required" | "recorded" | "expired";
  readonly recordedCredit?: string;
  readonly recordedTx?: string;
}

export interface ManualReturnReconciliationDependencies {
  readonly pool: Pool;
  readonly manualReturnsForVault: (vault: Address) => Promise<readonly ManualReturnProjection[]>;
  readonly isPocketClosed: (vault: Address, pocket: Address) => Promise<boolean>;
  readonly now: () => Date;
}

export interface ManualReturnRecoveryDependencies extends ManualReturnReconciliationDependencies {
  readonly config: Config;
  readonly writeOffManualReturn: (row: ManualReturnWriteOffCandidate) => Promise<unknown>;
}

export async function runPendingPullbackFallbacks(
  dependencies: PullbackFallbackSchedulerDependencies,
): Promise<number> {
  const cutoff = new Date(
    dependencies.now().getTime() -
      Number(dependencies.config.get("payer.pullbackApiDownHours")) * MILLISECONDS_PER_HOUR,
  );
  const rows = await dependencies.pool.query<PendingFallback>(
    `SELECT plan_id,step_index,envelope_ref,pocket,unavailable_since,value,
            pullback_id,vault_address,gateway_minter,attempt,closed_pocket
     FROM payer_pullback_gateway_failures
     WHERE state='pending' AND (closed_pocket OR unavailable_since <= $1)
     ORDER BY unavailable_since,plan_id,step_index`,
    [cutoff],
  );
  for (const row of rows.rows) await processFallback(row, dependencies);
  return rows.rows.length;
}

/** Reconciles pending manual returns against indexed vault events and pocket state. */
export async function reconcileManualReturns(
  dependencies: ManualReturnReconciliationDependencies,
): Promise<number> {
  const result = await dependencies.pool.query<ManualReturnRow>(
    `SELECT plan_id,step_index,pocket,vault_address,return_block,return_log_index
     FROM payer_pullback_gateway_failures
     WHERE state='manual-return-required' AND closed_pocket=false
     ORDER BY plan_id,step_index`,
  );
  const eventsByVault = new Map<string, readonly ManualReturnProjection[]>();
  let changed = 0;
  for (const row of result.rows) {
    if (row.vault_address === null)
      throw new Error(`Manual-return row lacks its vault address: ${row.plan_id}.`);
    if (row.return_block === null || row.return_log_index === null)
      throw new Error(`Manual-return row lacks its mined return position: ${row.plan_id}.`);
    const key = row.vault_address.toLowerCase();
    let events = eventsByVault.get(key);
    if (!events) {
      events = await dependencies.manualReturnsForVault(row.vault_address);
      eventsByVault.set(key, events);
    }
    const matching = events.find((event) => isAfterReturn(event, row));
    if (matching) {
      changed += await markManualReturnRecorded(row, matching, dependencies);
    } else if (await dependencies.isPocketClosed(row.vault_address, row.pocket)) {
      changed += await markManualReturnExpired(row, dependencies);
    }
  }
  return changed;
}

/** Reconciles manual returns and retries write-off after the configured owner hold. */
export async function runManualReturnRecovery(
  dependencies: ManualReturnRecoveryDependencies,
): Promise<number> {
  const updated = await reconcileManualReturns(dependencies);
  const cutoff = new Date(
    dependencies.now().getTime() -
      Number(dependencies.config.get("payer.manualReturnHoldHours")) * MILLISECONDS_PER_HOUR,
  );
  const overdue = await dependencies.pool.query<ManualReturnWriteOffCandidate>(
    `SELECT plan_id,step_index,envelope_ref,pocket,vault_address,gateway_minter,attempt
     FROM payer_pullback_gateway_failures
     WHERE state='manual-return-required' AND manual_return_required_at <= $1
     ORDER BY manual_return_required_at,plan_id,step_index`,
    [cutoff],
  );
  for (const row of overdue.rows) await dependencies.writeOffManualReturn(row);
  return updated + overdue.rows.length;
}

/** Lists manual returns belonging to objectives owned by the supplied user. */
export async function listManualReturnsForUser(
  pool: Pool,
  userId: string,
): Promise<readonly ManualReturnSummary[]> {
  const result = await pool.query<{
    readonly envelopeRef: string;
    readonly vault: Address | null;
    readonly pocket: Address;
    readonly returnedAmount: string;
    readonly returnTx: string;
    readonly state: ManualReturnSummary["state"];
    readonly recordedCredit: string | null;
    readonly recordedTx: string | null;
  }>(
    `SELECT f.envelope_ref AS "envelopeRef",f.vault_address AS vault,f.pocket,
            f.returned_amount AS "returnedAmount",f.return_tx AS "returnTx",f.state,
            f.recorded_credit AS "recordedCredit",f.recorded_tx AS "recordedTx"
     FROM payer_pullback_gateway_failures f
     JOIN plans p ON p.plan_id=f.plan_id
     JOIN objectives o ON o.objective_id=p.objective_id
     WHERE o.user_id=$1 AND f.state IN ('manual-return-required','recorded','expired')
     ORDER BY f.manual_return_required_at,f.plan_id,f.step_index`,
    [userId],
  );
  return result.rows.map(manualReturnSummary);
}

function manualReturnSummary(row: {
  readonly envelopeRef: string;
  readonly vault: Address | null;
  readonly pocket: Address;
  readonly returnedAmount: string;
  readonly returnTx: string;
  readonly state: ManualReturnSummary["state"];
  readonly recordedCredit: string | null;
  readonly recordedTx: string | null;
}): ManualReturnSummary {
  if (row.vault === null) throw new Error("Manual-return row is missing its owning vault address.");
  if (row.state === "recorded") {
    if (row.recordedCredit === null || row.recordedTx === null)
      throw new Error("Recorded manual return is missing its credited event fields.");
    return {
      envelopeRef: row.envelopeRef,
      vault: row.vault,
      pocket: row.pocket,
      returnedAmount: row.returnedAmount,
      returnTx: row.returnTx,
      state: row.state,
      recordedCredit: row.recordedCredit,
      recordedTx: row.recordedTx,
    };
  }
  return {
    envelopeRef: row.envelopeRef,
    vault: row.vault,
    pocket: row.pocket,
    returnedAmount: row.returnedAmount,
    returnTx: row.returnTx,
    state: row.state,
  };
}

async function markManualReturnRecorded(
  row: ManualReturnRow,
  event: ManualReturnProjection,
  dependencies: ManualReturnReconciliationDependencies,
): Promise<number> {
  const result = await dependencies.pool.query(
    `UPDATE payer_pullback_gateway_failures
     SET state='recorded',recorded_credit=$3,recorded_tx=$4,recorded_at=$5
     WHERE plan_id=$1 AND step_index=$2 AND state='manual-return-required'
       AND return_block=$6 AND return_log_index=$7`,
    [
      row.plan_id,
      row.step_index,
      event.credit,
      event.txHash,
      dependencies.now(),
      row.return_block,
      row.return_log_index,
    ],
  );
  return result.rowCount ?? 0;
}

async function markManualReturnExpired(
  row: ManualReturnRow,
  dependencies: ManualReturnReconciliationDependencies,
): Promise<number> {
  const result = await dependencies.pool.query(
    `UPDATE payer_pullback_gateway_failures SET state='expired'
     WHERE plan_id=$1 AND step_index=$2 AND state='manual-return-required'`,
    [row.plan_id, row.step_index],
  );
  return result.rowCount ?? 0;
}

function isAfterReturn(event: ManualReturnProjection, row: ManualReturnRow): boolean {
  if (row.return_block === null || row.return_log_index === null) return false;
  if (event.pocket.toLowerCase() !== row.pocket.toLowerCase()) return false;
  const eventBlock = BigInt(event.block);
  const returnBlock = BigInt(row.return_block);
  return (
    eventBlock > returnBlock ||
    (eventBlock === returnBlock && event.logIndex > row.return_log_index)
  );
}

async function processFallback(
  row: PendingFallback,
  dependencies: PullbackFallbackSchedulerDependencies,
): Promise<void> {
  const attempt = row.attempt ?? 0;
  const trace = await getExecutionTrace(dependencies.pool, row.plan_id, row.step_index, attempt);
  const slowPathStarted =
    row.closed_pocket || hasSlowWithdrawalProgress(trace.map((entry) => entry.phase));
  const balance = slowPathStarted ? null : await readFallbackBalance(row, dependencies);
  if (!slowPathStarted && balance === null) return;
  if (!slowPathStarted) {
    const pullback = pendingPullbackInput(row);
    if (pullback) await dependencies.cancelPendingPullback(pullback);
  }
  const result = await executeSlowPullbackFallback(
    {
      planId: row.plan_id,
      stepIndex: row.step_index,
      envelopeRef: row.envelope_ref,
      pocket: row.pocket,
      vault: requiredAddress(row.vault_address, "vault"),
      usdc: dependencies.config.get("chain.usdcAddress") as Address,
      apiUnavailableSince: row.unavailable_since,
      value: balance?.gatewayAvailableAtomic ?? BigInt(row.value ?? "0"),
      attempt,
      closedPocketRecovery: row.closed_pocket,
      trigger: row.closed_pocket ? "closed-dust" : "api-down",
    },
    dependencies,
  );
  if (result.state === "manual-return-required") {
    await dependencies.pool.query(
      `UPDATE payer_pullback_gateway_failures
       SET state='manual-return-required',
           manual_return_required_at=COALESCE(manual_return_required_at,$3)
       WHERE plan_id=$1 AND step_index=$2`,
      [row.plan_id, row.step_index, dependencies.now()],
    );
  }
  if (result.state === "returned-to-vault") {
    await dependencies.pool.query(
      `UPDATE payer_pullback_gateway_failures SET state='returned-to-vault'
       WHERE plan_id=$1 AND step_index=$2`,
      [row.plan_id, row.step_index],
    );
  }
}

function requiredAddress(value: Address | null, name: string): Address {
  if (!value) throw new Error(`Pending slow pullback has no ${name} address.`);
  return value;
}

function hasSlowWithdrawalProgress(phases: readonly string[]): boolean {
  return phases.some((phase) =>
    [
      "pullback.slow.initiate.sent",
      "pullback.slow.initiated",
      "pullback.slow.withdraw.sent",
      "pullback.slow.withdrawn",
      "pullback.slow.return.sent",
      "pullback.slow.returned",
    ].includes(phase),
  );
}

async function readFallbackBalance(
  row: PendingFallback,
  dependencies: PullbackFallbackSchedulerDependencies,
): Promise<PocketBalanceSnapshot | null> {
  try {
    const balance = await dependencies.readGatewayBalance(row.pocket);
    if (balance.apiObservedAt === null) {
      await recordFallbackWait(row, dependencies, "pullback.gateway-figure-missing");
      return null;
    }
    if (balance.gatewayAvailableAtomic <= 0n) {
      await recordFallbackWait(row, dependencies, "pullback.gateway-balance-empty");
      return null;
    }
    return balance;
  } catch {
    await recordFallbackWait(row, dependencies, "pullback.gateway-figure-missing");
    return null;
  }
}

async function recordFallbackWait(
  row: PendingFallback,
  dependencies: PullbackFallbackSchedulerDependencies,
  phase: "pullback.gateway-figure-missing" | "pullback.gateway-balance-empty",
): Promise<void> {
  await appendExecutionPhase(dependencies.pool, {
    planId: row.plan_id,
    stepIndex: row.step_index,
    attempt: row.attempt ?? 0,
    phase,
    payload: { pocket: row.pocket },
  });
}

function pendingPullbackInput(row: PendingFallback): CancelPullbackInput | null {
  if (row.pullback_id === null) return null;
  if (!row.vault_address || !row.gateway_minter || row.attempt === null)
    throw new Error("Pending Gateway fallback is missing its pullback cancellation context.");
  return {
    planId: row.plan_id,
    stepIndex: row.step_index,
    envelopeRef: row.envelope_ref,
    pullbackId: BigInt(row.pullback_id),
    vault: row.vault_address,
    gatewayMinter: row.gateway_minter,
    attempt: row.attempt,
  };
}
