import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { validateRecordedExchange } from "@czar/api-contract";
import { setupDatabase } from "#test/db";
import {
  createTestContext,
  makeObjectiveSubmission,
  seedDevice,
  TEST_DEVICE_ID,
  TEST_NOW,
  TEST_TOKEN,
} from "#test/fixtures";

const getPool = setupDatabase();
const keys = {
  replay: "00000000-0000-4000-8000-000000000031",
  conflict: "00000000-0000-4000-8000-000000000032",
  concurrent: "00000000-0000-4000-8000-000000000034",
};

describe("submitObjective", () => {
  beforeAll(async () => seedDevice(getPool()));

  it("submitObjective_openapi202_andOneOutboxEvent", async () => {
    const pool = getPool();
    const context = createTestContext(pool);
    const body = makeObjectiveSubmission("obj_01K7ZT9P4N5Q6R7S8T9V0W1X2B");
    const errors = validateRecordedExchange("submitObjective", {
      requestBody: body,
      responseStatus: 202,
      responseBody: {
        objectiveId: body.objectiveId,
        status: "received",
        updatedAt: TEST_NOW.toISOString(),
      },
    }).errors;
    expect(errors).toEqual([]);
    const response = await post(context.app, keys.replay, JSON.stringify(body));
    const result = (await response.json()) as any;
    expect(response.status).toBe(202);
    expect(result).toMatchObject({ objectiveId: body.objectiveId, status: "received" });
    expect(
      validateRecordedExchange("submitObjective", {
        requestBody: body,
        responseStatus: response.status,
        responseBody: result,
      }).valid,
    ).toBe(true);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(context.logLines.join("\n")).not.toContain(body.goal);
    expect(context.logLines.join("\n")).not.toContain(TEST_TOKEN);
    const saved = await pool.query(
      "SELECT submission,objective_hash,state FROM objectives WHERE objective_id=$1",
      [body.objectiveId],
    );
    expect(saved.rows[0]?.submission.goal).toBe(body.goal);
    expect(saved.rows[0]?.objective_hash).toBe(body.objectiveHash);
    expect(saved.rows[0]?.state).toBe("received");
    const outbox = await pool.query(
      "SELECT name,payload FROM outbox_events WHERE objective_id=$1",
      [body.objectiveId],
    );
    expect(outbox.rowCount).toBe(1);
    expect(outbox.rows[0]?.name).toBe("objective.received");
    expect(JSON.stringify(outbox.rows[0]?.payload)).not.toContain(body.goal);
  });

  it("idempotency_sameKeySameBytes_replaysOriginal202", async () => {
    const pool = getPool();
    const context = createTestContext(pool);
    const body = makeObjectiveSubmission("obj_01K7ZT9P4N5Q6R7S8T9V0W1X2C");
    const raw = JSON.stringify(body);
    const first = await post(context.app, keys.conflict, raw);
    const firstBody = (await first.json()) as any;
    const second = await post(context.app, keys.conflict, raw);
    const secondBody = (await second.json()) as any;
    expect(second.status).toBe(202);
    expect(secondBody).toEqual(firstBody);
    expect(
      await pool.query("SELECT event_id FROM outbox_events WHERE objective_id=$1", [
        body.objectiveId,
      ]),
    ).toMatchObject({ rowCount: 1 });
  });

  it("idempotency_sameKeyDifferentBytes_returns409", async () => {
    const body = makeObjectiveSubmission("obj_01K7ZT9P4N5Q6R7S8T9V0W1X2D");
    const raw = JSON.stringify(body);
    expect((await post(createTestContext(getPool()).app, keys.concurrent, raw)).status).toBe(202);
    const changedBytes = JSON.stringify(Object.fromEntries(Object.entries(body).toReversed()));
    const response = await post(createTestContext(getPool()).app, keys.concurrent, changedBytes);
    const result = (await response.json()) as any;
    expect(response.status).toBe(409);
    expect(result.czarCode).toBe("idempotency-conflict");
    expect(
      validateRecordedExchange("submitObjective", {
        requestBody: body,
        responseStatus: response.status,
        responseBody: result,
      }).valid,
    ).toBe(true);
  });

  it("submitObjective_tamperedGoalOrSubject_returns422WithoutWrites", async () => {
    const pool = getPool();
    const context = createTestContext(pool);
    const goalBase = makeObjectiveSubmission("obj_01K7ZT9P4N5Q6R7S8T9V0W1X2E");
    const subjectBase = makeObjectiveSubmission("obj_01K7ZT9P4N5Q6R7S8T9V0W1X2F");
    const goalTampered = { ...goalBase, goal: "Changed goal without recomputing" };
    const subjectTampered = {
      ...subjectBase,
      taskSpec: {
        ...subjectBase.taskSpec,
        subjects: [{ label: "Changed subject without recomputing" }],
      },
    };
    for (const [index, body] of [goalTampered, subjectTampered].entries()) {
      const response = await post(
        context.app,
        `00000000-0000-4000-8000-0000000000${40 + index}`,
        JSON.stringify(body),
      );
      const result = (await response.json()) as any;
      expect(response.status).toBe(422);
      expect(result.czarCode).toBe("hash-mismatch");
      expect(
        validateRecordedExchange("submitObjective", {
          requestBody: body,
          responseStatus: response.status,
          responseBody: result,
        }).valid,
      ).toBe(true);
      expect(
        await pool.query("SELECT objective_id FROM objectives WHERE objective_id=$1", [
          body.objectiveId,
        ]),
      ).toMatchObject({ rowCount: 0 });
      expect(
        await pool.query("SELECT event_id FROM outbox_events WHERE objective_id=$1", [
          body.objectiveId,
        ]),
      ).toMatchObject({ rowCount: 0 });
    }
  });

  it("submitObjective_localOnlyAndDeviceMismatch_return400", async () => {
    const context = createTestContext(getPool());
    const body = makeObjectiveSubmission("obj_01K7ZT9P4N5Q6R7S8T9V0W1X2G");
    const localOnly = await post(
      context.app,
      "00000000-0000-4000-8000-000000000042",
      JSON.stringify({ ...body, evidence: "private" }),
    );
    expect(localOnly.status).toBe(400);
    const mismatch = await post(
      context.app,
      "00000000-0000-4000-8000-000000000043",
      JSON.stringify({ ...body, deviceId: "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2Z" }),
    );
    expect(mismatch.status).toBe(400);
  });

  it("idempotency_concurrentSameKey_oneObjectiveOneEvent", async () => {
    const pool = getPool();
    const context = createTestContext(pool);
    const body = makeObjectiveSubmission("obj_01K7ZT9P4N5Q6R7S8T9V0W1X2H");
    const raw = JSON.stringify(body);
    const responses = await Promise.all([
      post(context.app, "00000000-0000-4000-8000-000000000044", raw),
      post(context.app, "00000000-0000-4000-8000-000000000044", raw),
    ]);
    expect(responses.map((response) => response.status)).toEqual([202, 202]);
    expect(
      await pool.query("SELECT objective_id FROM objectives WHERE objective_id=$1", [
        body.objectiveId,
      ]),
    ).toMatchObject({ rowCount: 1 });
    expect(
      await pool.query("SELECT event_id FROM outbox_events WHERE objective_id=$1", [
        body.objectiveId,
      ]),
    ).toMatchObject({ rowCount: 1 });
  });

  it("idempotency_expiredKeyCanBeReused_butObjectiveIdStaysUnique", async () => {
    const pool = getPool();
    const context = createTestContext(pool);
    const body = makeObjectiveSubmission("obj_01K7ZT9P4N5Q6R7S8T9V0W1X2K");
    const key = "00000000-0000-4000-8000-000000000047";
    const raw = JSON.stringify(body);
    expect((await post(context.app, key, raw)).status).toBe(202);
    await pool.query("UPDATE idempotency SET expires_at=$1 WHERE scope=$2 AND key=$3", [
      new Date("2026-10-20T00:00:00.000Z"),
      `submitObjective:${TEST_DEVICE_ID}`,
      key,
    ]);
    const retry = await post(context.app, key, raw);
    expect(retry.status).toBe(409);
    expect(((await retry.json()) as any).czarCode).toBe("validation");
  });

  it("objectiveInsert_rollsBackWhenOutboxInsertFails", async () => {
    const pool = getPool();
    const context = createTestContext(pool);
    const body = makeObjectiveSubmission("obj_01K7ZT9P4N5Q6R7S8T9V0W1X2N");
    await pool.query(`CREATE FUNCTION fail_t041_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'outbox test failure'; END $$`);
    await pool.query(
      "CREATE TRIGGER fail_t041_outbox BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION fail_t041_outbox()",
    );
    const response = await post(
      context.app,
      "00000000-0000-4000-8000-000000000048",
      JSON.stringify(body),
    );
    await pool.query("DROP TRIGGER fail_t041_outbox ON outbox_events");
    await pool.query("DROP FUNCTION fail_t041_outbox()");
    const result = (await response.json()) as any;
    expect(response.status).toBe(503);
    expect(result.detail).not.toContain("outbox test failure");
    expect(
      await pool.query("SELECT objective_id FROM objectives WHERE objective_id=$1", [
        body.objectiveId,
      ]),
    ).toMatchObject({ rowCount: 0 });
    expect(
      await pool.query("SELECT event_id FROM outbox_events WHERE objective_id=$1", [
        body.objectiveId,
      ]),
    ).toMatchObject({ rowCount: 0 });
    expect(
      await pool.query("SELECT key FROM idempotency WHERE key=$1", [
        "00000000-0000-4000-8000-000000000048",
      ]),
    ).toMatchObject({ rowCount: 0 });
  });

  it("objectiveId_globalUniqueAcrossDevices", async () => {
    const pool = getPool();
    const context = createTestContext(pool);
    const foreignToken = Buffer.alloc(32, 22).toString("base64url");
    const foreignUser = "usr_01K7ZT9P4N5Q6R7S8T9V0W1X2Z";
    const foreignDevice = "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2Z";
    await pool.query("INSERT INTO users (user_id) VALUES ($1)", [foreignUser]);
    await pool.query(
      "INSERT INTO devices (device_id,user_id,device_name,platform,token_hash) VALUES ($1,$2,'Other','linux',$3)",
      [foreignDevice, foreignUser, createHash("sha256").update(foreignToken).digest()],
    );
    const id = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2J";
    const first = makeObjectiveSubmission(id);
    expect(
      (await post(context.app, "00000000-0000-4000-8000-000000000045", JSON.stringify(first)))
        .status,
    ).toBe(202);
    const second = makeObjectiveSubmission(id, { deviceId: foreignDevice });
    const response = await context.app.request("/v1/objectives", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${foreignToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "00000000-0000-4000-8000-000000000046",
      },
      body: JSON.stringify(second),
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as any).czarCode).toBe("validation");
  });
});

async function post(
  app: ReturnType<typeof createTestContext>["app"],
  key: string,
  body: string,
): Promise<Response> {
  return app.request("/v1/objectives", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TEST_TOKEN}`,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body,
  });
}
