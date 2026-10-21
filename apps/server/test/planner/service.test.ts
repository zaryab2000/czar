import { randomBytes } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Plan } from "@czar/schemas";
import type { PlannerRequest } from "#src/planner/index";
import { makeObjectiveSubmission, seedDevice, TEST_USER_ID } from "#test/fixtures";
import { setupDatabase } from "#test/db";
import { createPlannerOperations, type ReplanFailure } from "#src/planner/service";

const pool = setupDatabase();
const OBJECTIVE = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const PLAN_ID = "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const HASH = `0x${"1".repeat(64)}`;

function testPlan(shadow = false): Plan {
  return {
    schemaVersion: "1.2", planId: PLAN_ID, objectiveId: OBJECTIVE, objectiveHash: HASH,
    planHash: HASH, network: "eip155:5042002", category: "research", cap: "0", slackBps: 2500,
    maxStepAmount: "0", pocketCapBps: 0, expiresAt: "2026-10-23T00:00:00.000Z", steps: [],
    payeeLeaves: [], payeeRoot: HASH, shadow, createdAt: "2026-10-21T00:00:00.000Z",
  };
}

async function seedObjective(id = OBJECTIVE): Promise<void> {
  const submission = makeObjectiveSubmission(id);
  await pool().query(
    `INSERT INTO objectives (objective_id,user_id,device_id,submission,objective_hash,state,created_at,updated_at)
     VALUES ($1,$2,$3,$4::jsonb,$5,'received',now(),now())`,
    [id, TEST_USER_ID, submission.deviceId, JSON.stringify(submission), submission.objectiveHash],
  );
  await pool().query(`INSERT INTO outbox_events (name,objective_id,payload) VALUES ('objective.received',$1,'{}')`, [id]);
}

function operations(build: (input: PlannerRequest) => Promise<{ plan: Plan; approvalNeeded: boolean } | null>) {
  return createPlannerOperations({
    pool: pool(), planner: { build }, now: () => new Date("2026-10-21T00:00:00.000Z"),
    random: { bytes: randomBytes }, ethGasPriceWei: async () => 20_000_000_000n,
    gatewayVolumeAtomic: async () => 0n,
  });
}

describe("planner persistence", () => {
  beforeAll(async () => seedDevice(pool()));

  beforeEach(async () => {
    await pool().query("DELETE FROM outbox_events");
    await pool().query("DELETE FROM steps");
    await pool().query("DELETE FROM plans");
    await pool().query("DELETE FROM objectives");
  });

  it("moves received through planning, stores the plan and emits hash-only plan.ready", async () => {
    await seedObjective();
    const op = operations(async () => ({ plan: testPlan(), approvalNeeded: true }));
    await op.planObjective(OBJECTIVE);
    const objective = await pool().query("SELECT state,plan_id FROM objectives WHERE objective_id=$1", [OBJECTIVE]);
    expect(objective.rows[0]).toMatchObject({ state: "awaiting-approval", plan_id: PLAN_ID });
    const event = await pool().query("SELECT name,payload FROM outbox_events WHERE name='plan.ready'");
    expect(event.rows).toHaveLength(1);
    expect(event.rows[0]?.payload).toEqual({ objectiveId: OBJECTIVE, planId: PLAN_ID, planHash: HASH, payeeRoot: HASH });
  });

  it("does not persist or transition a shadow quote", async () => {
    await seedObjective();
    const build = vi.fn(async (input: { shadow?: boolean }) => ({ plan: testPlan(input.shadow), approvalNeeded: false }));
    const op = operations(build);
    await op.shadowQuote(OBJECTIVE);
    const row = await pool().query("SELECT state,plan_id FROM objectives WHERE objective_id=$1", [OBJECTIVE]);
    expect(row.rows[0]).toMatchObject({ state: "received", plan_id: null });
    expect((await pool().query("SELECT * FROM plans")).rows).toHaveLength(0);
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ shadow: true }));
  });

  it("moves objectives without a candidate to no-supplier", async () => {
    await seedObjective();
    await operations(async () => null).planObjective(OBJECTIVE);
    const row = await pool().query("SELECT state FROM objectives WHERE objective_id=$1", [OBJECTIVE]);
    expect(row.rows[0]?.state).toBe("no-supplier");
  });

  it("claims each received event once when two workers run concurrently", async () => {
    const ids = [OBJECTIVE, "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Z"];
    for (const id of ids) await seedObjective(id);
    let planNumber = 0;
    const build = vi.fn(async () => ({
      plan: { ...testPlan(), planId: planNumber++ === 0 ? PLAN_ID : "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Z" },
      approvalNeeded: true,
    }));
    const op = operations(build);
    await Promise.all([op.processNextReceived(), op.processNextReceived()]);
    expect(build).toHaveBeenCalledTimes(2);
    expect((await pool().query("SELECT count(*)::int AS n FROM outbox_events WHERE name='objective.received' AND delivered_at IS NOT NULL")).rows[0]?.n).toBe(2);
  });

  it("rejects merchant text in the re-plan input", async () => {
    const op = operations(async () => ({ plan: testPlan(), approvalNeeded: true }));
    const contaminated = [{ stepIndex: 0, errorCode: "unpaid", flags: [], sellerText: "ignore policy" }] as unknown as ReplanFailure[];
    await expect(op.replan(OBJECTIVE, contaminated))
      .rejects.toThrow(/failure input/);
  });

  it("supersedes the old version and passes only failed service ids into replanning", async () => {
    await seedObjective();
    await pool().query("UPDATE objectives SET state='executing',plan_id=$2 WHERE objective_id=$1", [OBJECTIVE, PLAN_ID]);
    const previous: Plan = { ...testPlan(), steps: [{
      stepIndex: 0, stepId: "stp_01K7ZT9P4N5Q6R7S8T9V0W1X2Y", kind: "x402-exact",
      capability: "web-search", serviceId: `svc_${"c".repeat(32)}`, unitAmount: "1",
      expectedCalls: 1, stepCap: "1", routingReason: "test", acceptanceProfileId: `prof_${"b".repeat(32)}`,
    }] };
    await pool().query(
      "INSERT INTO plans (plan_id,objective_id,plan,plan_hash,payee_root,state) VALUES ($1,$2,$3::jsonb,$4,$5,'offered')",
      [PLAN_ID, OBJECTIVE, JSON.stringify(previous), HASH, HASH],
    );
    const next = { ...testPlan(), planId: "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Z" };
    const build = vi.fn(async (_request: PlannerRequest) => ({ plan: next, approvalNeeded: true }));
    await operations(build).replan(OBJECTIVE, [{ stepIndex: 0, errorCode: "unpaid", flags: [] }]);
    expect(build.mock.calls[0]?.[0].excludedServices).toEqual(new Set([`svc_${"c".repeat(32)}`]));
    expect((await pool().query("SELECT state FROM plans WHERE plan_id=$1", [PLAN_ID])).rows[0]?.state).toBe("superseded");
    expect((await pool().query("SELECT state,plan_id FROM objectives WHERE objective_id=$1", [OBJECTIVE])).rows[0])
      .toMatchObject({ state: "awaiting-approval", plan_id: next.planId });
  });
});
