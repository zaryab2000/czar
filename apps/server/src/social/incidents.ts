import { createHash, randomBytes } from "node:crypto";
import type { Config } from "@czar/config";
import type { RankingDecision } from "@czar/schemas";
import type { Pool, PoolClient } from "pg";
import { randomId } from "#src/http/ids";
import { isPublicContentSafe } from "#src/social/projection/denylist";

export interface OpenIncident {
  readonly incidentId: string;
  readonly serviceId: string;
  readonly versionId: string;
  readonly distinctOwners: number;
  readonly negativeUnits: number;
  readonly openedAt: string;
}

interface IncidentRow {
  incident_id: string;
  service_id: string;
  version_id: string;
  distinct_owners: number;
  negative_units: number;
  opened_at: Date;
}

/** Read currently open incidents without consulting social posts. */
export async function openIncidentsFor(
  pool: Pool,
  network: string,
  serviceIds: readonly string[],
  taskClass: string,
): Promise<OpenIncident[]> {
  if (serviceIds.length === 0) return [];
  const result = await pool.query<IncidentRow>(
    `SELECT incident_id,service_id,version_id,distinct_owners,negative_units,opened_at
     FROM social_incidents WHERE state='open' AND network=$1 AND service_id=ANY($2::text[])
       AND task_class=$3 ORDER BY opened_at,incident_id`,
    [network, serviceIds, taskClass],
  );
  return result.rows.map((row) => ({
    incidentId: row.incident_id,
    serviceId: row.service_id,
    versionId: row.version_id,
    distinctOwners: row.distinct_owners,
    negativeUnits: row.negative_units,
    openedAt: row.opened_at.toISOString(),
  }));
}

/** Apply the recorded incident overlay after Wilson ordering, preserving scores. */
export function overlayIncidents(
  ranked: RankingDecision["ranked"],
  incidents: readonly OpenIncident[],
): RankingDecision["ranked"] {
  const rows = ranked.map((row) => {
    const incident = incidents.find(
      (item) =>
        item.serviceId === row.service_id &&
        (item.versionId === row.version_id || item.versionId === "ver_unknown"),
    );
    if (!incident) return row;
    return {
      ...row,
      badges: [...row.badges, "incident-open"],
      features: {
        ...row.features,
        incident: {
          incident_id: incident.incidentId,
          distinct_owners: incident.distinctOwners,
          negative_units: incident.negativeUnits,
          opened_at: incident.openedAt,
        },
      },
    };
  });
  const clean = rows.filter((row) => !row.badges.includes("incident-open"));
  const flagged = rows.filter((row) => row.badges.includes("incident-open"));
  return [...clean, ...flagged].map((row, index) => ({ ...row, rank: index + 1 }));
}

/** Match the chosen supplier to its immutable ranked or unverified decision version. */
export function incidentForSelection(
  decision: Pick<RankingDecision, "ranked" | "unverified">,
  serviceId: string,
  incidents: readonly OpenIncident[],
): OpenIncident | null {
  const versionId =
    decision.ranked.find((row) => row.service_id === serviceId)?.version_id ??
    decision.unverified.find((row) => row.service_id === serviceId)?.version_id;
  return (
    incidents.find(
      (incident) =>
        incident.serviceId === serviceId &&
        (incident.versionId === "ver_unknown" || incident.versionId === versionId),
    ) ?? null
  );
}

interface ObservationRow {
  objective_id: string;
  network: string;
  service_id: string;
  version_id: string;
  task_class: string;
  user_id: string;
  settled_at: Date;
  delivered: number | null;
  rating: "good" | "bad" | null;
}

interface StoredIncident extends IncidentRow {
  network: string;
  task_class: string;
  state: "open" | "closed";
  closed_at: Date | null;
  thread_id: string | null;
}

interface VersionRow {
  network: string;
  service_id: string;
  version_id: string;
  first_seen_at: Date;
}

interface IncidentKey {
  network: string;
  serviceId: string;
  versionId: string;
  taskClass: string;
}

function sameKey(row: ObservationRow | StoredIncident, key: IncidentKey): boolean {
  return (
    row.network === key.network &&
    row.service_id === key.serviceId &&
    row.version_id === key.versionId &&
    row.task_class === key.taskClass
  );
}

function id(prefix: string): string {
  return randomId(prefix, { bytes: randomBytes });
}

async function privateLabels(
  client: PoolClient,
  observations: readonly ObservationRow[],
): Promise<string[] | null> {
  const objectiveIds = [...new Set(observations.map((row) => row.objective_id))];
  if (objectiveIds.length === 0) return null;
  const found = await client.query<{ objective_id: string; labels: unknown }>(
    `SELECT objective_id,social_objective_subject_labels(objective_id) AS labels
     FROM social_objective_projection WHERE objective_id=ANY($1::text[])`,
    [objectiveIds],
  );
  if (found.rows.length !== objectiveIds.length) return null;
  const labels: string[] = [];
  for (const row of found.rows) {
    if (!Array.isArray(row.labels) || !row.labels.every((label) => typeof label === "string"))
      return null;
    labels.push(...row.labels);
  }
  return labels;
}

