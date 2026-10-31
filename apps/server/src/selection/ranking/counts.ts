import { randomUUID } from "node:crypto";
import { H, jcsString, ratingLineageRoot } from "@czar/hashing";
import type { Config } from "@czar/config";
import type { Pool, PoolClient } from "pg";
import { acquireExecutorLease, releaseExecutorLease } from "#src/payer/executions";
import { registerRankingRefreshHandler } from "#src/evidence/ratings";
import { wilsonLower } from "#src/selection/ranking/lower-bound";

interface RatingRow {
  readonly rating_id: string;
  readonly user_id: string;
  readonly service_id: string;
  readonly version_id: string;
  readonly task_class: string;
  readonly value: "good" | "bad";
}

interface AttributedRatingRow extends RatingRow {
  readonly dedup_key: string;
  readonly step_payee: string | null;
}

const PAYMENT_KEY =
  /^(?:x402-exact|gateway-batched):eip155:(?:0|[1-9]\d*):0x[0-9a-f]{40}:(0x[0-9a-f]{40}):0x[0-9a-f]{64}$/;

function matchesSelectedPayee(row: AttributedRatingRow): boolean {
  const payTo = PAYMENT_KEY.exec(row.dedup_key)?.[1];
  return payTo !== undefined && payTo === row.step_payee?.toLowerCase();
}

export interface RefreshInput {
  readonly pool: Pool;
  readonly network: string;
  readonly policyVersion: string;
  readonly confidenceZ: number;
  readonly workerId: string;
  readonly leaseSeconds: number;
  readonly now: Date;
}

export interface SupplierCountRow {
  readonly network: string;
  readonly service_id: string;
  readonly version_id: string;
  readonly task_class: string;
  readonly good: number;
  readonly bad: number;
  readonly owners_rated: number;
  readonly owners_bad: number;
  readonly lower_bound: number | null;
  readonly lineage_root: string | null;
  readonly policy_version: string;
  readonly computed_at: Date;
}

/** Persists and returns exact JCS bytes of the count rows used by a ranking decision. */
export async function readSupplierCountSnapshot(input: {
  readonly pool: Pool;
  readonly network: string;
  readonly policyVersion: string;
  readonly now: Date;
  readonly retentionDays: number;
}): Promise<{ readonly snapshotId: string; readonly counts: readonly SupplierCountRow[] }> {
  const result = await input.pool.query<SupplierCountRow>(
    `SELECT network,service_id,version_id,task_class,good,bad,owners_rated,owners_bad,
       lower_bound,lineage_root,policy_version,computed_at
     FROM supplier_counts WHERE network=$1 ORDER BY service_id,version_id,task_class`,
    [input.network],
  );
  if (result.rows.some((row) => row.policy_version !== input.policyVersion))
    throw new Error("Supplier count policy differs from the active ranking policy.");
  const normalized = result.rows.map((row) => ({
    ...row,
    computed_at: row.computed_at.toISOString(),
  }));
  const bodyJcs = jcsString(normalized);
  const snapshotId = H(normalized);
  const saved = await input.pool.query<{ body_jcs: string }>(
    `INSERT INTO selection_interim_snapshots(snapshot_id,body_jcs,created_at,last_used_at)
     VALUES($1,$2,$3,$3)
     ON CONFLICT(snapshot_id) DO UPDATE SET
       last_used_at=GREATEST(selection_interim_snapshots.last_used_at,EXCLUDED.last_used_at)
     RETURNING body_jcs`,
    [snapshotId, bodyJcs, input.now],
  );
  if (saved.rows[0]?.body_jcs !== bodyJcs)
    throw new Error("Stored supplier count snapshot failed exact-byte verification.");
  await input.pool.query(
    `DELETE FROM selection_interim_snapshots
     WHERE last_used_at < $1::timestamptz - ($2::text || ' days')::interval`,
    [input.now, input.retentionDays],
  );
  return { snapshotId, counts: result.rows };
}

/** Rebuilds effective owner counts under the shared executor leader lease. */
export async function refreshSupplierCounts(input: RefreshInput): Promise<boolean> {
  const leaseKey = `ranking:supplier-counts:${input.network}`;
  const acquired = await acquireExecutorLease(
    input.pool,
    leaseKey,
    input.workerId,
    input.leaseSeconds,
    () => input.now,
  );
  if (!acquired) return false;
  try {
    const client = await input.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await writeCounts(client, input);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return true;
  } finally {
    await releaseExecutorLease(input.pool, leaseKey, input.workerId);
  }
}

