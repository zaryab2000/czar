import type { Pool } from "pg";
import type { ObservationRow } from "#src/evidence/observations";

export type HealthFact =
  | "settled-not-delivered"
  | "repeated-unsettled-failure"
  | "job-failed"
  | "injection-blocked";

export type HealthRow = Pick<
  ObservationRow,
  | "obsId"
  | "userId"
  | "network"
  | "serviceId"
  | "versionId"
  | "rail"
  | "settledAt"
  | "releasedAt"
  | "delivered"
  | "jobState"
>;

export type HealthEvidence =
  | { readonly kind: "retry-exhausted"; readonly obsId: string }
  | { readonly kind: "job-history"; readonly obsId: string; readonly submitted: boolean }
  | {
      readonly kind: "job-rejected";
      readonly obsId: string;
      readonly reason:
        | "report-fail"
        | "czar:deliverable-missing"
        | "czar:late"
        | "czar:undecided"
        | "czar:fees-changed"
        | "czar:owner-froze"
        | "czar:unfunded-submit"
        | "unknown";
    }
  | {
      readonly kind: "boundary";
      readonly obsId: string;
      readonly flags: readonly string[];
      readonly limits: readonly string[];
    };

export interface FactCandidate {
  readonly fact: HealthFact;
  readonly obsId: string;
}

/** Derives supplier health facts from payment rows and verified boundary or chain evidence. */
export function healthFacts(
  rows: readonly HealthRow[],
  reports: readonly HealthEvidence[],
  config: { readonly consecutiveFailures: number },
): readonly FactCandidate[] {
  const facts: FactCandidate[] = [];
  for (const row of rows) {
    const evidence = reports.filter((report) => report.obsId === row.obsId);
    if (row.rail !== "erc8183-job") {
      const exhausted = evidence.some((report) => report.kind === "retry-exhausted");
      if (row.settledAt && (row.delivered === 0 || (row.delivered === null && exhausted)))
        facts.push({ fact: "settled-not-delivered", obsId: row.obsId });
    } else if (row.settledAt) {
      const expiredWithoutSubmission =
        row.jobState === "Expired" &&
        !evidence.some((report) => report.kind === "job-rejected") &&
        evidence.some((report) => report.kind === "job-history" && !report.submitted);
      const supplierRejection = evidence.some(
        (report) =>
          report.kind === "job-rejected" &&
          ["report-fail", "czar:deliverable-missing", "czar:late"].includes(report.reason),
      );
      if (expiredWithoutSubmission || supplierRejection)
        facts.push({ fact: "job-failed", obsId: row.obsId });
    }
    if (
      evidence.some(
        (report) =>
          report.kind === "boundary" &&
          report.flags.includes("injection-quarantined") &&
          !report.limits.includes("screen-unavailable"),
      )
    )
      facts.push({ fact: "injection-blocked", obsId: row.obsId });
  }
  const groups = new Map<string, HealthRow[]>();
  for (const row of rows) {
    if (row.rail === "erc8183-job") continue;
    const key = `${row.userId}:${row.network}:${row.serviceId}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const group of groups.values()) {
    const latest = group.slice(0, config.consecutiveFailures);
    if (
      latest.length === config.consecutiveFailures &&
      latest.every((row) => row.releasedAt !== null && row.settledAt === null)
    )
      facts.push({ fact: "repeated-unsettled-failure", obsId: latest[0]!.obsId });
  }
  return facts;
}

/** Writes immutable facts; replaying a payment never duplicates its fact. */
export async function writeFacts(pool: Pool, facts: readonly FactCandidate[]): Promise<void> {
  for (const { fact, obsId } of facts) {
    const result = await pool.query(
      `INSERT INTO supplier_health (fact,obs_id,user_id,network,service_id,version_id)
       SELECT $1,obs_id,user_id,network,service_id,version_id
       FROM observations WHERE obs_id=$2
       ON CONFLICT (fact,obs_id) DO NOTHING`,
      [fact, obsId],
    );
    if (result.rowCount === 0) {
      const existing = await pool.query(
        "SELECT 1 FROM supplier_health WHERE fact=$1 AND obs_id=$2",
        [fact, obsId],
      );
      if (existing.rowCount !== 1)
        throw new Error(`Cannot write supplier health fact: observation ${obsId} is missing.`);
    }
  }
}

/** Clears owner-specific facts only after an explicitly approved, delivered settlement. */
export async function clearFacts(pool: Pool, obsId: string): Promise<void> {
  await pool.query(
    `UPDATE supplier_health h
     SET cleared_at=now(),cleared_by_obs_id=o.obs_id
     FROM observations o
     JOIN objectives objective ON objective.objective_id=o.objective_id
     JOIN plans p ON p.plan_id=objective.plan_id
     WHERE o.obs_id=$1 AND o.settled_at IS NOT NULL AND o.delivered=1
       AND p.state='approved' AND objective.envelope_ref=o.envelope_ref
       AND h.fact IN ('settled-not-delivered','repeated-unsettled-failure','job-failed')
       AND h.user_id=o.user_id AND h.network=o.network AND h.service_id=o.service_id
       AND h.obs_id<>o.obs_id AND h.at<o.settled_at AND h.cleared_at IS NULL`,
    [obsId],
  );
}

/** Lists the current owner's approval facts; H4 is a supplier-wide exclusion. */
export async function openOwnerFacts(
  pool: Pool,
  userId: string,
  network: string,
  serviceId: string,
): Promise<readonly HealthFact[]> {
  const result = await pool.query<{ fact: HealthFact }>(
    `SELECT DISTINCT fact FROM supplier_health
     WHERE user_id=$1 AND network=$2 AND service_id=$3 AND cleared_at IS NULL
       AND fact IN ('settled-not-delivered','repeated-unsettled-failure','job-failed')`,
    [userId, network, serviceId],
  );
  return result.rows.map((row) => row.fact);
}

export async function isInjectionBlocked(
  pool: Pool,
  network: string,
  serviceId: string,
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM supplier_health WHERE network=$1 AND service_id=$2
       AND fact='injection-blocked' AND cleared_at IS NULL LIMIT 1`,
    [network, serviceId],
  );
  return result.rowCount !== 0;
}
