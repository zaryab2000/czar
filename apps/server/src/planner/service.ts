import { randomBytes } from "node:crypto";
import type { ObjectiveSubmission, Plan, SubjectsRevision } from "@czar/schemas";
import { validateSchema, validationErrors } from "@czar/schemas";
import type { Pool, PoolClient } from "pg";
import { canTransition } from "#src/objectives/state";
import type { PlannerBuild, PlannerRequest } from "#src/planner/index";
import type { RandomSource } from "#src/http/ids";

const ERROR_CODES = new Set([
  "delivery-failed",
  "structural-failed",
  "unpaid",
  "price-or-payee-drift",
  "pocket-funding-failed",
  "job-fees-changed",
  "job-budget-too-high",
]);
const STEP_FLAGS = new Set(["injection-suspect", "schema-mismatch", "truncated", "pii-suspect"]);

export interface PlannerOperationsDependencies {
  readonly pool: Pool;
  readonly planner: { build(input: PlannerRequest): Promise<PlannerBuild | null> };
  readonly ethGasPriceWei: () => Promise<bigint>;
  readonly now?: () => Date;
  readonly random?: RandomSource;
}

interface ObjectiveRow {
  readonly objective_id: string;
  readonly user_id: string;
  readonly device_id: string;
  readonly objective_hash: string;
  readonly submission: ObjectiveSubmission;
  readonly state: string;
}

interface PlanBuildOptions {
  readonly now: () => Date;
  readonly random: RandomSource;
  readonly shadow?: boolean;
  readonly excludedServices?: ReadonlySet<string>;
}

interface PersistOptions {
  readonly from: "planning" | "replanning";
  readonly supersedes?: string;
  readonly eventId?: string;
}

export interface ReplanFailure {
  readonly stepIndex: number;
  readonly errorCode: string;
  readonly flags: readonly string[];
}

export function createPlannerOperations(deps: PlannerOperationsDependencies) {
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? { bytes: randomBytes };

  return {
    planObjective: (objectiveId: string) => planObjective(objectiveId, deps, now, random),
    shadowQuote: (objectiveId: string) => shadowQuote(objectiveId, deps, now, random),
    replan: (objectiveId: string, failures: readonly ReplanFailure[]) =>
      replan(objectiveId, failures, deps, now, random),
    reviseSubjects: (userId: string, planId: string, revision: SubjectsRevision) =>
      reviseSubjects(userId, planId, revision, deps, now, random),
    processNextReceived: () => processNextReceived(deps),
  };
}

export async function reclaimStalePlanningClaims(
  pool: Pool,
  claimTimeoutSeconds: number,
  now: Date,
): Promise<number> {
  if (!Number.isSafeInteger(claimTimeoutSeconds) || claimTimeoutSeconds <= 0)
    throw new RangeError("planner.claimTimeoutSeconds must be a positive integer.");
  if (!canTransition("planning", "received"))
    throw new Error("Invalid objective transition: planning -> received");
  const cutoff = new Date(now.getTime() - claimTimeoutSeconds * 1000);
  const result = await pool.query(
    `UPDATE objectives AS o SET state='received',updated_at=$2
     WHERE o.state='planning' AND o.updated_at <= $1
       AND NOT EXISTS (SELECT 1 FROM plans p WHERE p.objective_id=o.objective_id)
       AND EXISTS (
         SELECT 1 FROM outbox_events e WHERE e.objective_id=o.objective_id
           AND e.name='objective.received' AND e.delivered_at IS NULL
       )`,
    [cutoff, now],
  );
  return result.rowCount ?? 0;
}

async function reviseSubjects(
  userId: string,
  planId: string,
  revision: SubjectsRevision,
  deps: PlannerOperationsDependencies,
  now: () => Date,
  random: RandomSource,
): Promise<Plan | null> {
  const selected = await deps.pool.query<{
    objective_id: string;
    objective_hash: string;
    submission: ObjectiveSubmission;
    state: string;
    plan_state: string;
  }>(
    `SELECT o.objective_id,o.objective_hash,o.submission,o.state,p.state AS plan_state
     FROM plans p JOIN objectives o ON o.objective_id=p.objective_id
     WHERE p.plan_id=$1 AND o.user_id=$2`,
    [planId, userId],
  );
  const row = selected.rows[0];
  if (!row) throw new Error("The plan was not found for this account.");
  if (row.state !== "awaiting-approval" || row.plan_state !== "offered") {
    throw new Error("The plan can no longer be revised.");
  }
  const taskSpec = {
    ...row.submission.taskSpec,
    subjects: revision.subjects.map((subject) => ({ ...subject })),
  };
  const submission = { ...row.submission, taskSpec };
  const objective: ObjectiveRow = {
    objective_id: row.objective_id,
    user_id: userId,
    device_id: submission.deviceId,
    objective_hash: row.objective_hash,
    submission,
    state: row.state,
  };
  const result = await build(objective, deps, { now, random });
  if (!result) return null;
  await persistSubjectRevision(deps.pool, objective, planId, result.plan);
  return result.plan;
}