async function systemPost(args: {
  client: PoolClient;
  threadId: string;
  template: string;
  values: Record<string, string | number>;
  entityId: string;
  transition: "opened" | "closed";
  now: Date;
  subjectLabels: readonly string[] | null;
}): Promise<void> {
  const { client, threadId, template, values, entityId, transition, now, subjectLabels } = args;
  const card = { template, values };
  const actionId = createHash("sha256")
    .update("system")
    .update(template)
    .update(entityId)
    .update(transition)
    .digest("hex");
  if (!subjectLabels || !isPublicContentSafe(card, subjectLabels)) return;
  await client.query(
    `INSERT INTO social_posts(post_id,thread_id,author_id,kind,card,action_id,created_at)
     VALUES($1,$2,NULL,'system',$3::jsonb,$4,$5) ON CONFLICT(action_id) DO NOTHING`,
    [id("pst_"), threadId, JSON.stringify(card), actionId, now],
  );
}

async function opened(args: {
  client: PoolClient;
  key: IncidentKey;
  negativeUnits: number;
  distinctOwners: number;
  windowStart: Date;
  now: Date;
  windowDays: number;
  subjectLabels: readonly string[] | null;
}): Promise<void> {
  const {
    client,
    key,
    negativeUnits,
    distinctOwners,
    windowStart,
    now,
    windowDays,
    subjectLabels,
  } = args;
  const incidentId = id("inc_");
  const threadId = id("thr_");
  const subject = `incident:${key.network}:${key.serviceId}:${key.versionId}:${key.taskClass}`;
  await client.query(
    `INSERT INTO social_threads(thread_id,kind,network,service_id,version_id,task_class,
      subject_key,incident_id,created_at,updated_at)
     VALUES($1,'incident',$2,$3,$4,$5,$6,$7,$8,$8)`,
    [threadId, key.network, key.serviceId, key.versionId, key.taskClass, subject, incidentId, now],
  );
  await client.query(
    `INSERT INTO social_incidents(incident_id,network,service_id,version_id,task_class,state,
      distinct_owners,negative_units,window_start,window_end,opened_at,thread_id)
     VALUES($1,$2,$3,$4,$5,'open',$6,$7,$8,$9,$9,$10)`,
    [
      incidentId,
      key.network,
      key.serviceId,
      key.versionId,
      key.taskClass,
      distinctOwners,
      negativeUnits,
      windowStart,
      now,
      threadId,
    ],
  );
  await systemPost({
    client,
    threadId,
    template: "system.incident.opened",
    values: {
      distinctOwners,
      negativeUnits,
      serviceId: key.serviceId,
      versionClause: key.versionId === "ver_unknown" ? "" : ` (${key.versionId})`,
      taskClass: key.taskClass,
      windowDays,
    },
    entityId: incidentId,
    transition: "opened",
    now,
    subjectLabels,
  });
  await client.query(
    `INSERT INTO outbox_events(name,payload,delivered_at)
     VALUES('social.incident.opened',$1::jsonb,now())`,
    [JSON.stringify({ incidentId })],
  );
}

async function closed(args: {
  client: PoolClient;
  incident: StoredIncident;
  reason: "recovered" | "window-cleared" | "new-version";
  positiveUnits: number;
  now: Date;
  subjectLabels: readonly string[] | null;
}): Promise<void> {
  const { client, incident, reason, positiveUnits, now, subjectLabels } = args;
  await client.query(
    `UPDATE social_incidents SET state='closed',closed_at=$2,close_reason=$3,
      positive_units_since=$4 WHERE incident_id=$1 AND state='open'`,
    [incident.incident_id, now, reason, positiveUnits],
  );
  if (!incident.thread_id) throw new Error(`Incident ${incident.incident_id} has no thread.`);
  await client.query("UPDATE social_threads SET state='closed',updated_at=$2 WHERE thread_id=$1", [
    incident.thread_id,
    now,
  ]);
  await systemPost({
    client,
    threadId: incident.thread_id,
    template: "system.incident.closed",
    values: {
      closeReason: reason,
      positiveUnits,
    },
    entityId: incident.incident_id,
    transition: "closed",
    now,
    subjectLabels,
  });
  await client.query(
    `INSERT INTO outbox_events(name,payload,delivered_at)
     VALUES('social.incident.closed',$1::jsonb,now())`,
    [JSON.stringify({ incidentId: incident.incident_id })],
  );
}

