import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchExecutingObjectives, type DispatcherDependencies } from "#src/payer/dispatcher";
import { markStepDoneWithResults } from "#src/payer/executions";
import { setupDatabase } from "#test/db";
import { makeObjectiveSubmission, seedDevice, TEST_USER_ID } from "#test/fixtures";

const getPool = setupDatabase();
const OBJECTIVE = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const PLAN = "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const ENVELOPE = "eip155:5042002:0x0000000000000000000000000000000000000001:1";
const VAULT = "0x0000000000000000000000000000000000000001";
const HASH = `0x${"01".repeat(32)}`;

describe("payer dispatcher", () => {
  beforeAll(async () => seedDevice(getPool()));

  beforeEach(async () => {
    await getPool().query("DELETE FROM executor_leases");
    await getPool().query("DELETE FROM step_executions");
    await getPool().query("DELETE FROM steps");
    await getPool().query("DELETE FROM plans");
    await getPool().query("DELETE FROM objectives");
    const submission = makeObjectiveSubmission(OBJECTIVE);
    await getPool().query("UPDATE users SET vault=$1 WHERE user_id=$2", [VAULT, TEST_USER_ID]);
    await getPool().query(
      `INSERT INTO objectives
       (objective_id,user_id,device_id,submission,objective_hash,state,plan_id,envelope_ref)
       VALUES ($1,$2,$3,$4::jsonb,$5,'executing',$6,$7)`,
      [
        OBJECTIVE,
        TEST_USER_ID,
        submission.deviceId,
        JSON.stringify(submission),
        submission.objectiveHash,
        PLAN,
        ENVELOPE,
      ],
    );
    const steps = [
      { stepIndex: 0, kind: "x402-exact", expectedCalls: 1, stepCap: "10" },
      { stepIndex: 1, kind: "local", expectedCalls: 0, stepCap: "0", dependsOn: [0] },
    ];
    await getPool().query(
      `INSERT INTO plans (plan_id,objective_id,plan,plan_hash,payee_root,state)
       VALUES ($1,$2,$3::jsonb,$4,$5,'approved')`,
      [PLAN, OBJECTIVE, JSON.stringify({ steps }), HASH, HASH],
    );
    for (const step of steps)
      await getPool().query(
        "INSERT INTO steps (plan_id,step_index,step,state) VALUES ($1,$2,$3::jsonb,'queued')",
        [PLAN, step.stepIndex, JSON.stringify(step)],
      );
  });

  it("runs dependent steps in order and completes only after all become terminal", async () => {
    const order: number[] = [];
    const complete = vi.fn();
    await dispatchExecutingObjectives({
      pool: getPool(),
      config: { get: () => 60 } as never,
      now: () => new Date("2026-10-25T12:00:00Z"),
      isFrozen: async () => false,
      hasPendingFrozenEvent: async () => false,
      isGuardianPaused: async () => false,
      runStep: async ({ step }) => {
        order.push(step.stepIndex);
        if (step.stepIndex === 0)
          await markStepDoneWithResults(getPool(), {
            planId: PLAN,
            stepIndex: 0,
            attempt: 0,
            callsUsed: 1,
            results: [{ index: 0, stepResult: validStepResult() }],
          });
        return "done";
      },
      complete,
      onError: (error) => {
        throw error;
      },
    });
    expect(order).toEqual([0, 1]);
    expect(complete).toHaveBeenCalledOnce();
  });

  it("does not mark a paid step done without a valid persisted result", async () => {
    const complete = vi.fn();
    await dispatchExecutingObjectives({
      pool: getPool(),
      config: { get: () => 60 } as never,
      now: () => new Date("2026-10-25T12:00:00Z"),
      isFrozen: async () => false,
      hasPendingFrozenEvent: async () => false,
      isGuardianPaused: async () => false,
      runStep: async () => "done",
      complete,
      onError: (error) => {
        throw error;
      },
    });
    const result = await getPool().query<{ state: string }>(
      "SELECT state FROM steps WHERE plan_id=$1 AND step_index=0",
      [PLAN],
    );
    expect(result.rows[0]?.state).toBe("queued");
    expect(complete).not.toHaveBeenCalled();
  });

  it("does not enter a step when the vault is frozen", async () => {
    const runStep = vi.fn(
      async (_input: Parameters<DispatcherDependencies["runStep"]>[0]) => "done" as const,
    );
    await dispatchExecutingObjectives({
      pool: getPool(),
      config: { get: () => 60 } as never,
      now: () => new Date("2026-10-25T12:00:00Z"),
      isFrozen: async () => true,
      hasPendingFrozenEvent: async () => false,
      isGuardianPaused: async () => false,
      runStep,
      complete: vi.fn(),
      onError: (error) => {
        throw error;
      },
    });
    expect(runStep).not.toHaveBeenCalled();
  });

  it("does not enter a step while frozen auto-limit lowering is pending", async () => {
    const checks: string[] = [];
    const runStep = vi.fn(
      async (_input: Parameters<DispatcherDependencies["runStep"]>[0]) => "done" as const,
    );
    await dispatchExecutingObjectives({
      pool: getPool(),
      config: { get: () => 60 } as never,
      now: () => new Date("2026-10-25T12:00:00Z"),
      isFrozen: async () => {
        checks.push("frozen-state");
        return false;
      },
      hasPendingFrozenEvent: async () => {
        checks.push("current-head-scan");
        return true;
      },
      isGuardianPaused: async () => false,
      runStep,
      complete: vi.fn(),
      onError: (error) => {
        throw error;
      },
    });
    expect(checks).toEqual(["frozen-state", "current-head-scan"]);
    expect(runStep).not.toHaveBeenCalled();
  });

  it("allows a dependent step to observe a terminal failed dependency", async () => {
    const order: number[] = [];
    await dispatchExecutingObjectives({
      pool: getPool(),
      config: { get: () => 60 } as never,
      now: () => new Date("2026-10-25T12:00:00Z"),
      isFrozen: async () => false,
      hasPendingFrozenEvent: async () => false,
      isGuardianPaused: async () => false,
      runStep: async ({ step }) => {
        order.push(step.stepIndex);
        return step.stepIndex === 0 ? "failed" : "done";
      },
      complete: vi.fn(),
      onError: (error) => {
        throw error;
      },
    });
    expect(order).toEqual([0, 1]);
  });

  it("persists a handed-off state and waits for daemon acknowledgement", async () => {
    await getPool().query("UPDATE plans SET plan=$2::jsonb WHERE plan_id=$1", [
      PLAN,
      JSON.stringify({ steps: [{ stepIndex: 0, kind: "local", expectedCalls: 0, stepCap: "0" }] }),
    ]);
    await getPool().query("DELETE FROM steps WHERE plan_id=$1", [PLAN]);
    await getPool().query(
      "INSERT INTO steps (plan_id,step_index,step,state) VALUES ($1,0,$2::jsonb,'queued')",
      [PLAN, JSON.stringify({ stepIndex: 0, kind: "local", expectedCalls: 0, stepCap: "0" })],
    );
    const complete = vi.fn();
    await dispatchExecutingObjectives({
      pool: getPool(),
      config: { get: () => 60 } as never,
      now: () => new Date("2026-10-25T12:00:00Z"),
      isFrozen: async () => false,
      hasPendingFrozenEvent: async () => false,
      isGuardianPaused: async () => false,
      runStep: async () => "handed_off",
      complete,
      onError: (error) => {
        throw error;
      },
    });
    const row = await getPool().query<{ state: string }>(
      "SELECT state FROM steps WHERE plan_id=$1 AND step_index=0",
      [PLAN],
    );
    expect(row.rows[0]?.state).toBe("handed_off");
    expect(complete).not.toHaveBeenCalled();
  });

  it("does not hand off the same unpaid step again on the next poll", async () => {
    await getPool().query("UPDATE plans SET plan=$2::jsonb WHERE plan_id=$1", [
      PLAN,
      JSON.stringify({ steps: [{ stepIndex: 0, kind: "local", expectedCalls: 0, stepCap: "0" }] }),
    ]);
    await getPool().query("DELETE FROM steps WHERE plan_id=$1", [PLAN]);
    await getPool().query(
      "INSERT INTO steps (plan_id,step_index,step,state) VALUES ($1,0,$2::jsonb,'queued')",
      [PLAN, JSON.stringify({ stepIndex: 0, kind: "local", expectedCalls: 0, stepCap: "0" })],
    );
    const runStep = vi.fn(async () => "handed_off" as const);
    const dependencies: DispatcherDependencies = {
      pool: getPool(),
      config: { get: () => 60 } as never,
      now: () => new Date("2026-10-25T12:00:00Z"),
      isFrozen: async () => false,
      hasPendingFrozenEvent: async () => false,
      isGuardianPaused: async () => false,
      runStep,
      complete: vi.fn(),
      onError: (error) => {
        throw error;
      },
    };

    await dispatchExecutingObjectives(dependencies);
    await dispatchExecutingObjectives(dependencies);

    expect(runStep).toHaveBeenCalledOnce();
  });

  it("does not enter an envelope leased by another worker", async () => {
    await getPool().query(
      "INSERT INTO executor_leases (envelope_ref,worker_id,expires_at) VALUES ($1,'other',$2)",
      [ENVELOPE, new Date("2026-10-25T12:01:00Z")],
    );
    const runStep = vi.fn(
      async (_input: Parameters<DispatcherDependencies["runStep"]>[0]) => "done" as const,
    );
    await dispatchExecutingObjectives({
      pool: getPool(),
      config: { get: () => 60 } as never,
      now: () => new Date("2026-10-25T12:00:00Z"),
      isFrozen: async () => false,
      hasPendingFrozenEvent: async () => false,
      isGuardianPaused: async () => false,
      runStep,
      complete: vi.fn(),
      onError: (error) => {
        throw error;
      },
    });
    expect(runStep).not.toHaveBeenCalled();
  });

  it("acquires each dispatch lease using the current clock, not the batch start", async () => {
    const initial = new Date("2026-10-25T12:00:00Z");
    let clockReads = 0;
    const observedExpiry: Date[] = [];
    const now = vi.fn(() => {
      const value = new Date(initial.getTime() + clockReads * 120_000);
      clockReads += 1;
      return value;
    });
    await dispatchExecutingObjectives({
      pool: getPool(),
      config: { get: () => 60 } as never,
      now,
      isFrozen: async () => false,
      hasPendingFrozenEvent: async () => false,
      isGuardianPaused: async () => false,
      runStep: async ({ step }) => {
        const lease = await getPool().query<{ expires_at: Date }>(
          "SELECT expires_at FROM executor_leases WHERE envelope_ref=$1",
          [ENVELOPE],
        );
        observedExpiry.push(lease.rows[0]!.expires_at);
        if (step.stepIndex === 0)
          await markStepDoneWithResults(getPool(), {
            planId: PLAN,
            stepIndex: 0,
            attempt: 0,
            callsUsed: 1,
            results: [{ index: 0, stepResult: validStepResult() }],
          });
        return "done";
      },
      complete: vi.fn(),
      onError: (error) => {
        throw error;
      },
    });

    expect(observedExpiry).toEqual([
      new Date(initial.getTime() + 180_000),
      new Date(initial.getTime() + 180_000),
    ]);
  });

  it("passes journal phases to resumed steps after a lease expires", async () => {
    await getPool().query(
      `INSERT INTO step_executions (plan_id,step_index,attempt,phase,payload)
       VALUES ($1,0,0,'reserve.sent',$2::jsonb)`,
      [PLAN, JSON.stringify({ txHash: HASH })],
    );
    await getPool().query(
      "INSERT INTO executor_leases (envelope_ref,worker_id,expires_at) VALUES ($1,'old',$2)",
      [ENVELOPE, new Date("2026-10-25T11:59:00Z")],
    );
    const runStep = vi.fn(
      async (_input: Parameters<DispatcherDependencies["runStep"]>[0]) => "done" as const,
    );
    await dispatchExecutingObjectives({
      pool: getPool(),
      config: { get: () => 60 } as never,
      now: () => new Date("2026-10-25T12:00:00Z"),
      isFrozen: async () => false,
      hasPendingFrozenEvent: async () => false,
      isGuardianPaused: async () => false,
      runStep,
      complete: vi.fn(),
      onError: (error) => {
        throw error;
      },
    });
    expect(runStep.mock.calls[0]?.[0].trace).toMatchObject([
      { phase: "reserve.sent", payload: { txHash: HASH } },
    ]);
    expect(
      await getPool().query("SELECT 1 FROM executor_leases WHERE envelope_ref=$1", [ENVELOPE]),
    ).toMatchObject({ rowCount: 0 });
  });
});

function validStepResult() {
  return {
    schemaVersion: "1.1" as const,
    stepIndex: 0,
    callIndex: 0,
    obsId: `obs_${"a".repeat(32)}`,
    status: "delivered" as const,
    source: {
      origin: "https://merchant.test",
      payTo: "0x0000000000000000000000000000000000000001",
      paymentRefHash: HASH,
    },
    fields: [],
    flags: [],
    bodyCommit: HASH,
  };
}
