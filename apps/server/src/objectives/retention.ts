import { loadConfig } from "@czar/config";
import type { Pool } from "pg";

export async function purgeExpiredGoals(pool: Pool, now: Date): Promise<number> {
  const retentionDays = Number(loadConfig().get("api.goalRetentionDays"));
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const result = await pool.query(
    `UPDATE objectives SET submission=submission - 'goal',updated_at=updated_at
     WHERE created_at <= $1 AND submission ? 'goal'`,
    [cutoff],
  );
  return result.rowCount ?? 0;
}