function keyFor(row: ObservationRow | StoredIncident): IncidentKey {
  return {
    network: row.network,
    serviceId: row.service_id,
    versionId: row.version_id,
    taskClass: row.task_class,
  };
}

function keyText(key: IncidentKey): string {
  return JSON.stringify([key.network, key.serviceId, key.versionId, key.taskClass]);
}

async function evaluateKey(args: {
  client: PoolClient;
  key: IncidentKey;
  observations: readonly ObservationRow[];
  incidents: readonly StoredIncident[];
  versions: readonly VersionRow[];
  config: Config;
  now: Date;
}): Promise<void> {
  const { client, key, observations, incidents, versions, config, now } = args;
  const windowDays = Number(config.get("social.incidentWindowDays"));
  const windowStart = new Date(now.getTime() - windowDays * 86400000);
  const prior = incidents.filter((item) => sameKey(item, key));
  const open = prior.find((item) => item.state === "open");
  const lastClosed = prior.reduce<Date | null>(
    (last, item) => (item.closed_at && (!last || item.closed_at > last) ? item.closed_at : last),
    null,
  );
  const rows = observations.filter((item) => sameKey(item, key));
  const negatives = rows.filter(
    (item) =>
      item.settled_at >= windowStart &&
      (!lastClosed || item.settled_at > lastClosed) &&
      (item.delivered === 0 || item.rating === "bad"),
  );
  const owners = new Set(negatives.map((item) => item.user_id)).size;
  const current = versions.find(
    (item) =>
      item.network === key.network &&
      item.service_id === key.serviceId &&
      item.version_id === key.versionId,
  );
  const newer =
    current !== undefined &&
    versions.some(
      (version) =>
        version.network === key.network &&
        version.service_id === key.serviceId &&
        version.version_id !== key.versionId &&
        version.first_seen_at > current.first_seen_at &&
        observations.some(
          (item) =>
            item.network === key.network &&
            item.service_id === key.serviceId &&
            item.version_id === version.version_id,
        ),
    );
  const lastNegative = negatives.reduce<Date | null>(
    (last, item) => (!last || item.settled_at > last ? item.settled_at : last),
    null,
  );
  const positives = rows.filter(
    (item) => item.rating === "good" && (!lastNegative || item.settled_at > lastNegative),
  );
  if (open) {
    await client.query(
      `UPDATE social_incidents SET distinct_owners=$2,negative_units=$3,
         positive_units_since=$4,window_start=$5,window_end=$6
       WHERE incident_id=$1 AND state='open'`,
      [open.incident_id, owners, negatives.length, positives.length, windowStart, now],
    );
    const recovered =
      positives.length >= Number(config.get("social.incidentRecoveryPositives")) &&
      new Set(positives.map((item) => item.user_id)).size >= 2;
    const reason = newer
      ? "new-version"
      : owners < Number(config.get("social.incidentMinOwners"))
        ? "window-cleared"
        : recovered
          ? "recovered"
          : null;
    if (reason)
      await closed({
        client,
        incident: open,
        reason,
        positiveUnits: positives.length,
        now,
        subjectLabels: await privateLabels(client, rows),
      });
    return;
  }
  if (!newer && owners >= Number(config.get("social.incidentMinOwners")))
    await opened({
      client,
      key,
      negativeUnits: negatives.length,
      distinctOwners: owners,
      windowStart,
      now,
      windowDays,
      subjectLabels: await privateLabels(client, negatives),
    });
}

/** Recompute incident state from settled evidence and corrected effective ratings. */
export async function evaluateIncidents(pool: Pool, config: Config, now: Date): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('social-incidents'))");
    const rows = await client.query<ObservationRow>(
      `SELECT o.objective_id,o.network,o.service_id,o.version_id,o.task_class,o.user_id,o.settled_at,
        o.delivered,e.value AS rating
       FROM social_observation_projection o
       LEFT JOIN rating_receipts rr ON rr.obs_id=o.obs_id
       LEFT JOIN ratings_effective e ON e.rating_id=rr.rating_id
       WHERE o.settled_at IS NOT NULL AND o.released_at IS NULL
         AND ($1::boolean OR NOT o.controlled)
       ORDER BY o.settled_at`,
      [Boolean(config.get("social.incidentsCountControlled"))],
    );
    const history = await client.query<StoredIncident>("SELECT * FROM social_incidents");
    const versions = await client.query<VersionRow>(
      "SELECT network,service_id,version_id,first_seen_at FROM service_versions",
    );
    const keys = new Map<string, IncidentKey>();
    for (const row of [...rows.rows, ...history.rows]) {
      const key = keyFor(row);
      keys.set(keyText(key), key);
    }
    for (const key of keys.values())
      await evaluateKey({
        client,
        key,
        observations: rows.rows,
        incidents: history.rows,
        versions: versions.rows,
        config,
        now,
      });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
