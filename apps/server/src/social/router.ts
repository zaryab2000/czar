import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Config } from "@czar/config";
import { taskClassFor } from "#src/selection/task-class";

type Database = Pool | PoolClient;
type Ref = Record<string, unknown>;

interface Candidate {
  representative_id: string;
  has_service: boolean;
  has_class: boolean;
  tag_match: boolean;
  recent_route: boolean;
}

interface Published {
  post_id: string;
  thread_id: string;
  author_id: string | null;
  kind: string;
  network: string;
  service_id: string | null;
  version_id: string | null;
  task_class: string | null;
  capability_tag: string | null;
  thread_kind: string;
  state: string;
  contributions: number;
}

function tie(postId: string, representativeId: string): string {
  return createHash("sha256").update(postId).update(representativeId).digest("hex");
}

async function insertInbox(
  db: Database,
  eventId: string,
  representativeId: string,
  kind: string,
  refs: Ref,
): Promise<void> {
  await db.query(
    `INSERT INTO social_inbox(representative_id,event_id,kind,refs)
     VALUES($1,$2,$3,$4) ON CONFLICT(representative_id,event_id) DO NOTHING`,
    [representativeId, eventId, kind, refs],
  );
}

async function routePost(
  db: Database,
  refs: Ref,
  eventId: string,
  maxRecipients: number,
  cooldownMinutes: number,
): Promise<void> {
  const postId = refs["postId"];
  const threadId = refs["threadId"];
  if (typeof postId !== "string" || typeof threadId !== "string") return;
  const found = await db.query<Published>(
    `SELECT p.post_id,p.thread_id,p.author_id,p.kind,t.network,t.service_id,t.version_id,
       t.task_class,t.capability_tag,t.kind AS thread_kind,t.state,t.contributions
     FROM social_posts p JOIN social_threads t ON t.thread_id=p.thread_id
     WHERE p.post_id=$1 AND t.thread_id=$2 AND p.tombstoned_at IS NULL`,
    [postId, threadId],
  );
  const post = found.rows[0];
  if (!post || (post.thread_kind === "question" && post.state !== "open")) return;
  const candidates = await db.query<Candidate>(
    `SELECT r.representative_id,
       EXISTS (SELECT 1 FROM social_observation_projection o
         WHERE o.user_id=r.user_id AND o.network=$2 AND o.service_id=$3
           AND ($4::text IS NULL OR o.version_id=$4) AND o.settled_at IS NOT NULL
           AND o.released_at IS NULL) AS has_service,
       EXISTS (SELECT 1 FROM social_observation_projection o
         WHERE o.user_id=r.user_id AND o.network=$2 AND o.task_class=$5
           AND o.settled_at IS NOT NULL AND o.released_at IS NULL) AS has_class,
       EXISTS (SELECT 1 FROM social_subscriptions s
         WHERE s.representative_id=r.representative_id
           AND s.subject_key='tag:'||$2||':'||$6 AND s.expires_at>now()) AS tag_match,
       EXISTS (SELECT 1 FROM social_inbox i JOIN outbox_events e ON e.event_id=i.event_id
         WHERE i.representative_id=r.representative_id AND i.kind='post-routed'
           AND e.created_at>now()-($7::integer * interval '1 minute')) AS recent_route
     FROM social_representatives r
     WHERE r.representative_id IS DISTINCT FROM $1 AND NOT r.paused
       AND ($8::text NOT IN ('question','lead') OR r.sharing<>'off')
       AND EXISTS (SELECT 1 FROM social_subscriptions s
         WHERE s.representative_id=r.representative_id AND s.expires_at>now()
           AND s.subject_key IN (
             'service:'||$2||':'||coalesce($3,''),
             'class:'||$2||':'||coalesce($5,''),
             'tag:'||$2||':'||coalesce($6,'')))`,
    [
      post.author_id,
      post.network,
      post.service_id,
      post.version_id,
      post.task_class,
      post.capability_tag,
      cooldownMinutes,
      post.kind,
    ],
  );
  const ranked = candidates.rows
    .map((candidate) => ({
      ...candidate,
      score:
        Number(candidate.has_service) * 3 +
        Number(candidate.has_class) * 2 +
        Number(candidate.tag_match) +
        Number(!candidate.recent_route),
    }))
    .toSorted(
      (a, b) =>
        b.score - a.score ||
        tie(postId, a.representative_id).localeCompare(tie(postId, b.representative_id)),
    );
  for (const candidate of ranked.slice(0, maxRecipients)) {
    const routingReason = candidate.has_service
      ? "has-evidence-for-service"
      : candidate.has_class
        ? "has-evidence-for-class"
        : "subscribed-tag";
    await insertInbox(db, eventId, candidate.representative_id, "post-routed", {
      postId,
      threadId,
      routingReason,
    });
  }
}

