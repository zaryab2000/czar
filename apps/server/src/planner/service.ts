import { randomBytes } from "node:crypto";
import type { ObjectiveSubmission, Plan } from "@czar/schemas";
import type { Pool, PoolClient } from "pg";
import { canTransition } from "#src/objectives/state";
import type { PlannerBuild, PlannerRequest } from "#src/planner/index";
import type { RandomSource } from "#src/http/ids";

const ERROR_CODES = new Set([
  "delivery-failed", "structural-failed", "unpaid", "price-or-payee-drift",
  "pocket-funding-failed", "job-fees-changed", "job-budget-too-high",
]);
const STEP_FLAGS = new Set(["injection-suspect", "schema-mismatch", "truncated", "pii-suspect"]);

export interface PlannerOperationsDependencies {
  readonly pool: Pool;
  readonly planner: { build(input: PlannerRequest): Promise<PlannerBuild | null> };
  readonly ethGasPriceWei: () => Promise<bigint>;
  readonly gatewayVolumeAtomic: (objectiveId: string) => Promise<bigint>;
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
    processNextReceived: () => processNextReceived(deps),
  };
}

async function planObjective(
  objectiveId: string,
  deps: PlannerOperationsDependencies,
  now: () => Date,
  random: RandomSource,
): Promise<Plan | null> {
  const row = await loadAndTransition(deps.pool, objectiveId, "received", "planning");
  const result = await build(row, deps, now, random);
  if (!result) {
    await transitionObjective(deps.pool, objectiveId, "planning", "no-supplier");
    return null;
  }
  await savePlan(deps.pool, row, result, "planning");
  return result.plan;
}

