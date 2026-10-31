import { dedupKey, obsId, paymentRefHash } from "@czar/hashing";
import { validateSchema, type PaymentRef } from "@czar/schemas";
import type { Pool } from "pg";
import { clearFacts, healthFacts, writeFacts, type HealthEvidence } from "#src/evidence/health";

export interface ObservationInsert {
  readonly userId: string;
  readonly vault: `0x${string}`;
  readonly network: string;
  readonly rail: "x402-exact" | "gateway-batched" | "erc8183-job";
  readonly serviceId: string;
  readonly versionId: string;
  readonly taskClass: string;
  readonly objectiveId: string;
  readonly envelopeRef: string;
  readonly stepIndex: number;
  readonly paymentRef: PaymentRef;
  readonly paymentId: string;
}

export interface ObservationRow {
  readonly obsId: string;
  readonly userId: string;
  readonly vault: string;
  readonly network: string;
  readonly rail: ObservationInsert["rail"];
  readonly serviceId: string;
  readonly versionId: string;
  readonly taskClass: string;
  readonly objectiveId: string;
  readonly envelopeRef: string;
  readonly stepIndex: number;
  readonly callIndex: number;
  readonly paymentRefHash: string;
  readonly paymentId: string;
  readonly dedupKey: string;
  readonly delivered: 0 | 1 | null;
  readonly jobState: JobState | null;
  readonly controlled: boolean;
  readonly settlementTx: string | null;
  readonly respondedAt: Date | null;
  readonly settledAt: Date | null;
  readonly releasedAt: Date | null;
}

export type JobState =
  | "Opened"
  | "Funded"
  | "Submitted"
  | "Completed"
  | "Refunded"
  | "Released"
  | "Expired";

