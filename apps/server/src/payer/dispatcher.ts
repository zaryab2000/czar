import { randomUUID } from "node:crypto";
import type { Config } from "@czar/config";
import { validateSchema, type Plan, type Step } from "@czar/schemas";
import type { Pool } from "pg";
import {
  acquireExecutorLease,
  getExecutionTrace,
  releaseExecutorLease,
  startExecutorLeaseRenewal,
  type ExecutorLeaseGuard,
} from "#src/payer/executions";

export interface DispatchEnvelope {
  readonly objectiveId: string;
  readonly planId: string;
  readonly envelopeRef: string;
  readonly vault: `0x${string}`;
  readonly userId: string;
  readonly deviceId: string;
  readonly plan: Plan;
}

export interface DispatchStepRequest extends DispatchEnvelope {
  readonly step: Step;
  readonly workerId: string;
  readonly trace: Awaited<ReturnType<typeof getExecutionTrace>>;
  readonly dispatchLease: ExecutorLeaseGuard;
}

export type DispatchStepOutcome = "done" | "failed" | "handed_off" | "pending";

export interface DispatcherDependencies {
  readonly pool: Pool;
  readonly config: Config;
  readonly isFrozen: (vault: `0x${string}`) => Promise<boolean>;
  readonly hasPendingFrozenEvent: (vault: `0x${string}`) => Promise<boolean>;
  readonly isGuardianPaused: (vault: `0x${string}`) => Promise<boolean>;
  readonly runStep: (input: DispatchStepRequest) => Promise<DispatchStepOutcome>;
  readonly complete: (input: DispatchEnvelope) => Promise<void>;
  readonly now?: () => Date;
  readonly workerId?: () => string;
  readonly onError: (error: unknown) => void;
}

interface DispatchRow extends DispatchEnvelope {
  readonly steps: readonly { readonly step: Step; readonly state: string }[];
}

export async function dispatchExecutingObjectives(
  dependencies: DispatcherDependencies,
): Promise<void> {
  const candidates = await findDispatchCandidates(
    dependencies.pool,
    (dependencies.now ?? (() => new Date()))(),
  );
  for (const candidate of candidates) {
    try {
      await dispatchEnvelope(candidate, dependencies);
    } catch (error) {
      dependencies.onError(error);
    }
  }
}

