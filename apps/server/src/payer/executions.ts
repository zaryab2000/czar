import type { Pool, PoolClient } from "pg";
import { validateSchema, type StepError, type StepResult } from "@czar/schemas";

export interface ExecutionPhase {
  readonly planId: string;
  readonly stepIndex: number;
  readonly attempt: number;
  readonly phase: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * SCR-159 §3: the per-call outcome of a reserved index that delivered no accepted result, written as one
 * `call.error` row per index in the same transaction as the step's terminal state.
 */
export interface CallError {
  readonly index: number;
  readonly code: "unpaid" | "delivery-failed" | "service-version-drift";
}

export interface ExecutorLeaseGuard {
  assertHeld(): void;
}

export interface ExecutionPhaseRow {
  readonly phase: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly at: Date;
}

export async function appendExecutionPhase(pool: Pool, entry: ExecutionPhase): Promise<void> {
  if (!Number.isInteger(entry.stepIndex) || entry.stepIndex < 0)
    throw new RangeError("Execution stepIndex must be a non-negative integer.");
  if (!Number.isInteger(entry.attempt) || entry.attempt < 0)
    throw new RangeError("Execution attempt must be a non-negative integer.");
  await pool.query(
    `INSERT INTO step_executions (plan_id,step_index,attempt,phase,payload)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [entry.planId, entry.stepIndex, entry.attempt, entry.phase, JSON.stringify(entry.payload)],
  );
}

export async function getExecutionTrace(
  pool: Pool,
  planId: string,
  stepIndex: number,
  attempt: number,
): Promise<ExecutionPhaseRow[]> {
  const result = await pool.query<ExecutionPhaseRow>(
    `SELECT phase,payload,at FROM step_executions
     WHERE plan_id=$1 AND step_index=$2 AND attempt=$3 ORDER BY execution_id`,
    [planId, stepIndex, attempt],
  );
  return result.rows;
}

export async function acquireExecutorLease(
  pool: Pool,
  envelopeRef: string,
  workerId: string,
  ttlSeconds: number,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  validateLeaseInput(ttlSeconds);
  const current = now();
  const result = await pool.query(
    `INSERT INTO executor_leases (envelope_ref,worker_id,expires_at,updated_at)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (envelope_ref) DO UPDATE
       SET worker_id=EXCLUDED.worker_id,expires_at=EXCLUDED.expires_at,updated_at=EXCLUDED.updated_at
       WHERE executor_leases.expires_at <= $4 OR executor_leases.worker_id = $2
     RETURNING envelope_ref`,
    [envelopeRef, workerId, addSeconds(current, ttlSeconds), current],
  );
  return result.rowCount === 1;
}

export async function renewExecutorLease(
  pool: Pool,
  envelopeRef: string,
  workerId: string,
  ttlSeconds: number,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  validateLeaseInput(ttlSeconds);
  const current = now();
  const result = await pool.query(
    `UPDATE executor_leases SET expires_at=$3,updated_at=$4
     WHERE envelope_ref=$1 AND worker_id=$2 AND expires_at>$4`,
    [envelopeRef, workerId, addSeconds(current, ttlSeconds), current],
  );
  return result.rowCount === 1;
}

export function startExecutorLeaseRenewal(
  pool: Pool,
  envelopeRef: string,
  workerId: string,
  ttlSeconds: number,
  now: () => Date = () => new Date(),
): { assertHeld(): void; stop(): Promise<void> } {
  let lost = false;
  let renewal: Promise<void> | undefined;
  const timer = setInterval(
    () => {
      if (renewal) return;
      renewal = renewExecutorLease(pool, envelopeRef, workerId, ttlSeconds, now)
        .then((renewed) => {
          if (!renewed) lost = true;
        })
        .catch(() => {
          lost = true;
        })
        .finally(() => {
          renewal = undefined;
        });
    },
    (ttlSeconds * 1000) / 3,
  );
  timer.unref();
  return {
    assertHeld() {
      if (lost)
        throw new Error("Payer executor lease was lost; stop before the next external call.");
    },
    async stop() {
      clearInterval(timer);
      await renewal;
    },
  };
}

export async function releaseExecutorLease(
  pool: Pool,
  envelopeRef: string,
  workerId: string,
): Promise<void> {
  await pool.query("DELETE FROM executor_leases WHERE envelope_ref=$1 AND worker_id=$2", [
    envelopeRef,
    workerId,
  ]);
}

export async function markStepDoneWithResults(
  pool: Pool,
  input: {
    readonly planId: string;
    readonly stepIndex: number;
    readonly attempt: number;
    readonly callsUsed: number;
    readonly results: readonly {
      readonly index: number;
      readonly subjectIndex?: number;
      readonly stepResult: StepResult;
    }[];
    readonly callErrors?: readonly CallError[];
  },
): Promise<void> {
  if (input.results.length === 0)
    throw new RangeError("Cannot complete a paid step without a StepResult.");
  for (const result of input.results) {
    if (!validateSchema("step-result", result.stepResult))
      throw new TypeError("Cannot complete a paid step with an invalid StepResult.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const result of input.results) {
      await client.query(
        `INSERT INTO step_executions (plan_id,step_index,attempt,phase,payload)
         VALUES ($1,$2,$3,'step.result',$4::jsonb)`,
        [
          input.planId,
          input.stepIndex,
          input.attempt,
          JSON.stringify({
            index: result.index,
            ...(result.subjectIndex === undefined ? {} : { subjectIndex: result.subjectIndex }),
            stepResult: result.stepResult,
          }),
        ],
      );
    }
    await insertCallErrors(client, input);
    const updated = await client.query(
      "UPDATE steps SET state='done',calls_used=GREATEST(calls_used,$3) WHERE plan_id=$1 AND step_index=$2",
      [input.planId, input.stepIndex, input.callsUsed],
    );
    if (updated.rowCount !== 1) throw new Error("Payer step is missing while marking it done.");
    await client.query(
      `INSERT INTO step_executions (plan_id,step_index,attempt,phase,payload)
       VALUES ($1,$2,$3,'step.done',$4::jsonb)`,
      [
        input.planId,
        input.stepIndex,
        input.attempt,
        JSON.stringify({ callsUsed: input.callsUsed }),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * SCR-163 §5: a resumed, partly paid step whose live version drifted signs nothing more. Its settled
 * calls and their stored results stand; the remaining indices are recorded per call.
 */
export async function markStepDoneKeepingResults(
  pool: Pool,
  input: {
    readonly planId: string;
    readonly stepIndex: number;
    readonly attempt: number;
    readonly callsUsed: number;
    readonly callErrors: readonly CallError[];
  },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await insertCallErrors(client, input);
    const updated = await client.query(
      "UPDATE steps SET state='done',calls_used=GREATEST(calls_used,$3) WHERE plan_id=$1 AND step_index=$2",
      [input.planId, input.stepIndex, input.callsUsed],
    );
    if (updated.rowCount !== 1) throw new Error("Payer step is missing while marking it done.");
    await client.query(
      `INSERT INTO step_executions (plan_id,step_index,attempt,phase,payload)
       VALUES ($1,$2,$3,'step.done',$4::jsonb)`,
      [
        input.planId,
        input.stepIndex,
        input.attempt,
        JSON.stringify({ callsUsed: input.callsUsed }),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markStepFailed(
  pool: Pool,
  input: {
    readonly planId: string;
    readonly stepIndex: number;
    readonly attempt: number;
    readonly errorCode: string;
    readonly stepError?: StepError;
    readonly callsUsed?: number;
    readonly callErrors?: readonly CallError[];
  },
): Promise<void> {
  if (input.stepError && !validateSchema("step-error", input.stepError))
    throw new TypeError("Cannot persist an invalid StepError.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE steps SET state='failed',calls_used=GREATEST(calls_used,$3)
       WHERE plan_id=$1 AND step_index=$2 AND state <> 'done'`,
      [input.planId, input.stepIndex, input.callsUsed ?? 0],
    );
    if (updated.rowCount !== 1) throw new Error("Payer step is missing or already done.");
    await insertCallErrors(client, input);
    await client.query(
      `INSERT INTO step_executions (plan_id,step_index,attempt,phase,payload)
       VALUES ($1,$2,$3,'step.failed',$4::jsonb)`,
      [
        input.planId,
        input.stepIndex,
        input.attempt,
        JSON.stringify({
          errorCode: input.errorCode,
          ...(input.stepError ? { stepError: input.stepError } : {}),
        }),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertCallErrors(
  client: PoolClient,
  input: {
    readonly planId: string;
    readonly stepIndex: number;
    readonly attempt: number;
    readonly callErrors?: readonly CallError[];
  },
): Promise<void> {
  for (const callError of input.callErrors ?? []) {
    await client.query(
      `INSERT INTO step_executions (plan_id,step_index,attempt,phase,payload)
       VALUES ($1,$2,$3,'call.error',$4::jsonb)`,
      [
        input.planId,
        input.stepIndex,
        input.attempt,
        JSON.stringify({ index: callError.index, code: callError.code }),
      ],
    );
  }
}

export async function markStepHandedOff(
  pool: Pool,
  planId: string,
  stepIndex: number,
): Promise<void> {
  const result = await pool.query(
    "UPDATE steps SET state='handed_off' WHERE plan_id=$1 AND step_index=$2 AND state <> 'done'",
    [planId, stepIndex],
  );
  if (result.rowCount !== 1) throw new Error("Unpaid step is missing or already finalized.");
}

export async function acknowledgeAssembly(
  pool: Pool,
  planId: string,
  stepIndex: number,
): Promise<boolean> {
  const result = await pool.query(
    "UPDATE steps SET state='done' WHERE plan_id=$1 AND step_index=$2 AND state='handed_off'",
    [planId, stepIndex],
  );
  return result.rowCount === 1;
}

function validateLeaseInput(ttlSeconds: number): void {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1)
    throw new RangeError("Executor lease TTL must be a positive integer number of seconds.");
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}