async function routeIncident(
  db: Database,
  refs: Ref,
  eventId: string,
  maxRecipients: number,
): Promise<void> {
  const incidentId = refs["incidentId"];
  if (typeof incidentId !== "string") return;
  const found = await db.query<{ representative_id: string }>(
    `SELECT r.representative_id FROM social_incidents inc
     JOIN social_observation_projection o ON o.network=inc.network
       AND o.service_id=inc.service_id AND o.task_class=inc.task_class
       AND (inc.version_id='ver_unknown' OR o.version_id=inc.version_id)
       AND o.settled_at IS NOT NULL AND o.released_at IS NULL
     JOIN social_representatives r ON r.user_id=o.user_id
     WHERE inc.incident_id=$1 AND NOT r.paused
     GROUP BY r.representative_id ORDER BY max(o.settled_at) DESC LIMIT $2`,
    [incidentId, maxRecipients],
  );
  for (const row of found.rows) {
    await insertInbox(db, eventId, row.representative_id, "incident-changed", { incidentId });
  }
}

/** Fan out one social event inside the consumer's cursor transaction. */
export async function routeSocialEvent(
  db: Database,
  name: string,
  refs: Ref,
  eventId: string,
  maxRecipientsPerPost: number,
  maxIncidentRecipients: number,
  cooldownMinutes: number,
): Promise<void> {
  if (name === "social.post.published") {
    await routePost(db, refs, eventId, maxRecipientsPerPost, cooldownMinutes);
  } else if (name === "social.incident.opened" || name === "social.incident.closed") {
    await routeIncident(db, refs, eventId, maxIncidentRecipients);
  } else if (name === "social.question.expired" && typeof refs["threadId"] === "string") {
    const owner = await db.query<{ opened_by: string }>(
      "SELECT opened_by FROM social_threads WHERE thread_id=$1",
      [refs["threadId"]],
    );
    if (owner.rows[0]?.opened_by) {
      await insertInbox(db, eventId, owner.rows[0].opened_by, "question-expired", refs);
    }
  }
}

/** Refresh derived subscriptions from evidence and objective projections. */
export async function refreshSubscriptions(
  db: Database,
  config: Config,
  now: Date,
  days: number,
): Promise<void> {
  const until = new Date(now.getTime() + days * 86_400_000);
  const since = new Date(now.getTime() - days * 86_400_000);
  await db.query(
    `INSERT INTO social_subscriptions(representative_id,subject_key,source,expires_at)
     SELECT DISTINCT r.representative_id,'service:'||o.network||':'||o.service_id,
       'purchase',$1 FROM social_observation_projection o
     JOIN social_representatives r ON r.user_id=o.user_id
     WHERE o.settled_at>=$2 AND o.released_at IS NULL
     ON CONFLICT(representative_id,subject_key) DO UPDATE SET expires_at=EXCLUDED.expires_at`,
    [until, since],
  );
  const objectives = await db.query<{ representative_id: string; capabilities: string[] }>(
    `SELECT r.representative_id,o.capabilities FROM social_objective_projection o
     JOIN social_representatives r ON r.user_id=o.user_id WHERE o.created_at>=$1`,
    [since],
  );
  const network = String(config.get("selection.paymentNetwork"));
  for (const row of objectives.rows) {
    for (const capability of row.capabilities ?? []) {
      for (const subjectKey of [
        `tag:${network}:${capability}`,
        `class:${network}:${taskClassFor(capability, config)}`,
      ]) {
        await db.query(
          `INSERT INTO social_subscriptions(representative_id,subject_key,source,expires_at)
           VALUES($1,$2,'objective',$3)
           ON CONFLICT(representative_id,subject_key) DO UPDATE SET expires_at=EXCLUDED.expires_at`,
          [row.representative_id, subjectKey, until],
        );
      }
    }
  }
}

/** Expire old question threads and enqueue one owner notification each. */
export async function expireQuestions(db: PoolClient, now: Date): Promise<number> {
  const expired = await db.query<{ thread_id: string }>(
    `UPDATE social_threads SET state='expired',revision=revision+1,updated_at=$1
     WHERE kind='question' AND state='open' AND expires_at<=$1 RETURNING thread_id`,
    [now],
  );
  for (const row of expired.rows) {
    await db.query(
      `INSERT INTO outbox_events(name,payload,delivered_at)
       VALUES('social.question.expired',$1,now())`,
      [{ threadId: row.thread_id }],
    );
  }
  return expired.rowCount ?? 0;
}