async function shadowQuote(
  objectiveId: string,
  deps: PlannerOperationsDependencies,
  now: () => Date,
  random: RandomSource,
): Promise<Plan | null> {
  const row = await loadObjective(deps.pool, objectiveId);
  const result = await build(row, deps, now, random, true);
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
    if (!canTransition(row.state, "replanning")) throw new Error(`Invalid objective transition: ${row.state} -> replanning`);
    const old = await client.query<{ plan: Plan }>("SELECT plan FROM plans WHERE plan_id=$1 FOR UPDATE", [
      (await client.query<{ plan_id: string }>("SELECT plan_id FROM objectives WHERE objective_id=$1", [objectiveId])).rows[0]?.plan_id,
    ]);
    if (!old.rows[0]) throw new Error("Cannot re-plan without the current plan.");
    previous = old.rows[0].plan;
    await client.query("UPDATE objectives SET state='replanning',updated_at=now() WHERE objective_id=$1", [objectiveId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const excluded = new Set(failures.map((failure) => previous.steps.find((step) =>
    step.stepIndex === failure.stepIndex)?.serviceId).filter((service): service is string => Boolean(service)));
  const result = await build(row, deps, now, random, false, excluded);
  if (!result) {
    await transitionObjective(deps.pool, objectiveId, "replanning", "executing");
    return null;
  }
  await persistPlan(deps.pool, row, result, "replanning", previous.planId);
  return result.plan;
}

async function processNextReceived(deps: PlannerOperationsDependencies): Promise<boolean> {
  const client = await deps.pool.connect();
  let objectiveId: string | undefined;
  try {
    await client.query("BEGIN");
    const result = await client.query<{ event_id: string; objective_id: string }>(
      `SELECT event_id,objective_id FROM outbox_events
       WHERE name='objective.received' AND delivered_at IS NULL
       ORDER BY event_id FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    const event = result.rows[0];
    if (!event) {
      await client.query("COMMIT");
      return false;
    }
    objectiveId = event.objective_id;
    await client.query("UPDATE outbox_events SET delivered_at=now() WHERE event_id=$1", [event.event_id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  try {
    await planObjective(objectiveId, deps, deps.now ?? (() => new Date()), deps.random ?? { bytes: randomBytes });
  } catch (error) {
    await deps.pool.query(
      "UPDATE outbox_events SET delivered_at=NULL WHERE name='objective.received' AND objective_id=$1",
      [objectiveId],
    );
    throw error;
  }
  return true;
}

async function build(
  row: ObjectiveRow,
  deps: PlannerOperationsDependencies,
  now: () => Date,
  random: RandomSource,
  shadow = false,
  excludedServices?: ReadonlySet<string>,
): Promise<PlannerBuild | null> {
  const [ethGasPriceWei, gatewayVolumeAtomic] = await Promise.all([
    deps.ethGasPriceWei(), deps.gatewayVolumeAtomic(row.objective_id),
  ]);
  return deps.planner.build({
    objectiveId: row.objective_id,
    objectiveHash: row.objective_hash,
    userId: row.user_id,
    deviceId: row.device_id,
    goal: row.submission.goal,
    capabilities: row.submission.capabilities,
    taskSpec: row.submission.taskSpec,
    ...(row.submission.constraints?.maxTotal ? { constraints: { maxTotal: row.submission.constraints.maxTotal } } : {}),
    now: now(), random, ethGasPriceWei, gatewayVolumeAtomic,
    ...(shadow ? { shadow: true } : {}),
    ...(excludedServices ? { excludedServices } : {}),
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
    if (row.state !== from || !canTransition(from, to)) throw new Error(`Invalid objective state for planning: ${row.state}`);
    await client.query("UPDATE objectives SET state=$2,updated_at=now() WHERE objective_id=$1", [objectiveId, to]);
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

async function transitionObjective(pool: Pool, objectiveId: string, from: string, to: string): Promise<void> {
  if (!canTransition(from, to)) throw new Error(`Invalid objective transition: ${from} -> ${to}`);
  const result = await pool.query(
    "UPDATE objectives SET state=$3,updated_at=now() WHERE objective_id=$1 AND state=$2",
    [objectiveId, from, to],
  );
  if (result.rowCount !== 1) throw new Error(`Objective state changed while transitioning ${from} -> ${to}.`);
}

async function savePlan(
  pool: Pool,
  row: ObjectiveRow,
  result: PlannerBuild,
  from: "planning",
): Promise<void> {
  await persistPlan(pool, row, result, from);
}

async function persistPlan(
  pool: Pool,
  row: ObjectiveRow,
  result: PlannerBuild,
  from: "planning" | "replanning",
  supersedes?: string,
): Promise<void> {
  const to = result.approvalNeeded ? "awaiting-approval" : from === "planning" ? "opening" : "executing";
  if (!canTransition(from, to)) throw new Error(`Invalid objective transition: ${from} -> ${to}`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (supersedes) await client.query("UPDATE plans SET state='superseded',updated_at=now() WHERE plan_id=$1", [supersedes]);
    await client.query(
      `INSERT INTO plans (plan_id,objective_id,plan,plan_hash,payee_root,state,created_at,updated_at)
       VALUES ($1,$2,$3::jsonb,$4,$5,'offered',now(),now())`,
      [result.plan.planId, row.objective_id, JSON.stringify(result.plan), result.plan.planHash, result.plan.payeeRoot],
    );
    for (const step of result.plan.steps) {
      await client.query(
        "INSERT INTO steps (plan_id,step_index,step,state,pocket) VALUES ($1,$2,$3::jsonb,'offered',$4)",
        [result.plan.planId, step.stepIndex, JSON.stringify(step), result.plan.pocket ?? null],
      );
    }
    const updated = await client.query(
      "UPDATE objectives SET state=$3,plan_id=$4,updated_at=now() WHERE objective_id=$1 AND state=$2",
      [row.objective_id, from, to, result.plan.planId],
    );
    if (updated.rowCount !== 1) throw new Error(`Objective state changed while saving plan: ${row.objective_id}`);
    await client.query(
      `INSERT INTO outbox_events (name,objective_id,payload) VALUES ('plan.ready',$1,$2::jsonb)`,
      [row.objective_id, JSON.stringify({
        objectiveId: row.objective_id, planId: result.plan.planId,
        planHash: result.plan.planHash, payeeRoot: result.plan.payeeRoot,
      })],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function validateFailures(failures: readonly ReplanFailure[]): void {
  for (const failure of failures) {
    const keys = Object.keys(failure).toSorted();
    if (keys.join(",") !== "errorCode,flags,stepIndex" ||
      !Number.isSafeInteger(failure.stepIndex) || failure.stepIndex < 0 ||
      !ERROR_CODES.has(failure.errorCode) || failure.flags.some((flag) => !STEP_FLAGS.has(flag))) {
      throw new TypeError("Invalid re-plan failure input; use only stepIndex, errorCode and flags.");
    }
  }
}
