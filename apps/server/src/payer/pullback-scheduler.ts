import type { Config } from "@czar/config";
import type { Signer } from "@czar/signer";
import type { Address } from "viem";
import type { Pool } from "pg";
import type { PocketBalanceSnapshot } from "#src/payer/indexer-pocket";
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

export async function runPendingPullbackFallbacks(
  dependencies: PullbackFallbackSchedulerDependencies,
): Promise<number> {
  const cutoff = new Date(
    dependencies.now().getTime() -
      Number(dependencies.config.get("payer.pullbackApiDownHours")) * MILLISECONDS_PER_HOUR,
  );
  const rows = await dependencies.pool.query<PendingFallback>(
    `SELECT plan_id,step_index,envelope_ref,pocket,unavailable_since,
            pullback_id,vault_address,gateway_minter,attempt,closed_pocket
     FROM payer_pullback_gateway_failures
     WHERE state='pending' AND unavailable_since <= $1
     ORDER BY unavailable_since,plan_id,step_index`,
    [cutoff],
  );
  for (const row of rows.rows) await processFallback(row, dependencies);
  return rows.rows.length;
}

async function processFallback(
  row: PendingFallback,
  dependencies: PullbackFallbackSchedulerDependencies,
): Promise<void> {
  const attempt = row.attempt ?? 0;
  const trace = await getExecutionTrace(dependencies.pool, row.plan_id, row.step_index, attempt);
  const withdrawalStarted = hasSlowWithdrawalProgress(trace.map((entry) => entry.phase));
  const balance = withdrawalStarted ? null : await readFallbackBalance(row, dependencies);
  if (!withdrawalStarted && balance === null) return;
  if (!withdrawalStarted) {
    const pullback = pendingPullbackInput(row);
    if (pullback) await dependencies.cancelPendingPullback(pullback);
  }
  const result = await executeSlowPullbackFallback(
    {
      planId: row.plan_id,
      stepIndex: row.step_index,
      envelopeRef: row.envelope_ref,
      pocket: row.pocket,
      apiUnavailableSince: row.unavailable_since,
      value: balance?.gatewayAvailableAtomic ?? 0n,
      attempt,
      closedPocketRecovery: row.closed_pocket,
      trigger: "api-down",
    },
    dependencies,
  );
  if (result.state === "manual-return-required") {
    await dependencies.pool.query(
      `UPDATE payer_pullback_gateway_failures SET state='manual-return-required'
       WHERE plan_id=$1 AND step_index=$2`,
      [row.plan_id, row.step_index],
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
