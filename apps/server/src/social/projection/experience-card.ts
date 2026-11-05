import type { Pool, PoolClient } from "pg";
import { validateSchema, type SocialExperienceCard } from "@czar/schemas";
import { day } from "#src/social/posts";

interface ObservationRow {
  obs_id: string;
  user_id: string;
  network: string;
  rail: string;
  service_id: string;
  version_id: string;
  task_class: string;
  delivered: number | null;
  settled_at: Date;
  capability: string | null;
  unit_amount: string | null;
  output_format: string | null;
  controlled: boolean | null;
}

export interface ExperienceProjection {
  card: SocialExperienceCard;
  observationIds: string[];
  subjectLabels: string[];
}

function amountBand(unitAmount: string, callsPaid: number): SocialExperienceCard["amountBand"] {
  if (!/^[0-9]+$/.test(unitAmount)) throw new Error("Social step unitAmount is not Amount6.");
  const total = BigInt(unitAmount) * BigInt(callsPaid);
  if (total < 10_000n) return "lt-0.01";
  if (total <= 100_000n) return "0.01-0.1";
  if (total <= 1_000_000n) return "0.1-1";
  if (total <= 5_000_000n) return "1-5";
  return "gt-5";
}

function sameStep(rows: readonly ObservationRow[]): boolean {
  const first = rows[0];
  if (!first) return false;
  return rows.every(
    (row) =>
      row.user_id === first.user_id &&
      row.network === first.network &&
      row.rail === first.rail &&
      row.service_id === first.service_id &&
      row.version_id === first.version_id &&
      row.task_class === first.task_class,
  );
}

/** Build a public card solely from permissioned evidence projections. */
export async function buildExperienceCard(
  db: Pool | PoolClient,
  objectiveId: string,
  stepIndex: number,
): Promise<ExperienceProjection | null> {
  const observations = await db.query<ObservationRow>(
    `SELECT o.obs_id,o.user_id,o.network,o.rail,o.service_id,o.version_id,o.task_class,
       o.delivered,o.settled_at,s.capability,s.unit_amount,obj.output_format,
       rep.controlled
     FROM social_observation_projection o
     JOIN social_objective_projection obj ON obj.objective_id=o.objective_id
     LEFT JOIN social_step_projection s ON s.plan_id=obj.plan_id AND s.step_index=o.step_index
     LEFT JOIN social_representatives rep ON rep.user_id=o.user_id
     WHERE o.objective_id=$1 AND o.step_index=$2 AND o.settled_at IS NOT NULL
       AND o.released_at IS NULL AND o.job_state IS DISTINCT FROM 'Refunded'
       AND o.job_state IS DISTINCT FROM 'Expired'
     ORDER BY o.call_index`,
    [objectiveId, stepIndex],
  );
  const rows = observations.rows;
  const first = rows[0];
  if (!first) return null;
  if (!sameStep(rows) || !first.capability || !first.unit_amount) return null;
  const rated = await db.query<{ value: "good" | "bad" }>(
    "SELECT value FROM ratings_effective WHERE objective_id=$1 AND step_index=$2",
    [objectiveId, stepIndex],
  );
  const labels = await db.query<{ labels: string[] }>(
    "SELECT social_objective_subject_labels($1) AS labels",
    [objectiveId],
  );
  const delivered = rows.filter((row) => row.delivered === 1).length;
  const undelivered = rows.filter((row) => row.delivered === 0).length;
  const deliveryOutcome =
    delivered === 0 && undelivered === 0
      ? "unknown"
      : delivered > 0 && undelivered > 0
        ? "partial"
        : delivered > 0
          ? "delivered"
          : "not-delivered";
  const latest = rows.reduce((a, b) => (a.settled_at > b.settled_at ? a : b)).settled_at;
  const card = {
    cardVersion: "1",
    network: first.network,
    supplierKind: first.rail === "erc8183-job" ? "erc8183" : "x402",
    serviceId: first.service_id,
    versionId: first.version_id === "ver_unknown" ? null : first.version_id,
    taskClass: first.task_class,
    capabilityTag: first.capability,
    outputFormat: first.output_format,
    deliveryOutcome,
    rating: rated.rows[0]?.value ?? "none",
    callsPaid: rows.length,
    callsDelivered: delivered,
    amountBand: amountBand(first.unit_amount, rows.length),
    controlled: first.controlled ?? false,
    observedAt: day(latest),
  };
  if (!validateSchema("social-experience-card", card)) return null;
  return {
    card,
    observationIds: rows.map((row) => row.obs_id),
    subjectLabels: labels.rows[0]?.labels ?? [],
  };
}