export function startPayerDispatcher(dependencies: DispatcherDependencies): {
  stop(): Promise<void>;
} {
  const pollMs = Number(dependencies.config.get("payer.dispatchPollMs"));
  if (!Number.isSafeInteger(pollMs) || pollMs <= 0)
    throw new RangeError("payer.dispatchPollMs must be a positive integer.");
  let active: Promise<void> | undefined;
  const poll = () => {
    if (active) return;
    active = dispatchExecutingObjectives(dependencies)
      .catch(dependencies.onError)
      .finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(poll, pollMs);
  timer.unref();
  poll();
  return {
    async stop() {
      clearInterval(timer);
      await active;
    },
  };
}

async function findDispatchCandidates(pool: Pool, now: Date): Promise<DispatchRow[]> {
  const result = await pool.query<{
    objective_id: string;
    plan_id: string;
    envelope_ref: string;
    vault: string;
    user_id: string;
    device_id: string;
    plan: Plan;
  }>(
    `SELECT o.objective_id,p.plan_id,o.envelope_ref,u.vault,o.user_id,o.device_id,p.plan
     FROM objectives o JOIN plans p ON p.plan_id=o.plan_id
     JOIN users u ON u.user_id=o.user_id
     WHERE o.state='executing' AND o.envelope_ref IS NOT NULL AND p.state='approved'
       AND u.vault IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM executor_leases l
         WHERE l.envelope_ref=o.envelope_ref AND l.expires_at>$1)
     ORDER BY o.updated_at,o.objective_id`,
    [now],
  );
  const rows: DispatchRow[] = [];
  for (const row of result.rows) {
    const steps = await pool.query<{ step: Step; state: string }>(
      "SELECT step,state FROM steps WHERE plan_id=$1 ORDER BY step_index",
      [row.plan_id],
    );
    rows.push({
      objectiveId: row.objective_id,
      planId: row.plan_id,
      envelopeRef: row.envelope_ref,
      vault: row.vault as `0x${string}`,
      userId: row.user_id,
      deviceId: row.device_id,
      plan: row.plan,
      steps: steps.rows,
    });
  }
  return rows;
}

async function dispatchEnvelope(
  envelope: DispatchRow,
  dependencies: DispatcherDependencies,
): Promise<void> {
  const workerId = dependencies.workerId?.() ?? `dispatch-${process.pid}-${randomUUID()}`;
  const leaseSeconds = Number(dependencies.config.get("payer.leaseSeconds"));
  const acquired = await acquireExecutorLease(
    dependencies.pool,
    envelope.envelopeRef,
    workerId,
    leaseSeconds,
    dependencies.now ?? (() => new Date()),
  );
  if (!acquired) return;
  const renewal = startExecutorLeaseRenewal(
    dependencies.pool,
    envelope.envelopeRef,
    workerId,
    leaseSeconds,
    dependencies.now ?? (() => new Date()),
  );
  try {
    await runSteps(envelope, dependencies, workerId, renewal);
  } finally {
    await renewal.stop();
    await releaseExecutorLease(dependencies.pool, envelope.envelopeRef, workerId);
  }
}

async function runSteps(
  envelope: DispatchRow,
  dependencies: DispatcherDependencies,
  workerId: string,
  dispatchLease: ExecutorLeaseGuard,
): Promise<void> {
  const byIndex = new Map(envelope.steps.map((entry) => [entry.step.stepIndex, entry]));
  const states = new Map(envelope.steps.map((entry) => [entry.step.stepIndex, entry.state]));
  for (const step of dependencyOrder(envelope.plan.steps)) {
    const entry = byIndex.get(step.stepIndex);
    if (!entry) throw new Error(`Plan step ${step.stepIndex} is missing from storage.`);
    const currentState = states.get(step.stepIndex);
    if (currentState === "done" || currentState === "failed") continue;
    if (currentState === "handed_off") return;
    if (
      step.dependsOn?.some((index) => {
        const state = states.get(index);
        return state !== "done" && state !== "failed";
      })
    )
      return;
    dispatchLease.assertHeld();
    if (await dependencies.hasPendingFrozenEvent(envelope.vault)) return;
    if (await dependencies.isFrozen(envelope.vault)) return;
    if (await dependencies.isGuardianPaused(envelope.vault)) return;
    const trace = await getExecutionTrace(dependencies.pool, envelope.planId, step.stepIndex, 0);
    const outcome = await dependencies.runStep({
      ...envelope,
      step,
      workerId,
      trace,
      dispatchLease,
    });
    if (outcome === "pending") return;
    if (isPaidStep(step) && outcome === "done") {
      if (!(await paidStepIsAtomicallyComplete(dependencies.pool, envelope.planId, step))) return;
      states.set(step.stepIndex, "done");
      continue;
    }
    await dependencies.pool.query("UPDATE steps SET state=$3 WHERE plan_id=$1 AND step_index=$2", [
      envelope.planId,
      step.stepIndex,
      outcome,
    ]);
    states.set(step.stepIndex, outcome);
    if (outcome === "handed_off") return;
  }
  if ([...states.values()].every((state) => state === "done" || state === "failed"))
    await dependencies.complete(envelope);
}

async function paidStepIsAtomicallyComplete(
  pool: Pool,
  planId: string,
  step: Step,
): Promise<boolean> {
  const state = await pool.query<{ state: string }>(
    "SELECT state FROM steps WHERE plan_id=$1 AND step_index=$2",
    [planId, step.stepIndex],
  );
  if (state.rows[0]?.state !== "done") return false;
  const phases = await pool.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM step_executions
     WHERE plan_id=$1 AND step_index=$2 AND phase='step.result'`,
    [planId, step.stepIndex],
  );
  return (
    phases.rows.length > 0 &&
    phases.rows.every((row) => validateSchema("step-result", row.payload["stepResult"]))
  );
}

function isPaidStep(step: Step): boolean {
  return ["x402-exact", "gateway-nano", "erc8183-job"].includes(step.kind);
}

function dependencyOrder(steps: readonly Step[]): Step[] {
  const byIndex = new Map(steps.map((step) => [step.stepIndex, step]));
  const ordered: Step[] = [];
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visit = (step: Step) => {
    if (visited.has(step.stepIndex)) return;
    if (visiting.has(step.stepIndex)) throw new Error("Plan step dependencies contain a cycle.");
    visiting.add(step.stepIndex);
    for (const index of step.dependsOn ?? []) {
      const dependency = byIndex.get(index);
      if (!dependency)
        throw new Error(`Plan step ${step.stepIndex} has missing dependency ${index}.`);
      visit(dependency);
    }
    visiting.delete(step.stepIndex);
    visited.add(step.stepIndex);
    ordered.push(step);
  };
  for (const step of steps) visit(step);
  return ordered;
}
