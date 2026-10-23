import type { Config } from "@czar/config";
import type { Signer } from "@czar/signer";
import type { Address } from "viem";
import type { Pool } from "pg";
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
  readonly value: string;
  readonly unavailable_since: Date;
  readonly pullback_id: string | null;
  readonly vault_address: Address | null;
  readonly gateway_minter: Address | null;
  readonly attempt: number | null;
}

export interface PullbackFallbackSchedulerDependencies {
  readonly pool: Pool;
  readonly config: Config;
  readonly signer: Pick<Signer, "sign">;
  readonly chain: SlowPullbackDependencies["chain"];
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
    `SELECT plan_id,step_index,envelope_ref,pocket,value,unavailable_since,
            pullback_id,vault_address,gateway_minter,attempt
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
  const pullback = pendingPullbackInput(row);
  await dependencies.cancelPendingPullback(pullback);
  const result = await executeSlowPullbackFallback(
    {
      planId: row.plan_id,
      stepIndex: row.step_index,
      envelopeRef: row.envelope_ref,
      pocket: row.pocket,
      apiUnavailableSince: row.unavailable_since,
      value: BigInt(row.value),
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
}

function pendingPullbackInput(row: PendingFallback): CancelPullbackInput {
  if (!row.pullback_id || !row.vault_address || !row.gateway_minter || row.attempt === null)
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
