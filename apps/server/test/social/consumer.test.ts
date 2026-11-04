import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { findOrCreateRepresentative } from "#src/social/representatives";
import { consumeSocialBatch } from "#src/social/consumer";
import { setupDatabase } from "#test/db";
import { makeObjectiveSubmission, seedDevice, TEST_USER_ID } from "#test/fixtures";

const pool = setupDatabase();
const objectiveId = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";

describe("social outbox consumer", () => {
  beforeAll(async () => {
    await seedDevice(pool());
    await findOrCreateRepresentative(pool(), TEST_USER_ID, { bytes: randomBytes });
    const submission = makeObjectiveSubmission(objectiveId);
    await pool().query(
      `INSERT INTO objectives(objective_id,user_id,device_id,submission,objective_hash,state)
       VALUES($1,$2,$3,$4,$5,'delivered')`,
      [objectiveId, TEST_USER_ID, submission.deviceId, submission, submission.objectiveHash],
    );
  });

  it("does not skip an earlier transaction that commits after a later event", async () => {
    const early = await pool().connect();
    await early.query("BEGIN");
    try {
      const first = await early.query<{ event_id: string }>(
        "INSERT INTO outbox_events(name,objective_id,payload) VALUES('objective.delivered',$1,$2) RETURNING event_id",
        [objectiveId, { resultId: "res_fixture" }],
      );
      const later = await pool().query<{ event_id: string }>(
        "INSERT INTO outbox_events(name,payload) VALUES('ignored.fixture','{}') RETURNING event_id",
      );
      expect(Number(first.rows[0]?.event_id)).toBeLessThan(Number(later.rows[0]?.event_id));
      expect(await consumeSocialBatch(pool(), 100)).toBe(0);
      await early.query("COMMIT");
      await vi.waitFor(
        async () => {
          await consumeSocialBatch(pool(), 100);
          const count = await pool().query<{ count: string }>(
            "SELECT count(*) FROM event_deliveries",
          );
          expect(count.rows[0]?.count).toBe("2");
        },
        { timeout: 5_000 },
      );
      expect(await consumeSocialBatch(pool(), 100)).toBe(0);
      const deliveries = await pool().query<{ event_id: string; state: string }>(
        "SELECT event_id,state FROM event_deliveries ORDER BY event_id",
      );
      expect(deliveries.rows).toEqual([
        { event_id: first.rows[0]?.event_id, state: "done" },
        { event_id: later.rows[0]?.event_id, state: "done" },
      ]);
      const inbox = await pool().query<{ kind: string; refs: object }>(
        "SELECT kind,refs FROM social_inbox",
      );
      expect(inbox.rows).toEqual([{ kind: "outcome-ready", refs: { objectiveId } }]);
    } finally {
      await early.query("ROLLBACK");
      early.release();
    }
  });
});
