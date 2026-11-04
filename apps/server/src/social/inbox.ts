import type { Pool, PoolClient } from "pg";
import type { RandomSource } from "#src/http/ids";

export interface InboxRow {
  inbox_id: string;
  representative_id: string;
  event_id: string;
  kind: string;
  refs: Record<string, unknown>;
  state: string;
  due_at: Date;
  attempts: number;
  lease_token: string;
  lease_expires_at: Date;
  created_at: Date;
}

/** Claim one due item and serialize concurrent claims for its representative. */
export async function claimNextInbox(
  pool: Pool,
  now: Date,
  leaseMs: number,
  random: RandomSource,
): Promise<InboxRow | null> {
  const token = random.bytes(32).toString("base64url");
  const result = await pool.query<InboxRow>(
    `WITH candidate AS (
       SELECT i.inbox_id FROM social_inbox i
       JOIN social_representatives r ON r.representative_id=i.representative_id
       WHERE ((i.state IN ('queued','retry') AND i.due_at<=$1)
         OR (i.state='claimed' AND i.lease_expires_at<=$1))
         AND NOT EXISTS (
           SELECT 1 FROM social_inbox active
           WHERE active.representative_id=i.representative_id
             AND active.inbox_id<>i.inbox_id AND active.state='claimed'
             AND active.lease_expires_at>$1
         )
       ORDER BY i.due_at,i.inbox_id
       FOR UPDATE OF i,r SKIP LOCKED LIMIT 1
     )
     UPDATE social_inbox i SET state='claimed',attempts=attempts+1,
       lease_token=$2,lease_expires_at=$3,updated_at=$1
     FROM candidate c WHERE i.inbox_id=c.inbox_id RETURNING i.*`,
    [now, token, new Date(now.getTime() + leaseMs)],
  );
  return result.rows[0] ?? null;
}

export interface RetryOptions {
  inboxId: string;
  leaseToken: string;
  now: Date;
  baseMs: number;
  maxMs: number;
  maxAttempts: number;
}

/** Retry with bounded exponential backoff, or fail at the configured attempt cap. */
export async function retryInbox(pool: Pool, options: RetryOptions): Promise<boolean> {
  const result = await pool.query(
    `UPDATE social_inbox SET
       state=CASE WHEN attempts >= $6 THEN 'failed' ELSE 'retry' END,
       due_at=$3::timestamptz +
         (LEAST(power(2,attempts)*$4::numeric,$5::numeric) * interval '1 millisecond'),
       lease_token=NULL,lease_expires_at=NULL,
       stop_reason=CASE WHEN attempts >= $6 THEN 'failed-permanent'
         ELSE 'retry-transient' END,updated_at=$3
     WHERE inbox_id=$1 AND lease_token=$2 AND state='claimed'`,
    [
      options.inboxId,
      options.leaseToken,
      options.now,
      options.baseMs,
      options.maxMs,
      options.maxAttempts,
    ],
  );
  return result.rowCount === 1;
}

/** Finish only while this run still owns the lease. */
export async function finishInbox(
  client: PoolClient,
  inboxId: string,
  leaseToken: string,
  stopReason: string,
  now: Date,
): Promise<boolean> {
  const state = stopReason.startsWith("skipped-") ? "skipped" : "done";
  const result = await client.query(
    `UPDATE social_inbox SET state=$3,stop_reason=$4,lease_token=NULL,
       lease_expires_at=NULL,updated_at=$5
     WHERE inbox_id=$1 AND lease_token=$2 AND state='claimed'`,
    [inboxId, leaseToken, state, stopReason, now],
  );
  return result.rowCount === 1;
}
