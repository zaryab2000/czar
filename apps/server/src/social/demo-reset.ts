import type { Config } from "@czar/config";
import type { SafeFetch } from "@czar/x402";
import type { Pool, PoolClient } from "pg";
import { refreshDemoRanking, serviceIdFor } from "#src/social/demo-seed";

interface ResetTargets {
  readonly owners: string[];
  readonly representatives: string[];
  readonly objectives: string[];
  readonly plans: string[];
  readonly observations: string[];
  readonly ratings: string[];
  readonly realRatings: string[];
  readonly threads: string[];
  readonly posts: string[];
  readonly incidents: string[];
  readonly inbox: string[];
  readonly boundary: Date | null;
}

export interface DemoResetResult {
  readonly controlledOwnersDeleted: number;
  readonly rehearsalRatingsDeleted: number;
  readonly realRatingsSkippedWithoutBoundary: boolean;
}

async function ids(db: PoolClient, sql: string, params: unknown[]): Promise<string[]> {
  const result = await db.query<{ id: string }>(sql, params);
  return result.rows.map((row) => row.id);
}

async function captureTargets(db: PoolClient, services: readonly string[]): Promise<ResetTargets> {
  const owners = await ids(
    db,
    `SELECT u.user_id AS id FROM users u JOIN social_representatives r USING(user_id)
     WHERE u.controlled AND r.controlled AND u.network='eip155:5042002'
       AND r.handle=ANY($1::text[]) ORDER BY u.user_id`,
    [["Rep-CZ01", "Rep-CZ02", "Rep-CZ03"]],
  );
  const start = await db.query<{ boundary: Date | null }>(
    "SELECT min(created_at) AS boundary FROM users WHERE user_id=ANY($1::text[])",
    [owners],
  );
  const boundary = start.rows[0]?.boundary ?? null;
  const representatives = await ids(
    db,
    "SELECT representative_id AS id FROM social_representatives WHERE user_id=ANY($1::text[])",
    [owners],
  );
  const objectives = await ids(
    db,
    "SELECT objective_id AS id FROM objectives WHERE user_id=ANY($1::text[])",
    [owners],
  );
  const plans = await ids(
    db,
    "SELECT plan_id AS id FROM plans WHERE objective_id=ANY($1::text[])",
    [objectives],
  );
  const observations = await ids(
    db,
    "SELECT obs_id AS id FROM observations WHERE user_id=ANY($1::text[])",
    [owners],
  );
  const realRatings =
    boundary === null
      ? []
      : await ids(
          db,
          `SELECT r.rating_id AS id FROM ratings r JOIN users u USING(user_id)
     WHERE NOT u.controlled AND r.network='eip155:5042002'
       AND r.service_id=ANY($1::text[]) AND r.task_class='smart-contract-audit'
       AND r.created_at >= $2`,
          [services, boundary],
        );
  const controlledRatings = await ids(
    db,
    "SELECT rating_id AS id FROM ratings WHERE user_id=ANY($1::text[])",
    [owners],
  );
  const ratings = [...controlledRatings, ...realRatings];
  const subjects = services.map((id) => `service:eip155:5042002:${id}`);
  subjects.push("class:eip155:5042002:smart-contract-audit");
  const threads = await ids(
    db,
    `SELECT t.thread_id AS id FROM social_threads t
     WHERE t.network='eip155:5042002' AND (
       t.subject_key=ANY($1::text[])
       OR (t.kind='incident' AND t.service_id=ANY($2::text[])
         AND t.task_class='smart-contract-audit')
       OR (t.kind='question' AND EXISTS(SELECT 1 FROM social_posts p
         WHERE p.thread_id=t.thread_id AND p.kind='question'
           AND p.card->>'taskClass'='smart-contract-audit')))`,
    [subjects, services],
  );
  const posts = await ids(
    db,
    "SELECT post_id AS id FROM social_posts WHERE thread_id=ANY($1::text[])",
    [threads],
  );
  const incidents = await ids(
    db,
    `SELECT incident_id AS id FROM social_incidents
     WHERE thread_id=ANY($1::text[]) OR (network='eip155:5042002'
       AND service_id=ANY($2::text[]) AND task_class='smart-contract-audit')`,
    [threads, services],
  );
  const inbox = await ids(
    db,
    `SELECT inbox_id::text AS id FROM social_inbox
     WHERE representative_id=ANY($1::text[]) OR refs->>'objectiveId'=ANY($2::text[])
       OR refs->>'ratingId'=ANY($3::text[]) OR refs->>'postId'=ANY($4::text[])
       OR refs->>'threadId'=ANY($5::text[]) OR refs->>'incidentId'=ANY($6::text[])`,
    [representatives, objectives, ratings, posts, threads, incidents],
  );
  return {
    owners,
    representatives,
    objectives,
    plans,
    observations,
    ratings,
    realRatings,
    threads,
    posts,
    incidents,
    inbox,
    boundary,
  };
}

