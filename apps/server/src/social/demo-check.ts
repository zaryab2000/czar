import type { Config } from "@czar/config";
import type { Pool } from "pg";
import { serviceIdFor } from "#src/social/demo-seed";

export interface DemoChecks {
  readonly controlledRepresentatives: number;
  readonly activeClassSubscriptions: number;
  readonly experiencePosts: number;
  readonly openAuditIncidents: number;
  readonly startingRank: readonly string[];
  readonly passed: boolean;
}

/** Read the five SCR-183 §4 seed checks without changing demo state. */
export async function runDemoCheck(pool: Pool, config: Config): Promise<DemoChecks> {
  const quick = serviceIdFor(config, "czar-audit-quick");
  const deep = serviceIdFor(config, "czar-audit-deep");
  const reps = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM social_representatives r
     JOIN users u USING(user_id)
     WHERE u.controlled AND r.controlled AND r.sharing='structured'
       AND NOT r.paused AND r.consent_text_version=$1`,
    [String(config.get("social.consentTextVersion"))],
  );
  const subscriptions = await pool.query<{ count: string }>(
    `SELECT count(DISTINCT r.representative_id)::text AS count FROM social_subscriptions s
     JOIN social_representatives r USING(representative_id)
     WHERE r.controlled AND s.subject_key='class:eip155:5042002:smart-contract-audit'
       AND s.expires_at>now()`,
  );
  const posts = await pool.query<{ count: string }>(
    `SELECT count(DISTINCT r.representative_id)::text AS count FROM social_posts p
     JOIN social_representatives r ON r.representative_id=p.author_id
     WHERE r.controlled AND p.kind='experience' AND p.tombstoned_at IS NULL`,
  );
  const incidents = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM social_incidents
     WHERE network='eip155:5042002' AND service_id=ANY($1::text[])
       AND task_class='smart-contract-audit' AND state='open'`,
    [[quick, deep]],
  );
  const decisions = await pool.query<{
    decision: { ranked?: { service_id: string; badges: string[] }[] };
  }>(
    `SELECT decision FROM ranking_decisions
     WHERE decision->'query'->>'task_class'='smart-contract-audit'
     ORDER BY created_at DESC LIMIT 1`,
  );
  const ranked = decisions.rows[0]?.decision.ranked ?? [];
  const rank = ranked.map((row) => row.service_id);
  const result = {
    controlledRepresentatives: Number(reps.rows[0]?.count ?? 0),
    activeClassSubscriptions: Number(subscriptions.rows[0]?.count ?? 0),
    experiencePosts: Number(posts.rows[0]?.count ?? 0),
    openAuditIncidents: Number(incidents.rows[0]?.count ?? 0),
    startingRank: rank,
  };
  return {
    ...result,
    passed:
      result.controlledRepresentatives === 3 &&
      result.activeClassSubscriptions === 3 &&
      result.experiencePosts === 3 &&
      result.openAuditIncidents === 0 &&
      rank[0] === quick &&
      rank[1] === deep &&
      !ranked.slice(0, 2).some((row) => row.badges.includes("incident-open")),
  };
}
