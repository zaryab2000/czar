import type { RankingDecision } from "@czar/schemas";
import { validateSchema } from "@czar/schemas";
import type { Pool } from "pg";

/** Persists a ranked decision with a foreign key to its exact count snapshot. */
export async function saveRankingDecision(pool: Pool, decision: RankingDecision): Promise<void> {
  if (!validateSchema("ranking-decision", decision))
    throw new TypeError("Cannot persist an invalid RankingDecision 1.2.");
  await pool.query(
    `INSERT INTO ranking_decisions(query_id,snapshot_id,policy_version,decision,created_at)
     VALUES($1,$2,$3,$4::jsonb,$5)`,
    [
      decision.query_id,
      decision.snapshot_id,
      decision.policy_version,
      JSON.stringify(decision),
      decision.received_at,
    ],
  );
}

/** Reads one stored decision and checks the canonical schema before returning it. */
export async function readRankingDecision(
  pool: Pool,
  queryId: string,
): Promise<RankingDecision | null> {
  const result = await pool.query<{ decision: unknown }>(
    "SELECT decision FROM ranking_decisions WHERE query_id=$1",
    [queryId],
  );
  const decision = result.rows[0]?.decision;
  if (decision === undefined) return null;
  if (!validateSchema("ranking-decision", decision))
    throw new Error(`Stored ranking decision ${queryId} failed schema validation.`);
  return decision as RankingDecision;
}