async function writeCounts(client: PoolClient, input: RefreshInput): Promise<void> {
  const result = await client.query<AttributedRatingRow>(
    `SELECT r.rating_id,r.user_id,r.service_id,r.version_id,r.task_class,r.value,
       o.dedup_key,s.step->>'payee' AS step_payee
     FROM ratings_effective r
     JOIN rating_receipts rr ON rr.rating_id=r.rating_id
     JOIN observations o ON o.obs_id=rr.obs_id
     JOIN objectives obj ON obj.objective_id=r.objective_id
     JOIN steps s ON s.plan_id=obj.plan_id AND s.step_index=r.step_index
     WHERE r.network=$1 AND o.settled_at IS NOT NULL
       AND o.user_id=r.user_id AND o.objective_id=r.objective_id
       AND o.step_index=r.step_index AND o.network=r.network
       AND o.service_id=r.service_id AND o.version_id=r.version_id
       AND o.task_class=r.task_class AND s.step->>'serviceId'=r.service_id
     ORDER BY r.service_id,r.version_id,r.task_class,r.rating_id`,
    [input.network],
  );
  const included = new Set<string>();
  const groups = new Map<string, RatingRow[]>();
  for (const row of result.rows) {
    if (!matchesSelectedPayee(row) || included.has(row.rating_id)) continue;
    included.add(row.rating_id);
    const key = JSON.stringify([row.service_id, row.version_id, row.task_class]);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  await client.query("DELETE FROM supplier_counts WHERE network=$1", [input.network]);
  for (const rows of groups.values()) {
    const first = rows[0];
    if (!first) continue;
    const good = rows.filter((row) => row.value === "good").length;
    const bad = rows.length - good;
    const ownersRated = new Set(rows.map((row) => row.user_id)).size;
    const ownersBad = new Set(rows.filter((row) => row.value === "bad").map((row) => row.user_id))
      .size;
    await client.query(
      `INSERT INTO supplier_counts(network,service_id,version_id,task_class,good,bad,
         owners_rated,owners_bad,lower_bound,lineage_root,policy_version,computed_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT(network,service_id,version_id,task_class) DO UPDATE SET
         good=EXCLUDED.good,bad=EXCLUDED.bad,owners_rated=EXCLUDED.owners_rated,
         owners_bad=EXCLUDED.owners_bad,lower_bound=EXCLUDED.lower_bound,
         lineage_root=EXCLUDED.lineage_root,policy_version=EXCLUDED.policy_version,
         computed_at=EXCLUDED.computed_at`,
      [
        input.network,
        first.service_id,
        first.version_id,
        first.task_class,
        good,
        bad,
        ownersRated,
        ownersBad,
        wilsonLower(good, rows.length, input.confidenceZ),
        ratingLineageRoot(rows.map((row) => row.rating_id)),
        input.policyVersion,
        input.now,
      ],
    );
  }
}

/** Starts periodic and rating-triggered snapshot refresh without touching the rating transaction. */
export function startSupplierCountsRefresh(input: {
  readonly pool: Pool;
  readonly config: Config;
  readonly network: string;
  readonly policyVersion: string;
  readonly now?: () => Date;
  readonly onError: (error: unknown) => void;
}): { stop(): Promise<void>; ready: Promise<void> } {
  const intervalSeconds = Number(input.config.get("selection.snapshotRefreshSeconds"));
  const debounceSeconds = Number(input.config.get("selection.ratingRefreshDebounceSeconds"));
  const confidenceZ = Number(input.config.get("selection.confidenceZ"));
  const now = input.now ?? (() => new Date());
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  let stopped = false;
  let pending = false;
  const run = () => {
    if (stopped) return;
    if (active) {
      pending = true;
      return;
    }
    active = refreshSupplierCounts({
      pool: input.pool,
      network: input.network,
      policyVersion: input.policyVersion,
      confidenceZ,
      workerId: randomUUID(),
      leaseSeconds: intervalSeconds,
      now: now(),
    })
      .then((refreshed) => {
        if (!refreshed && !stopped) {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(run, debounceSeconds * 1000);
        }
      })
      .catch(input.onError)
      .finally(() => {
        active = undefined;
        if (pending && !stopped) {
          pending = false;
          run();
        }
      });
  };
  const interval = setInterval(run, intervalSeconds * 1000);
  const ready = refreshSupplierCounts({
    pool: input.pool,
    network: input.network,
    policyVersion: input.policyVersion,
    confidenceZ,
    workerId: randomUUID(),
    leaseSeconds: intervalSeconds,
    now: now(),
  }).then(() => undefined);
  const unregister = registerRankingRefreshHandler(() => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(run, debounceSeconds * 1000);
  });
  return {
    ready,
    async stop() {
      stopped = true;
      clearInterval(interval);
      if (debounce) clearTimeout(debounce);
      unregister();
      await active;
    },
  };
}