async function persistSubjectRevision(
  pool: Pool,
  objective: ObjectiveRow,
  previousPlanId: string,
  plan: Plan,
): Promise<void> {
  if (!validateSchema("plan", plan)) {
    throw new Error(
      `Refusing to persist invalid revised plan: ${JSON.stringify(validationErrors("plan"))}`,
    );
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ plan_id: string }>(
      `SELECT plan_id FROM objectives WHERE objective_id=$1 AND user_id=$2
       AND state='awaiting-approval' AND plan_id=$3 FOR UPDATE`,
      [objective.objective_id, objective.user_id, previousPlanId],
    );
    if (current.rowCount !== 1)
      throw new Error("The plan changed while its subjects were revised.");
    const updated = await client.query(
      "UPDATE plans SET state='superseded',updated_at=now() WHERE plan_id=$1 AND state='offered'",
      [previousPlanId],
    );
    if (updated.rowCount !== 1) throw new Error("The plan is no longer available for revision.");
    await client.query(
      `INSERT INTO plans (plan_id,objective_id,plan,plan_hash,payee_root,state,created_at,updated_at)
       VALUES ($1,$2,$3::jsonb,$4,$5,'offered',now(),now())`,
      [plan.planId, objective.objective_id, JSON.stringify(plan), plan.planHash, plan.payeeRoot],
    );
    for (const step of plan.steps) {
      await client.query(
        "INSERT INTO steps (plan_id,step_index,step,state,pocket) VALUES ($1,$2,$3::jsonb,'offered',$4)",
        [plan.planId, step.stepIndex, JSON.stringify(step), plan.pocket ?? null],
      );
    }
    await client.query(
      `UPDATE objectives SET submission=$2::jsonb,plan_id=$3,updated_at=now()
       WHERE objective_id=$1 AND state='awaiting-approval' AND plan_id=$4`,
      [objective.objective_id, JSON.stringify(objective.submission), plan.planId, previousPlanId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function planObjective(
  objectiveId: string,
  deps: PlannerOperationsDependencies,
  now: () => Date,
  random: RandomSource,
): Promise<Plan | null> {
  const row = await loadAndTransition(deps.pool, objectiveId, "received", "planning");
  return completePlanning(row, deps, now, random);
}

async function completePlanning(
  row: ObjectiveRow,
  deps: PlannerOperationsDependencies,
  now: () => Date,
  random: RandomSource,
  eventId?: string,
): Promise<Plan | null> {
  const result = await build(row, deps, { now, random });
  if (!result) {
    await finishWithoutSupplier(deps.pool, row.objective_id, eventId);
    return null;
  }
  await savePlan(deps.pool, row, result, "planning", eventId);
  return result.plan;
}

async function shadowQuote(
  objectiveId: string,
  deps: PlannerOperationsDependencies,
  now: () => Date,
  random: RandomSource,
): Promise<Plan | null> {
  const row = await loadObjective(deps.pool, objectiveId);
  const result = await build(row, deps, { now, random, shadow: true });
  return result?.plan ?? null;
}

async function replan(
  objectiveId: string,
  failures: readonly ReplanFailure[],
  deps: PlannerOperationsDependencies,
  now: () => Date,
  random: RandomSource,
): Promise<Plan | null> {
  validateFailures(failures);
  const client = await deps.pool.connect();
  let row: ObjectiveRow;
  let previous: Plan;
  try {
    await client.query("BEGIN");
    row = await lockObjective(client, objectiveId);
    if (!canTransition(row.state, "replanning"))
      throw new Error(`Invalid objective transition: ${row.state} -> replanning`);
    const old = await client.query<{ plan: Plan }>(
      "SELECT plan FROM plans WHERE plan_id=$1 FOR UPDATE",
      [
        (
          await client.query<{ plan_id: string }>(
            "SELECT plan_id FROM objectives WHERE objective_id=$1",
            [objectiveId],
          )
        ).rows[0]?.plan_id,
      ],
    );
    if (!old.rows[0]) throw new Error("Cannot re-plan without the current plan.");
    previous = old.rows[0].plan;
    await client.query(
      "UPDATE objectives SET state='replanning',updated_at=now() WHERE objective_id=$1",
      [objectiveId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const excluded = new Set(
    failures
      .map(
        (failure) => previous.steps.find((step) => step.stepIndex === failure.stepIndex)?.serviceId,
      )
      .filter((service): service is string => Boolean(service)),
  );
  const result = await build(row, deps, { now, random, excludedServices: excluded });
  if (!result) {
    await transitionObjective(deps.pool, objectiveId, "replanning", "executing");
    return null;
  }
  await persistPlan(deps.pool, row, result, {
    from: "replanning",
    supersedes: previous.planId,
  });
  return result.plan;
}

async function processNextReceived(deps: PlannerOperationsDependencies): Promise<boolean> {
  const client = await deps.pool.connect();
  let event: { event_id: string; objective_id: string } | undefined;
  try {
    await client.query("BEGIN");
    const result = await client.query<{ event_id: string; objective_id: string }>(
      `SELECT e.event_id,e.objective_id FROM outbox_events e
       JOIN objectives o ON o.objective_id=e.objective_id AND o.state='received'
       WHERE e.name='objective.received' AND e.delivered_at IS NULL
       ORDER BY e.event_id FOR UPDATE OF e SKIP LOCKED LIMIT 1`,
    );
    event = result.rows[0];
    if (!event) {
      await client.query("COMMIT");
      return false;
    }
    if (!canTransition("received", "planning"))
      throw new Error("Invalid received -> planning transition.");
    const claimed = await client.query(
      "UPDATE objectives SET state='planning',updated_at=now() WHERE objective_id=$1 AND state='received'",
      [event.objective_id],
    );
    if (claimed.rowCount !== 1) throw new Error("Objective was claimed by another planner worker.");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const row = await loadObjective(deps.pool, event.objective_id);
  await completePlanning(
    row,
    deps,
    deps.now ?? (() => new Date()),
    deps.random ?? { bytes: randomBytes },
    event.event_id,
  );
  return true;
}

async function build(
  row: ObjectiveRow,
  deps: PlannerOperationsDependencies,
  options: PlanBuildOptions,
): Promise<PlannerBuild | null> {
  const ethGasPriceWei = await deps.ethGasPriceWei();
  return deps.planner.build({
    objectiveId: row.objective_id,
    objectiveHash: row.objective_hash,
    userId: row.user_id,
    deviceId: row.device_id,
    goal: row.submission.goal,
    capabilities: row.submission.capabilities,
    taskSpec: row.submission.taskSpec,
    ...(row.submission.constraints?.maxTotal
      ? { constraints: { maxTotal: row.submission.constraints.maxTotal } }
      : {}),
    now: options.now(),
    random: options.random,
    ethGasPriceWei,
    ...(options.shadow ? { shadow: true } : {}),
    ...(options.excludedServices ? { excludedServices: options.excludedServices } : {}),
  });
}

async function loadAndTransition(
  pool: Pool,
  objectiveId: string,
  from: "received",
  to: "planning",
): Promise<ObjectiveRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = await lockObjective(client, objectiveId);
    if (row.state !== from || !canTransition(from, to))
      throw new Error(`Invalid objective state for planning: ${row.state}`);
    await client.query("UPDATE objectives SET state=$2,updated_at=now() WHERE objective_id=$1", [
      objectiveId,
      to,
    ]);
    await client.query("COMMIT");
    return { ...row, state: to };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function loadObjective(pool: Pool, objectiveId: string): Promise<ObjectiveRow> {
  const result = await pool.query<ObjectiveRow>(
    "SELECT objective_id,user_id,device_id,objective_hash,submission,state FROM objectives WHERE objective_id=$1",
    [objectiveId],
  );
  if (!result.rows[0]) throw new Error(`Objective not found: ${objectiveId}`);
  return result.rows[0];
}

async function lockObjective(client: PoolClient, objectiveId: string): Promise<ObjectiveRow> {
  const result = await client.query<ObjectiveRow>(
    "SELECT objective_id,user_id,device_id,objective_hash,submission,state FROM objectives WHERE objective_id=$1 FOR UPDATE",
    [objectiveId],
  );
  if (!result.rows[0]) throw new Error(`Objective not found: ${objectiveId}`);
  return result.rows[0];
}

async function transitionObjective(
  pool: Pool,
  objectiveId: string,
  from: string,
  to: string,
): Promise<void> {
  if (!canTransition(from, to)) throw new Error(`Invalid objective transition: ${from} -> ${to}`);
  const result = await pool.query(
    "UPDATE objectives SET state=$3,updated_at=now() WHERE objective_id=$1 AND state=$2",
    [objectiveId, from, to],
  );
  if (result.rowCount !== 1)
    throw new Error(`Objective state changed while transitioning ${from} -> ${to}.`);
}

async function savePlan(
  pool: Pool,
  row: ObjectiveRow,
  result: PlannerBuild,
  from: "planning",
  eventId?: string,
): Promise<void> {
  await persistPlan(pool, row, result, { from, ...(eventId ? { eventId } : {}) });
}

async function persistPlan(
  pool: Pool,
  row: ObjectiveRow,
  result: PlannerBuild,
  options: PersistOptions,
): Promise<void> {
  if (!validateSchema("plan", result.plan)) {
    throw new Error(
      `Refusing to persist invalid plan: ${JSON.stringify(validationErrors("plan"))}`,
    );
  }
  const to =
    result.approvalNeeded || Boolean(result.plan.approvalReasons?.length)
      ? "awaiting-approval"
      : options.from === "planning"
        ? "opening"
        : "executing";
  if (!canTransition(options.from, to))
    throw new Error(`Invalid objective transition: ${options.from} -> ${to}`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (options.supersedes)
      await client.query("UPDATE plans SET state='superseded',updated_at=now() WHERE plan_id=$1", [
        options.supersedes,
      ]);
    await client.query(
      `INSERT INTO plans (plan_id,objective_id,plan,plan_hash,payee_root,state,created_at,updated_at)
       VALUES ($1,$2,$3::jsonb,$4,$5,'offered',now(),now())`,
      [
        result.plan.planId,
        row.objective_id,
        JSON.stringify(result.plan),
        result.plan.planHash,
        result.plan.payeeRoot,
      ],
    );
    for (const step of result.plan.steps) {
      await client.query(
        "INSERT INTO steps (plan_id,step_index,step,state,pocket) VALUES ($1,$2,$3::jsonb,'offered',$4)",
        [result.plan.planId, step.stepIndex, JSON.stringify(step), result.plan.pocket ?? null],
      );
    }
    const updated = await client.query(
      "UPDATE objectives SET state=$3,plan_id=$4,updated_at=now() WHERE objective_id=$1 AND state=$2",
      [row.objective_id, options.from, to, result.plan.planId],
    );
    if (updated.rowCount !== 1)
      throw new Error(`Objective state changed while saving plan: ${row.objective_id}`);
    await client.query(
      `INSERT INTO outbox_events (name,objective_id,payload) VALUES ('plan.ready',$1,$2::jsonb)`,
      [
        row.objective_id,
        JSON.stringify({
          objectiveId: row.objective_id,
          planId: result.plan.planId,
          planHash: result.plan.planHash,
          payeeRoot: result.plan.payeeRoot,
        }),
      ],
    );
    await markReceivedDelivered(client, row.objective_id, options.eventId);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function finishWithoutSupplier(
  pool: Pool,
  objectiveId: string,
  eventId?: string,
): Promise<void> {
  if (!canTransition("planning", "no-supplier"))
    throw new Error("Invalid objective transition: planning -> no-supplier");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      "UPDATE objectives SET state='no-supplier',updated_at=now() WHERE objective_id=$1 AND state='planning'",
      [objectiveId],
    );
    if (result.rowCount !== 1)
      throw new Error(`Objective state changed before no-supplier: ${objectiveId}`);
    await client.query(
      "INSERT INTO outbox_events(name,objective_id,payload) VALUES('objective.no-supplier',$1,'{}'::jsonb)",
      [objectiveId],
    );
    await markReceivedDelivered(client, objectiveId, eventId);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function markReceivedDelivered(
  client: PoolClient,
  objectiveId: string,
  eventId?: string,
): Promise<void> {
  if (eventId) {
    await client.query("UPDATE outbox_events SET delivered_at=now() WHERE event_id=$1", [eventId]);
    return;
  }
  await client.query(
    `UPDATE outbox_events SET delivered_at=now()
     WHERE name='objective.received' AND objective_id=$1 AND delivered_at IS NULL`,
    [objectiveId],
  );
}

function validateFailures(failures: readonly ReplanFailure[]): void {
  for (const failure of failures) {
    const keys = Object.keys(failure).toSorted();
    if (
      keys.join(",") !== "errorCode,flags,stepIndex" ||
      !Number.isSafeInteger(failure.stepIndex) ||
      failure.stepIndex < 0 ||
      !ERROR_CODES.has(failure.errorCode) ||
      failure.flags.some((flag) => !STEP_FLAGS.has(flag))
    ) {
      throw new TypeError(
        "Invalid re-plan failure input; use only stepIndex, errorCode and flags.",
      );
    }
  }
}
