import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  acknowledgeAssembly,
  appendExecutionPhase,
  acquireExecutorLease,
  getExecutionTrace,
  markStepFailed,
  markStepHandedOff,
  releaseExecutorLease,
  startExecutorLeaseRenewal,
} from "#src/payer/executions";
import { setupDatabase } from "#test/db";
import { makeObjectiveSubmission, seedDevice, TEST_USER_ID } from "#test/fixtures";

const getPool = setupDatabase();
const OBJECTIVE = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const PLAN = "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const HASH = `0x${"01".repeat(32)}`;

describe("payer execution journal and leases", () => {
  beforeAll(async () => seedDevice(getPool()));

  beforeEach(async () => {
    await getPool().query("DELETE FROM executor_leases");
    await getPool().query("DELETE FROM step_executions");
    await getPool().query("DELETE FROM outbox_events");
    await getPool().query("DELETE FROM steps");
    await getPool().query("DELETE FROM plans");
    await getPool().query("DELETE FROM objectives");
    const submission = makeObjectiveSubmission(OBJECTIVE);
    await getPool().query(
      `INSERT INTO objectives (objective_id,user_id,device_id,submission,objective_hash,state)
       VALUES ($1,$2,$3,$4::jsonb,$5,'received')`,
      [
        OBJECTIVE,
        TEST_USER_ID,
        submission.deviceId,
        JSON.stringify(submission),
        submission.objectiveHash,
      ],
    );
    await getPool().query(
      `INSERT INTO plans (plan_id,objective_id,plan,plan_hash,payee_root,state)
       VALUES ($1,$2,'{}',$3,$4,'offered')`,
      [PLAN, OBJECTIVE, HASH, HASH],
    );
    await getPool().query(
      "INSERT INTO steps (plan_id,step_index,step,state) VALUES ($1,0,'{}','queued')",
      [PLAN],
    );
  });

  it("persists phases before and after external work in order", async () => {
    await appendExecutionPhase(getPool(), {
      planId: PLAN,
      stepIndex: 0,
      attempt: 0,
      phase: "reserve.sent",
      payload: { txHash: `0x${"03".repeat(32)}` },
    });
    await appendExecutionPhase(getPool(), {
      planId: PLAN,
      stepIndex: 0,
      attempt: 0,
      phase: "reserve.mined",
      payload: { reservationId: "7", validBefore: 1_800_000_000 },
    });

    const rows = await getPool().query<{ phase: string }>(
      "SELECT phase FROM step_executions WHERE plan_id = $1 ORDER BY execution_id",
      [PLAN],
    );
    expect(rows.rows.map((row) => row.phase)).toEqual(["reserve.sent", "reserve.mined"]);
    expect(await getExecutionTrace(getPool(), PLAN, 0, 0)).toMatchObject([
      { phase: "reserve.sent", payload: { txHash: `0x${"03".repeat(32)}` } },
      { phase: "reserve.mined", payload: { reservationId: "7" } },
    ]);
  });

  it("leases one executor per envelope and permits takeover after expiry", async () => {
    const now = { value: new Date("2026-10-21T00:00:00Z") };
    const first = await acquireExecutorLease(
      getPool(),
      "env_test",
      "worker-a",
      60,
      () => now.value,
    );
    const competing = await acquireExecutorLease(
      getPool(),
      "env_test",
      "worker-b",
      60,
      () => now.value,
    );
    expect(first).toBe(true);
    expect(competing).toBe(false);

    now.value = new Date(now.value.getTime() + 61_000);
    const takeover = await acquireExecutorLease(
      getPool(),
      "env_test",
      "worker-b",
      60,
      () => now.value,
    );
    expect(takeover).toBe(true);
    await releaseExecutorLease(getPool(), "env_test", "worker-b");
  });

  it("marks an unpaid handoff done only when the assembly is acknowledged", async () => {
    await markStepHandedOff(getPool(), PLAN, 0);
    expect(await acknowledgeAssembly(getPool(), PLAN, 0)).toBe(true);
    expect(await acknowledgeAssembly(getPool(), PLAN, 0)).toBe(false);
    const state = await getPool().query<{ state: string }>(
      "SELECT state FROM steps WHERE plan_id=$1 AND step_index=0",
      [PLAN],
    );
    expect(state.rows[0]?.state).toBe("done");
  });

  it("persists terminal payment failures instead of marking the step done", async () => {
    await markStepFailed(getPool(), {
      planId: PLAN,
      stepIndex: 0,
      attempt: 0,
      errorCode: "idempotency-conflict",
    });
    const state = await getPool().query<{ state: string }>(
      "SELECT state FROM steps WHERE plan_id=$1 AND step_index=0",
      [PLAN],
    );
    expect(state.rows[0]?.state).toBe("failed");
    expect((await getExecutionTrace(getPool(), PLAN, 0, 0)).at(-1)).toMatchObject({
      phase: "step.failed",
      payload: { errorCode: "idempotency-conflict" },
    });
  });

  it("renews an acquired lease while the executor is running", async () => {
    let current = new Date("2026-10-21T00:00:00Z");
    await acquireExecutorLease(getPool(), "env_renew", "worker-a", 1, () => current);
    const initial = await getPool().query<{ expires_at: Date }>(
      "SELECT expires_at FROM executor_leases WHERE envelope_ref='env_renew'",
    );
    const renewal = startExecutorLeaseRenewal(getPool(), "env_renew", "worker-a", 1, () => current);
    current = new Date(current.getTime() + 500);
    await new Promise((resolve) => setTimeout(resolve, 400));
    renewal.assertHeld();
    await renewal.stop();
    const updated = await getPool().query<{ expires_at: Date }>(
      "SELECT expires_at FROM executor_leases WHERE envelope_ref='env_renew'",
    );
    expect(updated.rows[0]?.expires_at.getTime()).toBeGreaterThan(
      initial.rows[0]?.expires_at.getTime() ?? 0,
    );
    await releaseExecutorLease(getPool(), "env_renew", "worker-a");
  });
});