export async function observationOwner(
  pool: Pool,
  planId: string,
): Promise<{ readonly userId: string; readonly objectiveId: string }> {
  const result = await pool.query<{ user_id: string; objective_id: string }>(
    `SELECT o.user_id,o.objective_id FROM plans p
     JOIN objectives o ON o.objective_id=p.objective_id WHERE p.plan_id=$1`,
    [planId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Plan ${planId} has no objective owner for its payment observation.`);
  return { userId: row.user_id, objectiveId: row.objective_id };
}

const EXISTING_ROW = `INSERT INTO observations
  SELECT * FROM observations WHERE obs_id=$1
  ON CONFLICT (obs_id) DO UPDATE`;

interface ExistingIdentity {
  readonly dedup_key: string;
  readonly payment_id: string;
  readonly user_id: string;
  readonly vault: string;
  readonly network: string;
  readonly rail: string;
  readonly service_id: string;
  readonly version_id: string;
  readonly task_class: string;
  readonly objective_id: string;
  readonly envelope_ref: string;
  readonly step_index: number;
  readonly payment_ref_hash: string;
}

function assertExistingIdentity(
  old: ExistingIdentity,
  input: ObservationInsert,
  key: string,
  refHash: string,
  id: string,
): void {
  if (
    old.dedup_key !== key ||
    old.payment_id !== input.paymentId ||
    old.user_id !== input.userId ||
    old.vault !== input.vault.toLowerCase() ||
    old.network !== input.network ||
    old.rail !== input.rail ||
    old.service_id !== input.serviceId ||
    old.version_id !== input.versionId ||
    old.task_class !== input.taskClass ||
    old.objective_id !== input.objectiveId ||
    old.envelope_ref !== input.envelopeRef.toLowerCase() ||
    old.step_index !== input.stepIndex ||
    old.payment_ref_hash !== refHash
  )
    throw new Error(`Observation identity collision for ${id}.`);
}

/** Persist the authorization identity before any merchant request can spend it. */
export async function insertAtSign(pool: Pool, input: ObservationInsert): Promise<string> {
  if (!validateSchema("payment-ref", input.paymentRef))
    throw new TypeError("Observation has an invalid canonical PaymentRef.");
  if (input.paymentRef.rail !== input.rail || input.paymentRef.network !== input.network)
    throw new TypeError("Observation rail or network does not match its PaymentRef.");
  const key = dedupKey(input.paymentRef);
  const id = obsId(key);
  const refHash = paymentRefHash(input.paymentRef);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1),$2)", [
      input.envelopeRef.toLowerCase(),
      input.stepIndex,
    ]);
    const prior = await client.query<ExistingIdentity>(
      `SELECT dedup_key,payment_id,user_id,vault,network,rail,service_id,version_id,
         task_class,objective_id,envelope_ref,step_index,payment_ref_hash
       FROM observations WHERE obs_id=$1`,
      [id],
    );
    if (prior.rows[0]) {
      assertExistingIdentity(prior.rows[0], input, key, refHash, id);
      await client.query("COMMIT");
      return id;
    }
    const ordinal = await client.query<{ next_index: number }>(
      `SELECT COALESCE(MAX(call_index),-1)+1 AS next_index FROM observations
       WHERE envelope_ref=$1 AND step_index=$2`,
      [input.envelopeRef.toLowerCase(), input.stepIndex],
    );
    const callIndex = ordinal.rows[0]?.next_index;
    if (callIndex === undefined || callIndex > 4095)
      throw new RangeError("Observation call ordinal exceeds 4095 for this envelope step.");
    const inserted = await client.query(
      `INSERT INTO observations
      (obs_id,user_id,vault,network,rail,service_id,version_id,task_class,objective_id,
       envelope_ref,step_index,call_index,payment_ref_hash,payment_id,dedup_key,job_state,controlled)
     SELECT $1,u.user_id,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,u.controlled
     FROM users u WHERE u.user_id=$16
     ON CONFLICT (obs_id) DO UPDATE
       SET job_state=COALESCE(observations.job_state,EXCLUDED.job_state)
     WHERE observations.job_state IS NULL AND EXCLUDED.job_state IS NOT NULL
     RETURNING obs_id`,
      [
        id,
        input.vault.toLowerCase(),
        input.network,
        input.rail,
        input.serviceId,
        input.versionId,
        input.taskClass,
        input.objectiveId,
        input.envelopeRef.toLowerCase(),
        input.stepIndex,
        callIndex,
        refHash,
        input.paymentId,
        key,
        input.rail === "erc8183-job" ? "Opened" : null,
        input.userId,
      ],
    );
    if (inserted.rowCount !== 1)
      throw new Error(`Observation insert failed for ${id}: user is missing.`);
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Fill only response facts that have not already been recorded. */
export async function fillResponse(
  pool: Pool,
  id: string,
  respondedAt: Date | undefined,
  delivered: 0 | 1 | undefined,
): Promise<void> {
  await pool.query(
    `${EXISTING_ROW}
       SET responded_at=COALESCE(observations.responded_at,$2),
           delivered=COALESCE(observations.delivered,$3)
     WHERE (observations.responded_at IS NULL AND $2::timestamptz IS NOT NULL)
        OR (observations.delivered IS NULL AND $3::smallint IS NOT NULL)`,
    [id, respondedAt ?? null, delivered ?? null],
  );
  await requireObservation(pool, id);
  await evaluateResponseHealth(pool, id);
}

/** Settle only after the caller has observed the vault or Gateway settlement fact. */
export async function markSettled(
  pool: Pool,
  id: string,
  at: Date,
  transaction?: string,
): Promise<void> {
  await pool.query(
    `${EXISTING_ROW}
       SET settled_at=COALESCE(observations.settled_at,$2),
           settlement_tx=COALESCE(observations.settlement_tx,$3)
     WHERE observations.released_at IS NULL
       AND ((observations.settled_at IS NULL AND $2::timestamptz IS NOT NULL)
         OR (observations.settlement_tx IS NULL AND $3::text IS NOT NULL))`,
    [id, at, transaction ?? null],
  );
  const row = await requireObservation(pool, id);
  if (row.releasedAt) throw new Error(`Cannot settle released observation ${id}.`);
  await evaluateResponseHealth(pool, id);
}

/** Release only an authorization proven unused or a failed Gateway row. */
export async function markReleased(
  pool: Pool,
  id: string,
  at: Date,
  consecutiveFailures = 3,
): Promise<void> {
  await pool.query(
    `${EXISTING_ROW}
       SET released_at=COALESCE(observations.released_at,$2)
     WHERE observations.settled_at IS NULL AND observations.released_at IS NULL`,
    [id, at],
  );
  const row = await requireObservation(pool, id);
  if (row.settledAt) throw new Error(`Cannot release settled observation ${id}.`);
  if (row.rail !== "erc8183-job") {
    const recent = await pool.query<{ obs_id: string }>(
      `SELECT obs_id FROM observations
       WHERE user_id=$1 AND network=$2 AND service_id=$3 AND rail<>'erc8183-job'
       ORDER BY created_at DESC,call_index DESC LIMIT $4`,
      [row.userId, row.network, row.serviceId, consecutiveFailures],
    );
    const observations = await Promise.all(
      recent.rows.map((item) => requireObservation(pool, item.obs_id)),
    );
    const evidence = await Promise.all(
      observations.map((item) => expiredAuthorizationEvidence(pool, item)),
    );
    await writeFacts(pool, healthFacts(observations, evidence.flat(), { consecutiveFailures }));
  }
}

async function evaluateResponseHealth(pool: Pool, id: string): Promise<void> {
  const row = await requireObservation(pool, id);
  if (!row.settledAt) return;
  if (row.rail !== "erc8183-job") {
    const evidence = await expiredAuthorizationEvidence(pool, row);
    await writeFacts(pool, healthFacts([row], evidence, { consecutiveFailures: 3 }));
  }
  if (row.delivered === 1) await clearFacts(pool, id);
}

async function expiredAuthorizationEvidence(
  pool: Pool,
  row: ObservationRow,
): Promise<readonly HealthEvidence[]> {
  if (row.rail !== "x402-exact") return [];
  const result = await pool.query(
    `SELECT 1 FROM plans p
     JOIN step_executions auth ON auth.plan_id=p.plan_id
     JOIN step_executions unpaid ON unpaid.plan_id=auth.plan_id
       AND unpaid.step_index=auth.step_index AND unpaid.attempt=auth.attempt
       AND unpaid.phase='call.unpaid'
       AND unpaid.payload->>'index'=auth.payload->>'index'
     WHERE p.objective_id=$1 AND auth.step_index=$2 AND auth.phase='auth.signed'
       AND auth.payload->>'paymentId'=$3
       AND unpaid.payload->>'errorCode'='authorization-expired'
     LIMIT 1`,
    [row.objectiveId, row.stepIndex, row.paymentId],
  );
  return result.rowCount === 1 ? [{ kind: "resume-past-valid-before", obsId: row.obsId }] : [];
}

/** Advance the stored escrow state without rolling back a terminal or newer fact. */
export async function setJobState(
  pool: Pool,
  id: string,
  state: JobState,
  at?: Date,
): Promise<void> {
  const current = await requireObservation(pool, id);
  if (current.rail !== "erc8183-job") throw new TypeError(`Observation ${id} is not a job.`);
  if (!mayAdvance(current.jobState, state)) {
    if (current.jobState === "Completed") await evaluateResponseHealth(pool, id);
    return;
  }
  const responded = ["Completed", "Refunded", "Expired"].includes(state) ? at : undefined;
  await pool.query(
    `${EXISTING_ROW}
       SET job_state=$2,
           responded_at=COALESCE(observations.responded_at,$3),
           delivered=COALESCE(observations.delivered,
             CASE WHEN $2='Completed' THEN 1
                  ELSE NULL END)
     WHERE observations.rail='erc8183-job'
       AND (observations.job_state IS NULL
         OR observations.job_state='Opened' AND $2 IN ('Funded','Submitted','Completed','Refunded','Released','Expired')
         OR observations.job_state='Funded' AND $2 IN ('Submitted','Completed','Refunded','Released','Expired')
         OR observations.job_state='Submitted' AND $2 IN ('Completed','Refunded','Released','Expired'))`,
    [id, state, responded ?? null],
  );
  if (state === "Completed") await evaluateResponseHealth(pool, id);
}

function mayAdvance(current: JobState | null, next: JobState): boolean {
  if (current === null) return true;
  if (current === "Opened") return next !== "Opened";
  if (current === "Funded") return next !== "Opened" && next !== "Funded";
  if (current === "Submitted") return !["Opened", "Funded", "Submitted"].includes(next);
  return false;
}

export async function getObservation(pool: Pool, id: string): Promise<ObservationRow | null> {
  const result = await pool.query<ObservationRow>(
    `SELECT obs_id AS "obsId",user_id AS "userId",vault,network,rail,
       service_id AS "serviceId",version_id AS "versionId",task_class AS "taskClass",
       objective_id AS "objectiveId",envelope_ref AS "envelopeRef",
       step_index AS "stepIndex",call_index AS "callIndex",
       payment_ref_hash AS "paymentRefHash",payment_id AS "paymentId",dedup_key AS "dedupKey",
       delivered,job_state AS "jobState",controlled,settlement_tx AS "settlementTx",
       responded_at AS "respondedAt",settled_at AS "settledAt",released_at AS "releasedAt"
     FROM observations WHERE obs_id=$1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function listEligibleObservations(
  pool: Pool,
  objectiveId: string,
  stepIndex: number,
): Promise<readonly ObservationRow[]> {
  const result = await pool.query<{ obs_id: string }>(
    `SELECT obs_id FROM observations
     WHERE objective_id=$1 AND step_index=$2 AND settled_at IS NOT NULL AND released_at IS NULL
       AND (rail<>'erc8183-job' OR job_state='Completed') ORDER BY call_index`,
    [objectiveId, stepIndex],
  );
  return (await Promise.all(result.rows.map((row) => getObservation(pool, row.obs_id)))).filter(
    (row): row is ObservationRow => row !== null,
  );
}

async function requireObservation(pool: Pool, id: string): Promise<ObservationRow> {
  const row = await getObservation(pool, id);
  if (!row) throw new Error(`Observation ${id} is missing; insert at signing first.`);
  return row;
}
