import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { validateRecordedExchange } from "@czar/api-contract";
import { setupDatabase } from "#test/db";
import {
  createTestContext,
  makeObjectiveSubmission,
  seedDevice,
  seedPairingCode,
  TEST_TOKEN,
  TEST_USER_ID,
} from "#test/fixtures";

const getPool = setupDatabase();
const idempotencyKey = "4f4e8c7d-94a3-4c6a-8f77-6db94f240c0a";

describe("CZ-12 daemon routes", () => {
  let context: ReturnType<typeof createTestContext>;

  beforeAll(async () => {
    const pool = getPool();
    context = createTestContext(pool);
    await seedDevice(pool);
    await seedPairingCode(pool, "00000042");
  });

  it("healthCheck_reportsDatabaseReadiness", async () => {
    const response = await context.app.request("/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("malformedJson_problemUsesRfc9457AndNoSensitiveDetail", async () => {
    const response = await context.app.request("/v1/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: "{not-json",
    });
    const body = (await response.json()) as any;
    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Type")).toContain("application/problem+json");
    expect(body.type).toBe("https://czar.dev/problems/validation");
    expect(body.czarCode).toBe("validation");
    expect(
      validateRecordedExchange("listObjectives", {
        responseStatus: response.status,
        responseBody: body,
      }).valid,
    ).toBe(true);
    expect(body.detail).not.toContain("not-json");
    expectRateHeaders(response);
  });

  it("pairDevice_openapiRequestAnd201Response", async () => {
    const response = await context.app.request("/v1/devices/pair", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        pairingCode: "00000042",
        deviceName: "New device",
        platform: "macos",
      }),
    });
    const body = (await response.json()) as any;
    expect(response.status).toBe(201);
    expect(Object.keys(body).toSorted()).toEqual(["deviceId", "deviceToken"]);
    expect(
      validateRecordedExchange("pairDevice", {
        requestBody: { pairingCode: "00000042", deviceName: "New device", platform: "macos" },
        responseStatus: response.status,
        responseBody: body,
      }).valid,
    ).toBe(true);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expectRateHeaders(response);
    const persisted = await getPool().query("SELECT token_hash FROM devices WHERE device_id = $1", [
      body.deviceId,
    ]);
    expect(persisted.rows[0]?.token_hash).toHaveLength(32);
    expect(persisted.rows[0]?.token_hash).not.toEqual(Buffer.from(body.deviceToken));
    expect(context.logLines.join("\n")).not.toContain("00000042");
    expect(context.logLines.join("\n")).not.toContain(body.deviceToken);
  });

  it("pairDevice_rejectsInvalidFieldsAndMissingIdempotencyKey", async () => {
    const valid = { pairingCode: "00000042", deviceName: "Desk", platform: "macos" };
    const requests = [
      { body: { ...valid, platform: "unknown" }, key: "fd4e9558-9c23-4fe4-afcf-a14068311001" },
      { body: { ...valid, deviceName: "" }, key: "fd4e9558-9c23-4fe4-afcf-a14068311002" },
      { body: { ...valid, pairingCode: "bad" }, key: "fd4e9558-9c23-4fe4-afcf-a14068311003" },
      { body: valid },
    ];
    for (const request of requests) {
      const response = await context.app.request("/v1/devices/pair", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(request.key ? { "Idempotency-Key": request.key } : {}),
        },
        body: JSON.stringify(request.body),
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("Content-Type")).toContain("application/problem+json");
    }
  });

  it("pairReplay_neverReturnsBearer", async () => {
    const request = {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        pairingCode: "00000042",
        deviceName: "New device",
        platform: "macos",
      }),
    } as const;
    const response = await context.app.request("/v1/devices/pair", request);
    const body = (await response.json()) as any;
    expect(response.status).toBe(409);
    expect(body.czarCode).toBe("replay-not-stored");
    expect(body.deviceToken).toBeUndefined();
    expect(
      validateRecordedExchange("pairDevice", {
        requestBody: JSON.parse(request.body),
        responseStatus: response.status,
        responseBody: body,
      }).valid,
    ).toBe(true);
  });

  it("listObjectives_openapiPage", async () => {
    const response = await context.app.request("/v1/objectives?limit=50", {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const body = (await response.json()) as any;
    expect(response.status).toBe(200);
    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBeNull();
    expect(
      validateRecordedExchange("listObjectives", {
        responseStatus: response.status,
        responseBody: body,
      }).valid,
    ).toBe(true);
    expectRateHeaders(response);
  });

  it("listObjectives_cursorPagesOwnDeviceInStableOrder", async () => {
    const pool = getPool();
    const firstId = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
    const secondId = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Z";
    await pool.query(
      `INSERT INTO objectives (objective_id,user_id,device_id,submission,objective_hash,state,created_at,updated_at)
       VALUES ($1,$2,$3,'{}','0x' || repeat('a',64),'received',$4,$4),
              ($5,$2,$3,'{}','0x' || repeat('b',64),'planning',$4,$4)`,
      [
        firstId,
        "usr_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
        "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
        new Date("2026-10-21T00:00:00Z"),
        secondId,
      ],
    );
    const foreignToken = Buffer.alloc(32, 8).toString("base64url");
    const foreignUser = "usr_01K7ZT9P4N5Q6R7S8T9V0W1X2Z";
    const foreignDevice = "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2Z";
    await pool.query("INSERT INTO users (user_id) VALUES ($1)", [foreignUser]);
    await pool.query(
      `INSERT INTO devices (device_id,user_id,device_name,platform,token_hash)
       VALUES ($1,$2,'Other device','linux',$3)`,
      [foreignDevice, foreignUser, createHash("sha256").update(foreignToken).digest()],
    );
    await pool.query(
      `INSERT INTO objectives (objective_id,user_id,device_id,submission,objective_hash,state,created_at,updated_at)
       VALUES ('obj_01K7ZT9P4N5Q6R7S8T9V0W1X2A',$1,$2,'{}','0x' || repeat('c',64),'received',$3,$3)`,
      [foreignUser, foreignDevice, new Date("2026-10-21T00:00:00Z")],
    );
    const foreignPage = await context.app.request("/v1/objectives", {
      headers: { Authorization: `Bearer ${foreignToken}` },
    });
    const foreignBody = (await foreignPage.json()) as any;
    expect(foreignBody.items).toHaveLength(1);
    expect(foreignBody.items[0].objectiveId).toBe("obj_01K7ZT9P4N5Q6R7S8T9V0W1X2A");
    const pageOne = await context.app.request("/v1/objectives?limit=1", {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const first = (await pageOne.json()) as any;
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const pageTwo = await context.app.request(`/v1/objectives?limit=1&cursor=${first.nextCursor}`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const second = (await pageTwo.json()) as any;
    expect(second.items).toHaveLength(1);
    expect(second.items[0].objectiveId).not.toBe(first.items[0].objectiveId);
    expect(second.nextCursor).toBeNull();
    const otherCursorPage = await context.app.request("/v1/objectives?limit=1", {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const otherCursorBody = (await otherCursorPage.json()) as any;
    const changedFilter = await context.app.request(
      `/v1/objectives?limit=1&status=received&cursor=${otherCursorBody.nextCursor}`,
      { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
    );
    expect(changedFilter.status).toBe(400);
    const cursorHash = createHash("sha256").update(otherCursorBody.nextCursor).digest();
    await pool.query("UPDATE objective_cursors SET expires_at=$1 WHERE cursor_hash=$2", [
      new Date("2026-10-20T00:00:00Z"),
      cursorHash,
    ]);
    const expiredCursor = await context.app.request(
      `/v1/objectives?limit=1&cursor=${otherCursorBody.nextCursor}`,
      { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
    );
    expect(expiredCursor.status).toBe(400);
  });

  it("getObjective_openapi200Or404", async () => {
    const pool = getPool();
    const ownedId = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2R";
    const foreignUser = "usr_01K7ZT9P4N5Q6R7S8T9V0W1X2Z";
    const foreignDevice = "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2Z";
    const foreignId = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2M";
    await pool.query(
      "INSERT INTO objectives (objective_id,user_id,device_id,submission,objective_hash,state) VALUES ($1,$2,$3,'{}',$4,'received')",
      [
        ownedId,
        "usr_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
        "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
        `0x${"1".repeat(64)}`,
      ],
    );
    await pool.query("INSERT INTO users (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [
      foreignUser,
    ]);
    await pool.query(
      "INSERT INTO devices (device_id,user_id,device_name,platform,token_hash) VALUES ($1,$2,'Other','linux',$3) ON CONFLICT DO NOTHING",
      [foreignDevice, foreignUser, Buffer.alloc(32, 9)],
    );
    await pool.query(
      "INSERT INTO objectives (objective_id,user_id,device_id,submission,objective_hash,state) VALUES ($1,$2,$3,'{}',$4,'received')",
      [foreignId, foreignUser, foreignDevice, `0x${"2".repeat(64)}`],
    );
    const ownResponse = await context.app.request(`/v1/objectives/${ownedId}`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const ownBody = await ownResponse.json();
    expect(ownResponse.status).toBe(200);
    expect(
      validateRecordedExchange("getObjective", {
        responseStatus: ownResponse.status,
        responseBody: ownBody,
      }).valid,
    ).toBe(true);
    const response = await context.app.request("/v1/objectives/obj_01K7ZT9P4N5Q6R7S8T9V0W1X2W", {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const body = (await response.json()) as any;
    const foreign = await context.app.request(`/v1/objectives/${foreignId}`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(response.status).toBe(404);
    expect(foreign.status).toBe(404);
    const foreignBody = (await foreign.json()) as Record<string, unknown>;
    expect(foreignBody).toMatchObject({
      type: body.type,
      title: body.title,
      status: body.status,
      detail: body.detail,
      czarCode: body.czarCode,
      retryable: body.retryable,
    });
    expect(
      validateRecordedExchange("getObjective", {
        responseStatus: response.status,
        responseBody: body,
      }).valid,
    ).toBe(true);
    expectRateHeaders(response);
  });

  it("auth_unknownRevokedAndForeignDevice", async () => {
    const response = await context.app.request("/v1/objectives", {
      headers: { Authorization: "Bearer unknown-token" },
    });
    const body = (await response.json()) as any;
    expect(response.status).toBe(401);
    expect(body.czarCode).toBe("validation");
    expect(response.headers.get("RateLimit-Limit")).toBe("600");
    expectRateHeaders(response);
    await getPool().query("UPDATE devices SET revoked_at=$1 WHERE device_id=$2", [
      new Date("2026-10-21T00:00:00Z"),
      "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
    ]);
    const revoked = await context.app.request("/v1/objectives", {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const revokedBody = (await revoked.json()) as any;
    expect(revoked.status).toBe(401);
    expect(revokedBody.czarCode).toBe("device-revoked");
    expect(
      validateRecordedExchange("listObjectives", {
        responseStatus: revoked.status,
        responseBody: revokedBody,
      }).valid,
    ).toBe(true);
  });

  it("problem_allS1ErrorsMatchOpenAPI", async () => {
    const cases = [
      {
        operationId: "pairDevice",
        request: () =>
          context.app.request("/v1/devices/pair", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
            body: "{bad",
          }),
        requestBody: { pairingCode: "00000000", deviceName: "Desk", platform: "macos" },
      },
      {
        operationId: "submitObjective",
        requestBody: makeObjectiveSubmission("obj_01K7ZT9P4N5Q6R7S8T9V0W1X2B"),
        request: () =>
          context.app.request("/v1/objectives", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
            body: JSON.stringify(makeObjectiveSubmission("obj_01K7ZT9P4N5Q6R7S8T9V0W1X2B")),
          }),
      },
      {
        operationId: "listObjectives",
        request: () =>
          context.app.request("/v1/objectives?cursor=invalid", {
            headers: { Authorization: `Bearer ${TEST_TOKEN}` },
          }),
      },
      {
        operationId: "getObjective",
        request: () =>
          context.app.request("/v1/objectives/obj_01K7ZT9P4N5Q6R7S8T9V0W1X2W", {
            headers: { Authorization: `Bearer ${TEST_TOKEN}` },
          }),
      },
    ];
    for (const sample of cases) {
      const response = await sample.request();
      const body = await response.json();
      expect(response.headers.get("Content-Type")).toContain("application/problem+json");
      const validation = validateRecordedExchange(sample.operationId, {
        ...(sample.requestBody ? { requestBody: sample.requestBody } : {}),
        responseStatus: response.status,
        responseBody: body,
      });
      expect(
        validation.valid,
        `${sample.operationId} ${response.status}: ${JSON.stringify(validation.errors)}`,
      ).toBe(true);
    }
  });

  it("privacy_logsNeverContainSensitiveCorpus", async () => {
    await getPool().query("UPDATE devices SET revoked_at=NULL WHERE device_id=$1", [
      "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
    ]);
    const corpus = [
      "goal-6df42c",
      "fake-secret-7ce9",
      "00000042",
      TEST_TOKEN,
      "a.person@example.com",
      "/Users/private/file.txt",
    ];
    const submission = makeObjectiveSubmission("obj_01K7ZT9P4N5Q6R7S8T9V0W1X2C", {
      goal: corpus.join(" "),
      subject: corpus.join(" "),
    });
    const response = await context.app.request("/v1/objectives", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "de4458a2-e2e4-4af8-91f8-83e5762125ee",
      },
      body: JSON.stringify(submission),
    });
    const body = await response.text();
    const logs = context.logLines.join("\n");
    for (const secret of corpus) {
      expect(logs).not.toContain(secret);
      expect(body).not.toContain(secret);
    }
    expect(response.status).toBe(202);
    const objectiveRows = await getPool().query(
      "SELECT count(*)::int AS count FROM objectives WHERE submission::text LIKE $1",
      ["%goal-6df42c%"],
    );
    expect(objectiveRows.rows[0]?.count).toBe(1);
    const otherRows = await getPool().query(
      `SELECT
       (SELECT count(*) FROM idempotency WHERE response_body::text LIKE $1) +
       (SELECT count(*) FROM outbox_events WHERE payload::text LIKE $1) AS count`,
      ["%goal-6df42c%"],
    );
    expect(Number(otherRows.rows[0]?.count)).toBe(0);
  });
});

describe("CZ-22 app read routes", () => {
  it("getSoulPointer_returnsUnavailableDesktopNoticeForAppSession", async () => {
    const pool = getPool();
    const appToken = Buffer.alloc(32, 21).toString("base64url");
    const tokenHash = createHash("sha256").update(appToken).digest();
    await pool.query("INSERT INTO users (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [
      TEST_USER_ID,
    ]);
    await pool.query(
      `INSERT INTO sessions (token_hash,user_id,expires_at)
       VALUES ($1,$2,now()+interval '24 hours')`,
      [tokenHash, TEST_USER_ID],
    );
    const context = createTestContext(pool);
    const response = await context.app.request("/v1/soul/pointer", {
      headers: { Authorization: `Bearer ${appToken}` },
    });
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body["available"]).toBe(false);
    expect(body["desktopUrl"]).toBe("http://127.0.0.1/soul");
    expect(String(body["message"]).length).toBeLessThanOrEqual(200);
    expect(
      validateRecordedExchange("getSoulPointer", {
        responseStatus: response.status,
        responseBody: body,
      }).valid,
    ).toBe(true);
  });
});

function expectRateHeaders(response: Response): void {
  expect(response.headers.get("RateLimit-Limit")).not.toBeNull();
  expect(response.headers.get("RateLimit-Remaining")).not.toBeNull();
  expect(response.headers.get("RateLimit-Reset")).not.toBeNull();
}
