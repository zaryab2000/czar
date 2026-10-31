import { createHash, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { registerRankingRefreshHandler } from "#src/evidence/ratings";
import { setupDatabase } from "#test/db";
import { createTestContext, seedDevice, TEST_NOW, TEST_TOKEN, TEST_USER_ID } from "#test/fixtures";

const getPool = setupDatabase();
const OBJECTIVE = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const RESULT = "res_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const VAULT = "0x1111111111111111111111111111111111111111";
const PAYEE = "0x3333333333333333333333333333333333333333";
const ALTERNATE_PAYEE = "0x4444444444444444444444444444444444444444";
const APP_OBJECTIVE = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2W";
const OLD_OBJECTIVE = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2V";
const EMPTY_OBJECTIVE = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2T";
const BAD_VAULT_OBJECTIVE = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2S";
const JOB_OBJECTIVE = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2R";
const FAILED_OBJECTIVE = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2P";
const OTHER_ENVELOPE_OBJECTIVE = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2N";
const CHANGED_VAULT_OBJECTIVE = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2M";
const ALTERNATE_OBJECTIVE = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2K";
const MIXED_PAYEE_OBJECTIVE = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2J";
const LOG_OBJECTIVE = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2H";
const REFRESH_OBJECTIVE = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2G";
const FOREIGN_OBJECTIVE = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Q";
const FOREIGN_USER = "usr_01K7ZT9P4N5Q6R7S8T9V0W1X2Z";
const FOREIGN_DEVICE = "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2Z";
const APP_SESSION = Buffer.alloc(32, 9).toString("base64url");

beforeAll(async () => {
  const pool = getPool();
  await seedDevice(pool);
  await pool.query("UPDATE users SET vault=$1 WHERE user_id=$2", [VAULT, TEST_USER_ID]);
  await pool.query(
    `INSERT INTO objectives
      (objective_id,user_id,device_id,submission,objective_hash,state,result_id)
     VALUES($1,$2,(SELECT device_id FROM devices WHERE user_id=$2 LIMIT 1),
       $3::jsonb,'0x' || repeat('a',64),'delivered',$4)`,
    [OBJECTIVE, TEST_USER_ID, JSON.stringify({ taskSpec: { kind: "table-fill" } }), RESULT],
  );
  await pool.query(
    `INSERT INTO results(result_id,objective_id,rendered_body,provenance,created_at)
     VALUES($1,$2,'private result',$3::jsonb,$4)`,
    [
      RESULT,
      OBJECTIVE,
      JSON.stringify([
        {
          stepIndex: 0,
          origin: "https://seller.example/path",
          accepted: true,
          paymentRefHash: `0x${"a".repeat(64)}`,
        },
        {
          stepIndex: 1,
          origin: "https://search.example",
          accepted: false,
          paymentRefHash: `0x${"b".repeat(64)}`,
        },
      ]),
      new Date(TEST_NOW.getTime() - 86_400_000),
    ],
  );
  await seedObservations(pool, OBJECTIVE, 20, 0);
  await seedResult(pool, APP_OBJECTIVE, new Date(TEST_NOW.getTime() - 2 * 86_400_000));
  await seedObservations(pool, APP_OBJECTIVE, 1, 100);
  await seedResult(pool, OLD_OBJECTIVE, new Date(TEST_NOW.getTime() - 14 * 86_400_000 - 1000));
  await seedObservations(pool, OLD_OBJECTIVE, 1, 200);
  await seedResult(pool, EMPTY_OBJECTIVE, new Date(TEST_NOW.getTime() - 86_400_000));
  await seedResult(pool, BAD_VAULT_OBJECTIVE, new Date(TEST_NOW.getTime() - 86_400_000));
  await seedObservations(pool, BAD_VAULT_OBJECTIVE, 1, 300);
  await pool.query("UPDATE observations SET vault=$1 WHERE objective_id=$2", [
    "0x2222222222222222222222222222222222222222",
    BAD_VAULT_OBJECTIVE,
  ]);
  await seedResult(pool, JOB_OBJECTIVE, new Date(TEST_NOW.getTime() - 86_400_000));
  await seedObservations(pool, JOB_OBJECTIVE, 1, 400);
  await pool.query(
    "UPDATE observations SET rail='erc8183-job',job_state='Submitted' WHERE objective_id=$1",
    [JOB_OBJECTIVE],
  );
  await seedResult(pool, FAILED_OBJECTIVE, TEST_NOW);
  await pool.query("UPDATE objectives SET state='failed' WHERE objective_id=$1", [
    FAILED_OBJECTIVE,
  ]);
  const newResultAt = new Date(TEST_NOW.getTime() - 7 * 86_400_000);
  await seedResult(pool, OTHER_ENVELOPE_OBJECTIVE, newResultAt);
  await seedObservations(pool, OTHER_ENVELOPE_OBJECTIVE, 1, 500);
  await pool.query("UPDATE objectives SET envelope_ref=$2 WHERE objective_id=$1", [
    OTHER_ENVELOPE_OBJECTIVE,
    `eip155:5042002:${VAULT}:9999`,
  ]);
  await seedResult(pool, CHANGED_VAULT_OBJECTIVE, newResultAt);
  await seedObservations(pool, CHANGED_VAULT_OBJECTIVE, 1, 600);
  await seedResult(pool, ALTERNATE_OBJECTIVE, newResultAt);
  await seedObservations(pool, ALTERNATE_OBJECTIVE, 1, 700);
  await replaceDedupPayee(pool, ALTERNATE_OBJECTIVE, 0, ALTERNATE_PAYEE);
  await seedResult(pool, MIXED_PAYEE_OBJECTIVE, newResultAt);
  await seedObservations(pool, MIXED_PAYEE_OBJECTIVE, 2, 800);
  await replaceDedupPayee(pool, MIXED_PAYEE_OBJECTIVE, 1, ALTERNATE_PAYEE);
  await seedResult(pool, LOG_OBJECTIVE, newResultAt);
  await seedObservations(pool, LOG_OBJECTIVE, 1, 900);
  await pool.query("INSERT INTO users(user_id,vault) VALUES($1,$2)", [FOREIGN_USER, VAULT]);
  await pool.query(
    `INSERT INTO devices(device_id,user_id,device_name,platform,token_hash)
     VALUES($1,$2,'Foreign','macos',$3)`,
    [FOREIGN_DEVICE, FOREIGN_USER, Buffer.alloc(32, 20)],
  );
  const foreignResult = FOREIGN_OBJECTIVE.replace("obj_", "res_");
  await pool.query(
    `INSERT INTO objectives
     (objective_id,user_id,device_id,submission,objective_hash,state,result_id)
     VALUES($1,$2,$3,'{}'::jsonb,'0x' || repeat('a',64),'delivered',$4)`,
    [FOREIGN_OBJECTIVE, FOREIGN_USER, FOREIGN_DEVICE, foreignResult],
  );
  await pool.query(
    `INSERT INTO results(result_id,objective_id,rendered_body,provenance)
     VALUES($1,$2,'private','[]'::jsonb)`,
    [foreignResult, FOREIGN_OBJECTIVE],
  );
  await pool.query(
    `INSERT INTO sessions(token_hash,user_id,expires_at)
     VALUES($1,$2,now()+interval '1 day')`,
    [createHash("sha256").update(APP_SESSION).digest(), TEST_USER_ID],
  );
});

describe("Flow 4A rating intake", () => {
  it("returns a committed rating when the post-commit refresh signal fails", async () => {
    const pool = getPool();
    await seedResult(pool, REFRESH_OBJECTIVE, TEST_NOW);
    await seedObservations(pool, REFRESH_OBJECTIVE, 1, 1000);
    const unregister = registerRankingRefreshHandler(() => {
      throw new Error("refresh signal failed");
    });
    try {
      const { app } = createTestContext(pool);
      const response = await postRating(app, {
        objectiveId: REFRESH_OBJECTIVE,
        stepIndex: 0,
        value: "good",
      });
      expect(response.status).toBe(202);
      expect(
        (await pool.query("SELECT rating_id FROM ratings WHERE objective_id=$1", [REFRESH_OBJECTIVE]))
          .rowCount,
      ).toBe(1);
    } finally {
      unregister();
    }
  });

  it("binds one owner judgement to all 20 settled calls, then allows one correction", async () => {
    const pool = getPool();
    const { app } = createTestContext(pool);
    const first = await postRating(app, { objectiveId: OBJECTIVE, stepIndex: 0, value: "good" });
    expect(first.status).toBe(202);
    const accepted = (await first.json()) as { ratingId: string; receipts: number };
    expect(accepted.receipts).toBe(20);
    expect(accepted.ratingId).toMatch(/^rtg_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(
      (await pool.query("SELECT rating_id FROM ratings WHERE objective_id=$1", [OBJECTIVE]))
        .rowCount,
    ).toBe(1);
    expect(
      (
        await pool.query("SELECT obs_id FROM rating_receipts WHERE rating_id=$1", [
          accepted.ratingId,
        ])
      ).rowCount,
    ).toBe(20);
    const prompt = await app.request(`/v1/objectives/${OBJECTIVE}/rating-prompt`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(prompt.status).toBe(200);
    await expect(prompt.json()).resolves.toMatchObject({
      steps: [
        {
          stepIndex: 0,
          merchantLabel: "seller.example",
          receipts: 20,
          effectiveRating: "good",
          canRate: false,
          canCorrect: true,
        },
      ],
    });
    const missing = await postRating(app, { objectiveId: OBJECTIVE, stepIndex: 0, value: "bad" });
    expect(missing.status).toBe(422);
    await expect(missing.json()).resolves.toMatchObject({ czarCode: "supersedes-required" });
    const second = await postRating(app, {
      objectiveId: OBJECTIVE,
      stepIndex: 0,
      value: "bad",
      supersedes: accepted.ratingId,
    });
    expect(second.status).toBe(202);
    const corrected = (await second.json()) as { ratingId: string };
    expect(
      (
        await pool.query("SELECT obs_id FROM rating_receipts WHERE rating_id=$1", [
          corrected.ratingId,
        ])
      ).rowCount,
    ).toBe(20);
    expect(
      (
        await pool.query("SELECT obs_id FROM rating_receipts WHERE rating_id=$1", [
          accepted.ratingId,
        ])
      ).rowCount,
    ).toBe(0);
    const effective = await pool.query<{ rating_id: string; value: string; supersedes: string }>(
      "SELECT rating_id,value,supersedes FROM ratings_effective WHERE objective_id=$1",
      [OBJECTIVE],
    );
    expect(effective.rows).toEqual([
      { rating_id: corrected.ratingId, value: "bad", supersedes: accepted.ratingId },
    ]);
    const original = await pool.query<{ value: string; supersedes: string | null }>(
      "SELECT value,supersedes FROM ratings WHERE rating_id=$1",
      [accepted.ratingId],
    );
    expect(original.rows).toEqual([{ value: "good", supersedes: null }]);
    expect(
      (
        await pool.query(
          "SELECT event_id FROM outbox_events WHERE name='rating.recorded' AND objective_id=$1",
          [OBJECTIVE],
        )
      ).rowCount,
    ).toBe(2);
    const finalPrompt = await app.request(`/v1/objectives/${OBJECTIVE}/rating-prompt`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    await expect(finalPrompt.json()).resolves.toMatchObject({
      steps: [{ effectiveRating: "bad", canRate: false, canCorrect: false }],
    });
    const third = await postRating(app, {
      objectiveId: OBJECTIVE,
      stepIndex: 0,
      value: "good",
      supersedes: corrected.ratingId,
    });
    expect(third.status).toBe(422);
    await expect(third.json()).resolves.toMatchObject({ czarCode: "bad-supersedes" });
  });

  it("returns ordered failures for non-producing step and another owner's objective", async () => {
    const { app } = createTestContext(getPool());
    const unproductive = await postRating(app, {
      objectiveId: OBJECTIVE,
      stepIndex: 1,
      value: "good",
    });
    expect(unproductive.status).toBe(422);
    await expect(unproductive.json()).resolves.toMatchObject({ czarCode: "not-producing" });
    const foreign = await postRating(app, {
      objectiveId: FOREIGN_OBJECTIVE,
      stepIndex: 0,
      value: "good",
    });
    expect(foreign.status).toBe(404);
    await expect(foreign.json()).resolves.toMatchObject({ czarCode: "unknown-objective" });
  });

  it("rejects empty settlement, wrong vault, closed window, and controlled owner", async () => {
    const pool = getPool();
    const { app } = createTestContext(pool);
    for (const [objectiveId, expectedCode, status] of [
      [EMPTY_OBJECTIVE, "nothing-settled", 409],
      [BAD_VAULT_OBJECTIVE, "not-your-payment", 403],
      [OLD_OBJECTIVE, "window-closed", 409],
      [JOB_OBJECTIVE, "nothing-settled", 409],
    ] as const) {
      const result = await postRating(app, { objectiveId, stepIndex: 0, value: "good" });
      expect(result.status).toBe(status);
      await expect(result.json()).resolves.toMatchObject({ czarCode: expectedCode });
    }
    await pool.query("UPDATE users SET controlled=true WHERE user_id=$1", [TEST_USER_ID]);
    try {
      const prompt = await app.request(`/v1/objectives/${APP_OBJECTIVE}/rating-prompt`, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      await expect(prompt.json()).resolves.toMatchObject({ steps: [{ canRate: false }] });
      const controlled = await postRating(app, {
        objectiveId: APP_OBJECTIVE,
        stepIndex: 1,
        value: "good",
      });
      expect(controlled.status).toBe(403);
      await expect(controlled.json()).resolves.toMatchObject({ czarCode: "controlled-user" });
    } finally {
      await pool.query("UPDATE users SET controlled=false WHERE user_id=$1", [TEST_USER_ID]);
    }
  });

  it("rates an escrow job only after its stored state is Completed", async () => {
    const pool = getPool();
    await pool.query("UPDATE observations SET job_state='Completed' WHERE objective_id=$1", [
      JOB_OBJECTIVE,
    ]);
    const { app } = createTestContext(pool);
    const response = await postRating(app, {
      objectiveId: JOB_OBJECTIVE,
      stepIndex: 0,
      value: "good",
    });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ receipts: 1 });
  });

  it("uses the historical objective envelope, not the owner's current vault", async () => {
    const pool = getPool();
    const { app } = createTestContext(pool);
    const wrongEnvelope = await postRating(app, {
      objectiveId: OTHER_ENVELOPE_OBJECTIVE,
      stepIndex: 0,
      value: "good",
    });
    expect(wrongEnvelope.status).toBe(403);
    await expect(wrongEnvelope.json()).resolves.toMatchObject({ czarCode: "not-your-payment" });
    await replaceDedupPayee(pool, OTHER_ENVELOPE_OBJECTIVE, 0, ALTERNATE_PAYEE);
    const alternateFromWrongEnvelope = await postRating(app, {
      objectiveId: OTHER_ENVELOPE_OBJECTIVE,
      stepIndex: 0,
      value: "good",
    });
    expect(alternateFromWrongEnvelope.status).toBe(403);
    await expect(alternateFromWrongEnvelope.json()).resolves.toMatchObject({
      czarCode: "not-your-payment",
    });
    await pool.query("UPDATE users SET vault=$1 WHERE user_id=$2", [
      "0x2222222222222222222222222222222222222222",
      TEST_USER_ID,
    ]);
    try {
      const historical = await postRating(app, {
        objectiveId: CHANGED_VAULT_OBJECTIVE,
        stepIndex: 0,
        value: "good",
      });
      expect(historical.status).toBe(202);
    } finally {
      await pool.query("UPDATE users SET vault=$1 WHERE user_id=$2", [VAULT, TEST_USER_ID]);
    }
  });

  it("does not attribute settled alternate-payee receipts to the primary supplier", async () => {
    const pool = getPool();
    const { app } = createTestContext(pool);
    const alternate = await postRating(app, {
      objectiveId: ALTERNATE_OBJECTIVE,
      stepIndex: 0,
      value: "good",
    });
    expect(alternate.status).toBe(409);
    await expect(alternate.json()).resolves.toMatchObject({ czarCode: "nothing-settled" });
    const mixed = await postRating(app, {
      objectiveId: MIXED_PAYEE_OBJECTIVE,
      stepIndex: 0,
      value: "good",
    });
    expect(mixed.status).toBe(202);
    await expect(mixed.json()).resolves.toMatchObject({ receipts: 1 });
    const bound = await pool.query<{ obs_id: string }>(
      `SELECT rr.obs_id FROM rating_receipts rr JOIN ratings r ON r.rating_id=rr.rating_id
       WHERE r.objective_id=$1`,
      [MIXED_PAYEE_OBJECTIVE],
    );
    expect(bound.rowCount).toBe(1);
    const alternateRow = await pool.query<{ settled_at: Date }>(
      "SELECT settled_at FROM observations WHERE objective_id=$1 AND call_index=1",
      [MIXED_PAYEE_OBJECTIVE],
    );
    expect(alternateRow.rows[0]?.settled_at).toBeInstanceOf(Date);
    const prompt = await app.request(`/v1/objectives/${ALTERNATE_OBJECTIVE}/rating-prompt`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    await expect(prompt.json()).resolves.toMatchObject({
      steps: [{ receipts: 0, canRate: false }],
    });
  });

  it("emits only structured enum/count rating events for prompts, posts, and corrections", async () => {
    const { app, logLines } = createTestContext(getPool());
    const prompt = await app.request(`/v1/objectives/${LOG_OBJECTIVE}/rating-prompt`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(prompt.status).toBe(200);
    const first = await postRating(app, {
      objectiveId: LOG_OBJECTIVE,
      stepIndex: 0,
      value: "good",
    });
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as { ratingId: string };
    const second = await postRating(app, {
      objectiveId: LOG_OBJECTIVE,
      stepIndex: 0,
      value: "bad",
      supersedes: firstBody.ratingId,
    });
    expect(second.status).toBe(202);
    const ratingEvents = logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter(
        (line) => typeof line["event"] === "string" && String(line["event"]).startsWith("ratings_"),
      );
    expect(ratingEvents).toEqual([
      expect.objectContaining({ event: "ratings_prompt_shown", surface: "cli", steps: 1 }),
      expect.objectContaining({ event: "ratings_posted", surface: "cli", value: "good" }),
      expect.objectContaining({ event: "ratings_posted", surface: "cli", value: "bad" }),
      expect.objectContaining({ event: "ratings_corrected", surface: "cli" }),
    ]);
    for (const event of ratingEvents) {
      expect(event["droppedFields"]).toBeUndefined();
      expect(JSON.stringify(event)).not.toContain(LOG_OBJECTIVE);
      expect(JSON.stringify(event)).not.toContain("seller.example");
    }
  });

  it("authenticates both surfaces, validates input, and replays a rating by key", async () => {
    const { app } = createTestContext(getPool());
    const body = { objectiveId: APP_OBJECTIVE, stepIndex: 0, value: "good" };
    const key = randomUUID();
    const appPost = (requestBody: object, requestKey: string) =>
      app.request("/v1/app/ratings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${APP_SESSION}`,
          "Content-Type": "application/json",
          "Idempotency-Key": requestKey,
        },
        body: JSON.stringify(requestBody),
      });
    expect((await app.request("/v1/app/ratings", { method: "POST" })).status).toBe(401);
    expect((await postRating(app, { ...body, stepIndex: -1 })).status).toBe(400);
    expect((await appPost(body, "not-a-uuid")).status).toBe(400);
    const first = await appPost(body, key);
    expect(first.status).toBe(202);
    const accepted = await first.json();
    expect((await appPost(body, key)).status).toBe(202);
    await expect((await appPost(body, key)).json()).resolves.toEqual(accepted);
    const conflict = await appPost({ ...body, value: "bad" }, key);
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ czarCode: "idempotency-conflict" });
  });

  it("pages private-free app result cards and rejects malformed cursors", async () => {
    const { app } = createTestContext(getPool());
    const get = (query: string) =>
      app.request(`/v1/app/results${query}`, {
        headers: { Authorization: `Bearer ${APP_SESSION}` },
      });
    expect((await get("?limit=0")).status).toBe(400);
    expect((await get("?cursor=not-a-cursor")).status).toBe(400);
    expect((await app.request("/v1/app/results")).status).toBe(401);
    const failedPrompt = await app.request(`/v1/objectives/${FAILED_OBJECTIVE}/rating-prompt`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(failedPrompt.status).toBe(404);
    const first = await get("?limit=2");
    expect(first.status).toBe(200);
    const page = (await first.json()) as { items: Record<string, unknown>[]; nextCursor: string };
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      kind: "table-fill",
      suppliers: [{ merchantLabel: "seller.example", receipts: 20 }],
    });
    expect(JSON.stringify(page)).not.toContain("private result");
    expect(JSON.stringify(page)).not.toContain("subjects");
    expect(page.nextCursor).toBeTruthy();
    const second = await get(`?limit=2&cursor=${page.nextCursor}`);
    expect(second.status).toBe(200);
    const next = (await second.json()) as { items: Record<string, unknown>[] };
    expect(next.items).toHaveLength(2);
    expect(next.items[0]?.["objectiveId"]).not.toBe(page.items[0]?.["objectiveId"]);
  });
});

