import { describe, expect, it } from "vitest";
import { resolveReference } from "@czar/api-contract";
import { setupDatabase } from "#test/db";
import { seedDevice, TEST_DEVICE_ID, TEST_USER_ID } from "#test/fixtures";
import { OBJECTIVE_STATES, canTransition } from "#src/objectives/state";
import { purgeExpiredGoals } from "#src/objectives/retention";

const getPool = setupDatabase();

describe("objective lifecycle foundations", () => {
  it("objectiveStatus_onlyCanonicalValuesStored", () => {
    const contract = resolveReference("#/components/schemas/ObjectiveStatusValue") as {
      enum: string[];
    };
    expect([...OBJECTIVE_STATES].toSorted()).toEqual([...contract.enum].toSorted());
    expect(OBJECTIVE_STATES).not.toContain("approved");
  });

  it("state_rejectsIllegalTransitionAndTerminalExit", () => {
    expect(canTransition("received", "planning")).toBe(true);
    expect(canTransition("received", "delivered")).toBe(false);
    expect(canTransition("delivered", "planning")).toBe(false);
    expect(canTransition("awaiting-approval", "dismissed")).toBe(true);
  });

  it("retention_removesOldGoalAndPreservesStatusAndRecentGoal", async () => {
    const pool = getPool();
    await seedDevice(pool);
    const now = new Date("2026-10-21T00:00:00.000Z");
    const oldId = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
    const recentId = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Z";
    for (const [objectiveId, createdAt] of [
      [oldId, new Date("2025-10-20T00:00:00.000Z")],
      [recentId, new Date("2026-10-20T00:00:00.000Z")],
    ] as const) {
      await pool.query(
        `INSERT INTO objectives (objective_id,user_id,device_id,submission,objective_hash,state,created_at,updated_at)
         VALUES ($1,$2,$3,$4,'0x' || repeat('a',64),'received',$5,$5)`,
        [
          objectiveId,
          TEST_USER_ID,
          TEST_DEVICE_ID,
          JSON.stringify({ goal: "retention marker" }),
          createdAt,
        ],
      );
    }
    const count = await purgeExpiredGoals(pool, now);
    const rows = await pool.query<{
      objective_id: string;
      submission: { goal?: string };
      state: string;
    }>("SELECT objective_id,submission,state FROM objectives ORDER BY objective_id");
    expect(count).toBe(1);
    expect(rows.rows.find((row) => row.objective_id === oldId)?.submission.goal).toBeUndefined();
    expect(rows.rows.find((row) => row.objective_id === oldId)?.state).toBe("received");
    expect(rows.rows.find((row) => row.objective_id === recentId)?.submission.goal).toBe(
      "retention marker",
    );
  });
});
