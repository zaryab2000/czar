import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { setupDatabase } from "#test/db";
import {
  createTestContext,
  seedDevice,
  TEST_DEVICE_ID,
  TEST_TOKEN,
  TEST_USER_ID,
} from "#test/fixtures";

const getPool = setupDatabase();
const OBJECTIVE_ID = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const RESULT_ID = "res_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const FOREIGN_USER_ID = "usr_01K7ZT9P4N5Q6R7S8T9V0W1X2Z";
const FOREIGN_DEVICE_ID = "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2Z";
const FOREIGN_OBJECTIVE_ID = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Z";
const FOREIGN_RESULT_ID = "res_01K7ZT9P4N5Q6R7S8T9V0W1X2Z";
const UNKNOWN_RESULT_ID = "res_01K7ZT9P4N5Q6R7S8T9V0W1X2W";
const NOTICE_OBJECTIVE_ID = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2W";
const NOTICE_RESULT_ID = "res_01K7ZT9P4N5Q6R7S8T9V0W1X2W";

beforeAll(async () => {
  const pool = getPool();
  await seedDevice(pool);
  await insertResult(pool, TEST_USER_ID, TEST_DEVICE_ID, OBJECTIVE_ID, RESULT_ID);
  await insertResult(
    pool,
    TEST_USER_ID,
    TEST_DEVICE_ID,
    NOTICE_OBJECTIVE_ID,
    NOTICE_RESULT_ID,
    "No content was delivered.",
  );
  await insertResult(
    pool,
    FOREIGN_USER_ID,
    FOREIGN_DEVICE_ID,
    FOREIGN_OBJECTIVE_ID,
    FOREIGN_RESULT_ID,
  );
});

describe("result routes", () => {
  it("returns the device owner's result and hides another user's result", async () => {
    const pool = getPool();
    const { app } = createTestContext(pool);

    const own = await app.request(`/v1/results/${RESULT_ID}`, { headers: deviceHeaders() });
    expect(own.status).toBe(200);
    await expect(own.json()).resolves.toMatchObject({
      resultId: RESULT_ID,
      objectiveId: OBJECTIVE_ID,
      mimeType: "application/json",
      body: JSON.stringify({ result: "untrusted" }),
    });
    expect((await app.request(`/v1/results/${RESULT_ID}`)).status).toBe(401);

    const foreign = await app.request(`/v1/results/${FOREIGN_RESULT_ID}`, {
      headers: deviceHeaders(),
    });
    expect(foreign.status).toBe(404);
  });

  it("labels plain-text completion notices as markdown", async () => {
    const { app } = createTestContext(getPool());
    const response = await app.request(`/v1/results/${NOTICE_RESULT_ID}`, {
      headers: deviceHeaders(),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      resultId: NOTICE_RESULT_ID,
      mimeType: "text/markdown",
      body: "No content was delivered.",
    });
  });

  it("enforces the four SCR-148 acknowledgment cases", async () => {
    const pool = getPool();
    const { app } = createTestContext(pool);
    const key = randomUUID();
    const body = {
      resultId: RESULT_ID,
      writtenAt: "2026-10-21T00:00:00.000Z",
      surface: "claude-code-file",
      artifacts: { delivered: 1, heldForReview: 0 },
    };
    const request = (objectiveId: string, resultBody: typeof body, idempotencyKey: string) =>
      app.request(`/v1/objectives/${objectiveId}/results/ack`, {
        method: "POST",
        headers: {
          ...deviceHeaders(),
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(resultBody),
      });

    expect((await request(OBJECTIVE_ID, body, "not-a-uuid")).status).toBe(400);
    expect((await request(OBJECTIVE_ID, body, key)).status).toBe(204);
    expect((await request(OBJECTIVE_ID, body, key)).status).toBe(204);
    expect(await readAck(pool)).toMatchObject({ writtenAt: body.writtenAt, surface: body.surface });
    expect(
      (
        await pool.query(
          "SELECT event_id FROM outbox_events WHERE name='result.acknowledged' AND objective_id=$1",
          [OBJECTIVE_ID],
        )
      ).rowCount,
    ).toBe(1);

    expect(
      (await request(OBJECTIVE_ID, { ...body, writtenAt: "2026-10-22T00:00:00.000Z" }, key)).status,
    ).toBe(409);
    expect(await readAck(pool)).toMatchObject({ writtenAt: body.writtenAt, surface: body.surface });

    expect(
      (
        await request(
          OBJECTIVE_ID,
          { ...body, writtenAt: "2026-10-23T00:00:00.000Z" },
          randomUUID(),
        )
      ).status,
    ).toBe(204);
    expect(await readAck(pool)).toMatchObject({ writtenAt: body.writtenAt, surface: body.surface });

    expect(
      (await request(OBJECTIVE_ID, { ...body, resultId: FOREIGN_RESULT_ID }, randomUUID())).status,
    ).toBe(404);
    expect(
      (await request(FOREIGN_OBJECTIVE_ID, { ...body, resultId: FOREIGN_RESULT_ID }, randomUUID()))
        .status,
    ).toBe(404);
    expect(
      (await request(OBJECTIVE_ID, { ...body, resultId: UNKNOWN_RESULT_ID }, randomUUID())).status,
    ).toBe(404);
  });
});

async function readAck(pool: Awaited<ReturnType<typeof getPool>>): Promise<{
  writtenAt: string;
  surface: string;
}> {
  const result = await pool.query<{ payload: { writtenAt: string; surface: string } }>(
    `SELECT payload FROM outbox_events
     WHERE name='result.acknowledged' AND objective_id=$1 LIMIT 1`,
    [OBJECTIVE_ID],
  );
  const payload = result.rows[0]?.payload;
  if (!payload) throw new Error("Expected a stored result acknowledgment.");
  return payload;
}

function deviceHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TEST_TOKEN}` };
}

async function insertResult(
  pool: Awaited<ReturnType<typeof getPool>>,
  userId: string,
  deviceId: string,
  objectiveId: string,
  resultId: string,
  renderedBody = JSON.stringify({ result: "untrusted" }),
): Promise<void> {
  if (userId !== TEST_USER_ID) {
    await pool.query("INSERT INTO users (user_id) VALUES ($1)", [userId]);
    await pool.query(
      `INSERT INTO devices (device_id,user_id,device_name,platform,token_hash)
       VALUES ($1,$2,'Foreign device','macos',$3)`,
      [deviceId, userId, Buffer.alloc(32, 19)],
    );
  }
  await pool.query(
    `INSERT INTO objectives
       (objective_id,user_id,device_id,submission,objective_hash,state,result_id,created_at,updated_at)
     VALUES ($1,$2,$3,'{}'::jsonb,'0x' || repeat('a',64),'delivered',$4,now(),now())`,
    [objectiveId, userId, deviceId, resultId],
  );
  await pool.query(
    `INSERT INTO results (result_id,objective_id,rendered_body,provenance,created_at)
     VALUES ($1,$2,$3,$4::jsonb,now())`,
    [
      resultId,
      objectiveId,
      renderedBody,
      JSON.stringify([
        {
          stepIndex: 0,
          origin: "example.test",
          paymentRefHash: `0x${"b".repeat(64)}`,
          accepted: true,
        },
      ]),
    ],
  );
}