async function assertNoCrossSubjectReferences(db: PoolClient, target: ResetTargets): Promise<void> {
  const refs = await db.query(
    `SELECT 1 FROM social_posts p WHERE p.thread_id<>ALL($1::text[])
       AND (p.author_id=ANY($2::text[]) OR p.parent_post_id=ANY($3::text[])
         OR p.superseded_by=ANY($3::text[]))
     UNION ALL SELECT 1 FROM social_threads t WHERE t.thread_id<>ALL($1::text[])
       AND t.opened_by=ANY($2::text[])
     UNION ALL SELECT 1 FROM social_evidence_links e JOIN social_posts p USING(post_id)
       WHERE p.thread_id<>ALL($1::text[]) AND e.obs_id=ANY($4::text[])
     LIMIT 1`,
    [target.threads, target.representatives, target.posts, target.observations],
  );
  if (refs.rowCount) {
    throw new Error(
      "Demo reset found controlled evidence on another subject; manual review required.",
    );
  }
}

async function deleteSocial(
  db: PoolClient,
  target: ResetTargets,
  services: readonly string[],
): Promise<void> {
  await db.query(
    `DELETE FROM social_runs WHERE inbox_id::text=ANY($1::text[])
       OR representative_id=ANY($2::text[]) OR post_id=ANY($3::text[])`,
    [target.inbox, target.representatives, target.posts],
  );
  await db.query("DELETE FROM social_inbox WHERE inbox_id::text=ANY($1::text[])", [target.inbox]);
  await db.query(
    `DELETE FROM social_lessons WHERE user_id=ANY($1::text[])
       OR source_post_id=ANY($2::text[])
       OR (network='eip155:5042002' AND service_id=ANY($3::text[])
         AND task_class='smart-contract-audit')`,
    [target.owners, target.posts, services],
  );
  await db.query("DELETE FROM social_incidents WHERE incident_id=ANY($1::text[])", [
    target.incidents,
  ]);
  await db.query("DELETE FROM social_leads WHERE post_id=ANY($1::text[])", [target.posts]);
  await db.query(
    `DELETE FROM social_evidence_links WHERE post_id=ANY($1::text[])
       OR obs_id=ANY($2::text[])`,
    [target.posts, target.observations],
  );
  await db.query("DELETE FROM social_posts WHERE post_id=ANY($1::text[])", [target.posts]);
  await db.query("DELETE FROM social_threads WHERE thread_id=ANY($1::text[])", [target.threads]);
  const subjects = services.map((id) => `service:eip155:5042002:${id}`);
  subjects.push("class:eip155:5042002:smart-contract-audit");
  await db.query(
    `DELETE FROM social_subscriptions WHERE representative_id=ANY($1::text[])
       OR subject_key=ANY($2::text[])`,
    [target.representatives, subjects],
  );
  await db.query("DELETE FROM social_budgets WHERE representative_id=ANY($1::text[])", [
    target.representatives,
  ]);
  await db.query("DELETE FROM social_representatives WHERE representative_id=ANY($1::text[])", [
    target.representatives,
  ]);
}

async function deleteEvidence(db: PoolClient, target: ResetTargets): Promise<void> {
  await db.query(
    "DELETE FROM rating_receipts WHERE rating_id=ANY($1::text[]) OR obs_id=ANY($2::text[])",
    [target.ratings, target.observations],
  );
  await db.query("DELETE FROM ratings WHERE rating_id=ANY($1::text[])", [target.ratings]);
  await db.query(
    `DELETE FROM supplier_health WHERE obs_id=ANY($1::text[])
       OR cleared_by_obs_id=ANY($1::text[])`,
    [target.observations],
  );
  await db.query("DELETE FROM observations WHERE obs_id=ANY($1::text[])", [target.observations]);
}

async function deleteControlledOwners(db: PoolClient, target: ResetTargets): Promise<void> {
  // SCR-186 follow-up: retained events require this nullable FK to be cleared.
  await db.query("UPDATE outbox_events SET objective_id=NULL WHERE objective_id=ANY($1::text[])", [
    target.objectives,
  ]);
  await db.query("DELETE FROM step_executions WHERE plan_id=ANY($1::text[])", [target.plans]);
  await db.query("DELETE FROM steps WHERE plan_id=ANY($1::text[])", [target.plans]);
  await db.query("DELETE FROM plans WHERE plan_id=ANY($1::text[])", [target.plans]);
  await db.query("DELETE FROM objectives WHERE objective_id=ANY($1::text[])", [target.objectives]);
  await db.query("DELETE FROM devices WHERE user_id=ANY($1::text[])", [target.owners]);
  await db.query("DELETE FROM users WHERE user_id=ANY($1::text[])", [target.owners]);
}

/** Reset only the ruled Demo v1 rehearsal state in one transaction. */
export async function runDemoReset(
  pool: Pool,
  config: Config,
  now = new Date(),
  safeFetch?: SafeFetch,
): Promise<DemoResetResult> {
  const services = [
    serviceIdFor(config, "czar-audit-quick"),
    serviceIdFor(config, "czar-audit-deep"),
  ];
  const db = await pool.connect();
  let target: ResetTargets;
  try {
    await db.query("BEGIN");
    target = await captureTargets(db, services);
    await assertNoCrossSubjectReferences(db, target);
    await deleteSocial(db, target, services);
    await deleteEvidence(db, target);
    await deleteControlledOwners(db, target);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
  await refreshDemoRanking(pool, config, now, safeFetch);
  return {
    controlledOwnersDeleted: target.owners.length,
    rehearsalRatingsDeleted: target.realRatings.length,
    realRatingsSkippedWithoutBoundary: target.boundary === null,
  };
}