async function seedResult(pool: Pool, objectiveId: string, createdAt: Date): Promise<void> {
  const resultId = objectiveId.replace("obj_", "res_");
  await pool.query(
    `INSERT INTO objectives
      (objective_id,user_id,device_id,submission,objective_hash,state,result_id)
     VALUES($1,$2,(SELECT device_id FROM devices WHERE user_id=$2 LIMIT 1),
       $3::jsonb,'0x' || repeat('a',64),'delivered',$4)`,
    [objectiveId, TEST_USER_ID, JSON.stringify({ taskSpec: { kind: "table-fill" } }), resultId],
  );
  await pool.query(
    `INSERT INTO results(result_id,objective_id,rendered_body,provenance,created_at)
     VALUES($1,$2,'private result',$3::jsonb,$4)`,
    [
      resultId,
      objectiveId,
      JSON.stringify([
        {
          stepIndex: 0,
          origin: "seller.example",
          accepted: true,
          paymentRefHash: `0x${"a".repeat(64)}`,
        },
      ]),
      createdAt,
    ],
  );
}

async function seedObservations(
  pool: Pool,
  objectiveId: string,
  count: number,
  offset: number,
): Promise<void> {
  const envelope = `eip155:5042002:${VAULT}:${offset + 1}`;
  const planId = objectiveId.replace("obj_", "pln_");
  await pool.query(
    `INSERT INTO plans(plan_id,objective_id,plan,plan_hash,payee_root,state)
     VALUES($1,$2,$3::jsonb,'0x' || repeat('a',64),'0x' || repeat('b',64),'approved')`,
    [planId, objectiveId, JSON.stringify({ steps: [{ stepIndex: 0, payee: PAYEE }] })],
  );
  await pool.query("UPDATE objectives SET plan_id=$2,envelope_ref=$3 WHERE objective_id=$1", [
    objectiveId,
    planId,
    envelope,
  ]);
  for (let index = 0; index < count; index += 1) {
    const obsId = `obs_${(index + offset).toString(16).padStart(32, "0")}`;
    await pool.query(
      `INSERT INTO observations
       (obs_id,user_id,vault,network,rail,service_id,version_id,task_class,objective_id,
        envelope_ref,step_index,call_index,payment_ref_hash,payment_id,dedup_key,settled_at)
       VALUES($1,$2,$3,'eip155:5042002','x402-exact','svc_seller','ver_1','table-fill',
         $4,$5,0,$6,'0x' || repeat('a',64),$7,$8,$9)`,
      [
        obsId,
        TEST_USER_ID,
        VAULT,
        objectiveId,
        envelope,
        index,
        `payment-${index + offset}`,
        `x402-exact:eip155:5042002:${VAULT}:${PAYEE}:0x${(index + offset + 1)
          .toString(16)
          .padStart(64, "0")}`,
        TEST_NOW,
      ],
    );
  }
}

async function replaceDedupPayee(
  pool: Pool,
  objectiveId: string,
  callIndex: number,
  payee: string,
): Promise<void> {
  const row = await pool.query<{ dedup_key: string }>(
    "SELECT dedup_key FROM observations WHERE objective_id=$1 AND call_index=$2",
    [objectiveId, callIndex],
  );
  const key = row.rows[0]?.dedup_key;
  if (!key) throw new Error("Seeded observation is missing its dedup key.");
  await pool.query("UPDATE observations SET dedup_key=$3 WHERE objective_id=$1 AND call_index=$2", [
    objectiveId,
    callIndex,
    key.replace(PAYEE, payee),
  ]);
}

function postRating(app: ReturnType<typeof createTestContext>["app"], body: object) {
  return app.request("/v1/ratings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TEST_TOKEN}`,
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    },
    body: JSON.stringify(body),
  });
}
