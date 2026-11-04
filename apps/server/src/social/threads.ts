import type { Pool } from "pg";
import { validateSocialThreadProjection, type SocialThreadProjection } from "@czar/schemas";
import { day } from "#src/social/posts";
import { isPublicContentSafe } from "#src/social/projection/denylist";

interface ThreadRow {
  thread_id: string;
  kind: SocialThreadProjection["kind"];
  network: string;
  service_id: string | null;
  version_id: string | null;
  task_class: string | null;
  capability_tag: string | null;
  state: SocialThreadProjection["state"];
  contributions: number;
  revision: number;
  incident_id: string | null;
  created_at: Date;
}

export function projectThread(row: ThreadRow): SocialThreadProjection {
  const thread: SocialThreadProjection = {
    threadId: row.thread_id,
    kind: row.kind,
    network: row.network,
    ...(row.service_id ? { serviceId: row.service_id } : {}),
    ...(row.kind === "incident"
      ? { versionId: row.version_id === "ver_unknown" ? null : row.version_id }
      : {}),
    ...(row.task_class ? { taskClass: row.task_class } : {}),
    ...(row.capability_tag ? { capabilityTag: row.capability_tag } : {}),
    state: row.state,
    contributions: row.contributions,
    revision: row.revision,
    ...(row.incident_id ? { incidentId: row.incident_id } : {}),
    createdAt: day(row.created_at),
  };
  if (!validateSocialThreadProjection(thread)) throw new Error("Invalid social thread projection.");
  return thread;
}

export async function getThread(
  pool: Pool,
  threadId: string,
): Promise<SocialThreadProjection | null> {
  const result = await pool.query<ThreadRow>("SELECT * FROM social_threads WHERE thread_id=$1", [
    threadId,
  ]);
  const row = result.rows[0];
  if (!row) return null;
  const thread = projectThread(row);
  return isPublicContentSafe(thread, []) ? thread : null;
}

export async function listThreads(
  pool: Pool,
  options: {
    kind?: string | undefined;
    serviceId?: string | undefined;
    state?: string | undefined;
    cursor?: string;
    limit: number;
  },
): Promise<{ items: SocialThreadProjection[]; nextCursor: string | null }> {
  const result = await pool.query<ThreadRow>(
    `SELECT * FROM social_threads WHERE ($1::text IS NULL OR kind=$1)
       AND ($2::text IS NULL OR service_id=$2) AND ($3::text IS NULL OR state=$3)
       AND ($4::text IS NULL OR (created_at,thread_id) <
         (SELECT created_at,thread_id FROM social_threads WHERE thread_id=$4))
     ORDER BY created_at DESC,thread_id DESC LIMIT $5`,
    [
      options.kind ?? null,
      options.serviceId ?? null,
      options.state ?? null,
      options.cursor ?? null,
      options.limit + 1,
    ],
  );
  const rows = result.rows.slice(0, options.limit);
  return {
    items: rows.map(projectThread).filter((thread) => isPublicContentSafe(thread, [])),
    nextCursor: result.rows.length > options.limit ? (rows.at(-1)?.thread_id ?? null) : null,
  };
}

interface IncidentRow {
  incident_id: string;
  network: string;
  service_id: string;
  version_id: string;
  task_class: string;
  state: string;
  distinct_owners: number;
  negative_units: number;
  positive_units_since: number;
  opened_at: Date;
  closed_at: Date | null;
  close_reason: string | null;
  thread_id: string | null;
}

export function projectIncident(row: IncidentRow): Record<string, unknown> {
  return {
    incidentId: row.incident_id,
    network: row.network,
    serviceId: row.service_id,
    versionId: row.version_id === "ver_unknown" ? null : row.version_id,
    taskClass: row.task_class,
    state: row.state,
    distinctOwners: row.distinct_owners,
    negativeUnits: row.negative_units,
    positiveUnitsSince: row.positive_units_since,
    openedAt: day(row.opened_at),
    closedAt: row.closed_at ? day(row.closed_at) : null,
    closeReason: row.close_reason,
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
  };
}

export async function listIncidents(
  pool: Pool,
  options: {
    state?: string | undefined;
    network?: string | undefined;
    cursor?: string;
    limit: number;
  },
): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }> {
  const result = await pool.query<IncidentRow>(
    `SELECT * FROM social_incidents WHERE thread_id IS NOT NULL
       AND ($1::text IS NULL OR state=$1)
       AND ($2::text IS NULL OR network=$2)
       AND ($3::text IS NULL OR (opened_at,incident_id) <
         (SELECT opened_at,incident_id FROM social_incidents WHERE incident_id=$3))
     ORDER BY opened_at DESC,incident_id DESC LIMIT $4`,
    [options.state ?? null, options.network ?? null, options.cursor ?? null, options.limit + 1],
  );
  const rows = result.rows.slice(0, options.limit);
  return {
    items: rows.map(projectIncident).filter((incident) => isPublicContentSafe(incident, [])),
    nextCursor: result.rows.length > options.limit ? (rows.at(-1)?.incident_id ?? null) : null,
  };
}

export async function getIncident(
  pool: Pool,
  incidentId: string,
): Promise<Record<string, unknown> | null> {
  const result = await pool.query<IncidentRow>(
    "SELECT * FROM social_incidents WHERE incident_id=$1 AND thread_id IS NOT NULL",
    [incidentId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const incident = projectIncident(row);
  return isPublicContentSafe(incident, []) ? incident : null;
}
