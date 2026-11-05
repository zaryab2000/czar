// UX-01 / SCR-181 tests 1–8: tasks a signed-in owner starts in the browser. The server builds the objective
// submission itself and runs the same intake as POST /v1/objectives. Runs against Postgres 16.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import { H } from "@czar/hashing";
import { validateSchema } from "@czar/schemas";
import { setupDatabase } from "#test/db";
import { createTestContext, TEST_NOW, testAppConfig } from "#test/fixtures";

const getPool = setupDatabase();
const SOURCE =
  "contract Vault { function withdraw() public { payable(msg.sender).transfer(address(this).balance); } }";
const ADDRESS = "0x00000000000000000000000000000000000000c0";
const NO_SOUL = H("czar.web-objective.no-soul.v1");

let sequence = 0;
/** A fresh Crockford id per call, so tests sharing one database never collide. */
const nextId = (prefix: string) => {
  sequence += 1;
  return `${prefix}_01K8${String(sequence).padStart(22, "0")}`;
};

async function seedOwner(pool: Pool, options: { vault?: boolean } = {}) {
  const userId = nextId("usr");
  const token = randomBytes(32).toString("base64url");
  await pool.query("INSERT INTO users (user_id,vault) VALUES ($1,$2)", [
    userId,
    options.vault === false ? null : "0x00000000000000000000000000000000000000aa",
  ]);
  await pool.query(
    "INSERT INTO sessions (token_hash,user_id,expires_at) VALUES ($1,$2,now()+interval '1 day')",
    [createHash("sha256").update(token).digest(), userId],
  );
  return { userId, token };
}

const auditBody = (overrides: Record<string, unknown> = {}) => ({
  kind: "smart-contract-audit",
  title: "Vault audit",
  description: "Check the withdraw path.",
  contractSource: SOURCE,
  ...overrides,
});

type TestApp = ReturnType<typeof createTestContext>["app"];

function post(app: TestApp, token: string | undefined, body: unknown, key: string = randomUUID()) {
  return app.request("/v1/app/objectives", {
    method: "POST",
    headers: {
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify(body),
  });
}

const get = (app: TestApp, token: string, path: string) =>
  app.request(path, { headers: { Authorization: `Bearer ${token}` } });

async function storedObjective(pool: Pool, objectiveId: string) {
  const rows = await pool.query<{
    submission: Record<string, unknown>;
    objective_hash: string;
    device_id: string;
    state: string;
  }>("SELECT submission,objective_hash,device_id,state FROM objectives WHERE objective_id=$1", [
    objectiveId,
  ]);
  const row = rows.rows[0];
  if (row === undefined) throw new Error(`objective ${objectiveId} was not stored`);
  return row;
}

describe("browser objectives (SCR-181)", () => {
  let app: TestApp;
  beforeAll(() => {
    app = createTestContext(getPool()).app;
  });

  it("needs a session for every route, and hides other users' objectives (test 1)", async () => {
    const owner = await seedOwner(getPool());
    const stranger = await seedOwner(getPool());
    expect((await post(app, undefined, auditBody())).status).toBe(401);
    expect((await app.request("/v1/app/objectives")).status).toBe(401);
    const created = await post(app, owner.token, auditBody());
    expect(created.status).toBe(201);
    const { objectiveId } = (await created.json()) as { objectiveId: string };
    expect((await app.request(`/v1/app/objectives/${objectiveId}`)).status).toBe(401);
    expect((await get(app, stranger.token, `/v1/app/objectives/${objectiveId}`)).status).toBe(404);
    const strangerList = (await (await get(app, stranger.token, "/v1/app/objectives")).json()) as {
      items: unknown[];
    };
    expect(strangerList.items).toEqual([]);
  });

  it.each([
    ["both a source and an address", auditBody({ contractAddress: ADDRESS })],
    ["neither a source nor an address", auditBody({ contractSource: undefined })],
    ["an empty source and no address", auditBody({ contractSource: "" })],
    ["a source over app.objectiveMaxSourceChars", auditBody({ contractSource: "a".repeat(2001) })],
    ["a malformed address", auditBody({ contractSource: undefined, contractAddress: "0x12" })],
    ["an unknown kind", auditBody({ kind: "web-search" })],
    ["an empty title", auditBody({ title: "" })],
    ["an unknown field", auditBody({ priority: "high" })],
    ["a malformed budget", auditBody({ maxTotal: "1.5" })],
  ])("refuses %s with 400 (test 2)", async (_name, body) => {
    const owner = await seedOwner(getPool());
    const response = await post(app, owner.token, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ czarCode: "validation" });
  });

  it("refuses a request without an Idempotency-Key", async () => {
    const owner = await seedOwner(getPool());
    const response = await app.request("/v1/app/objectives", {
      method: "POST",
      headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(auditBody()),
    });
    expect(response.status).toBe(400);
  });

  it("replays the same key and body, and refuses the same key with another body (test 3)", async () => {
    const owner = await seedOwner(getPool());
    const key = randomUUID();
    const first = await post(app, owner.token, auditBody(), key);
    const second = await post(app, owner.token, auditBody(), key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstBody = (await first.json()) as { objectiveId: string; state: string };
    expect(firstBody.state).toBe("received");
    expect(await second.json()).toEqual(firstBody);
    const conflict = await post(app, owner.token, auditBody({ title: "Another audit" }), key);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ czarCode: "idempotency-conflict" });
    const count = await getPool().query("SELECT 1 FROM objectives WHERE user_id=$1", [
      owner.userId,
    ]);
    expect(count.rowCount).toBe(1);
  });

  it("creates exactly one web device per user, which no token can use (test 4)", async () => {
    const owner = await seedOwner(getPool());
    const first = (await (await post(app, owner.token, auditBody())).json()) as {
      objectiveId: string;
    };
    const second = (await (
      await post(app, owner.token, auditBody({ title: "Second audit" }))
    ).json()) as { objectiveId: string };
    const devices = await getPool().query<{
      device_id: string;
      device_name: string;
      token_hash: Buffer;
    }>("SELECT device_id,device_name,token_hash FROM devices WHERE user_id=$1 AND platform='web'", [
      owner.userId,
    ]);
    expect(devices.rows).toHaveLength(1);
    const device = devices.rows[0];
    expect(device?.device_name).toBe("Browser");
    expect(device?.token_hash).toHaveLength(32);
    expect(device?.token_hash.equals(createHash("sha256").update(owner.token).digest())).toBe(
      false,
    );
    for (const objectiveId of [first.objectiveId, second.objectiveId])
      expect((await storedObjective(getPool(), objectiveId)).device_id).toBe(device?.device_id);
    // The session token is not a device token: the daemon route refuses it.
    const daemon = await app.request("/v1/objectives", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${owner.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: "{}",
    });
    expect(daemon.status).toBe(401);
  });

  it("stores a submission built by the server through the same intake, with one outbox event (test 5)", async () => {
    const owner = await seedOwner(getPool());
    const response = await post(app, owner.token, auditBody({ maxTotal: "1500000" }));
    const { objectiveId } = (await response.json()) as { objectiveId: string };
    const row = await storedObjective(getPool(), objectiveId);
    expect(validateSchema("objective-submission", row.submission)).toBe(true);
    expect(row.objective_hash).toBe(row.submission["objectiveHash"]);
    expect(row.state).toBe("received");
    expect(row.submission).toMatchObject({
      schemaVersion: "1.0",
      objectiveId,
      deviceId: row.device_id,
      soulVersionHash: NO_SOUL,
      observationHashes: [],
      detector: "placeholder",
      goal: "Check the withdraw path.",
      capabilities: ["code-review"],
      minutesSaved: 60,
      hourlyBand: "C",
      constraints: { maxTotal: "1500000" },
      redaction: { layer2: { hits: 0, entities: [] } },
      submittedAt: TEST_NOW.toISOString(),
      taskSpec: {
        schemaVersion: "1.1",
        kind: "list-fill",
        topic: "Vault audit",
        subjects: [{ label: "Vault audit" }],
        fields: ["severity", "location", "issue", "fix"],
        context: SOURCE,
        sourceTrust: "user-prompt",
        output: { format: "json", formatSource: "default" },
      },
    });
    const outbox = await getPool().query(
      "SELECT 1 FROM outbox_events WHERE name='objective.received' AND objective_id=$1",
      [objectiveId],
    );
    expect(outbox.rowCount).toBe(1);
  });

  it("builds an address task with the address as its subject, no context, and the default goal", async () => {
    const owner = await seedOwner(getPool());
    const response = await post(
      app,
      owner.token,
      auditBody({ contractSource: undefined, contractAddress: ADDRESS, description: "" }),
    );
    expect(response.status).toBe(201);
    const { objectiveId } = (await response.json()) as { objectiveId: string };
    const { submission } = await storedObjective(getPool(), objectiveId);
    expect(submission["goal"]).toBe("Audit Vault audit");
    const taskSpec = submission["taskSpec"] as Record<string, unknown>;
    expect(taskSpec["subjects"]).toEqual([{ label: ADDRESS }]);
    expect(taskSpec).not.toHaveProperty("context");
    expect(validateSchema("objective-submission", submission)).toBe(true);
  });

  it("removes secrets with layer 1 before anything is stored (test 6)", async () => {
    const owner = await seedOwner(getPool());
    const secret = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`;
    const response = await post(
      app,
      owner.token,
      auditBody({
        description: `Use token ${secret} if needed.`,
        contractSource: `// deploy key ${secret}\n${SOURCE}`,
      }),
    );
    expect(response.status).toBe(201);
    const { objectiveId } = (await response.json()) as { objectiveId: string };
    const { submission } = await storedObjective(getPool(), objectiveId);
    expect(JSON.stringify(submission)).not.toContain(secret);
    expect(String((submission["taskSpec"] as Record<string, unknown>)["context"])).toContain(
      "withdraw",
    );
  });

  it("answers 403 with a plain message when the user has no wallet yet (test 8)", async () => {
    const owner = await seedOwner(getPool(), { vault: false });
    const response = await post(app, owner.token, auditBody());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      czarCode: "no-vault",
      detail: "Create your wallet first",
    });
  });

  it("lists web and device tasks together, newest first, each with its origin", async () => {
    const pool = getPool();
    const owner = await seedOwner(pool);
    const deviceId = nextId("dev");
    const deviceObjective = nextId("obj");
    await pool.query(
      `INSERT INTO devices (device_id,user_id,device_name,platform,token_hash)
       VALUES ($1,$2,'Laptop','macos',$3)`,
      [deviceId, owner.userId, randomBytes(32)],
    );
    await pool.query(
      `INSERT INTO objectives (objective_id,user_id,device_id,submission,objective_hash,state,created_at,updated_at)
       VALUES ($1,$2,$3,$4::jsonb,'0x' || repeat('b',64),'planning',$5,$5)`,
      [
        deviceObjective,
        owner.userId,
        deviceId,
        JSON.stringify({
          capabilities: ["web-search"],
          taskSpec: { kind: "table-fill", topic: "Vendor pricing" },
        }),
        new Date(TEST_NOW.getTime() - 3_600_000),
      ],
    );
    const created = (await (await post(app, owner.token, auditBody())).json()) as {
      objectiveId: string;
    };
    const list = await get(app, owner.token, "/v1/app/objectives");
    expect(list.status).toBe(200);
    const page = (await list.json()) as { items: Record<string, unknown>[]; nextCursor: null };
    expect(page.nextCursor).toBeNull();
    expect(page.items).toEqual([
      {
        objectiveId: created.objectiveId,
        title: "Vault audit",
        kind: "smart-contract-audit",
        state: "received",
        createdAt: TEST_NOW.toISOString(),
        updatedAt: TEST_NOW.toISOString(),
        origin: "web",
      },
      {
        objectiveId: deviceObjective,
        title: "Vendor pricing",
        kind: "table-fill",
        state: "planning",
        createdAt: new Date(TEST_NOW.getTime() - 3_600_000).toISOString(),
        updatedAt: new Date(TEST_NOW.getTime() - 3_600_000).toISOString(),
        origin: "device",
      },
    ]);
    for (const item of page.items) expect(validateSchema("app-objective", item)).toBe(true);
    const one = await get(app, owner.token, `/v1/app/objectives/${created.objectiveId}`);
    expect(await one.json()).toEqual(page.items[0]);
  });

  it("pages with limit and cursor, and refuses a limit over 50 or a malformed cursor", async () => {
    const owner = await seedOwner(getPool());
    for (const title of ["One", "Two", "Three"])
      expect((await post(app, owner.token, auditBody({ title }))).status).toBe(201);
    expect((await get(app, owner.token, "/v1/app/objectives?limit=51")).status).toBe(400);
    expect((await get(app, owner.token, "/v1/app/objectives?cursor=nope")).status).toBe(400);
    const first = (await (await get(app, owner.token, "/v1/app/objectives?limit=2")).json()) as {
      items: { title: string }[];
      nextCursor: string;
    };
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = (await (
      await get(app, owner.token, `/v1/app/objectives?limit=2&cursor=${first.nextCursor}`)
    ).json()) as { items: { title: string }[]; nextCursor: string | null };
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect([...first.items, ...second.items].map((item) => item.title).toSorted()).toEqual(
      ["One", "Three", "Two"].toSorted(),
    );
  });

  it("blocks browser tasks once the web device is revoked, until the owner signs in again", async () => {
    const pool = getPool();
    const owner = await seedOwner(pool);
    expect((await post(app, owner.token, auditBody())).status).toBe(201);
    await pool.query("UPDATE devices SET revoked_at=now() WHERE user_id=$1 AND platform='web'", [
      owner.userId,
    ]);
    const blocked = await post(app, owner.token, auditBody({ title: "After revoke" }));
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ czarCode: "device-revoked" });
    // A new sign-in is a session created after the revocation.
    const fresh = randomBytes(32).toString("base64url");
    await pool.query(
      "INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES ($1,$2,now()+interval '1 day',now()+interval '1 second')",
      [createHash("sha256").update(fresh).digest(), owner.userId],
    );
    expect((await post(app, fresh, auditBody({ title: "After sign-in" }))).status).toBe(201);
  });
});

describe("browser objective rate limit (SCR-181 test 7)", () => {
  it("refuses the request over app.webObjectivesPerUserPerHour, and allows it again an hour later", async () => {
    const context = createTestContext(getPool(), {
      config: testAppConfig({ "app.webObjectivesPerUserPerHour": 2 }),
    });
    const owner = await seedOwner(getPool());
    expect((await post(context.app, owner.token, auditBody({ title: "1" }))).status).toBe(201);
    expect((await post(context.app, owner.token, auditBody({ title: "2" }))).status).toBe(201);
    const limited = await post(context.app, owner.token, auditBody({ title: "3" }));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ czarCode: "rate-limited" });
    context.clock.advance(3_600_001);
    expect((await post(context.app, owner.token, auditBody({ title: "4" }))).status).toBe(201);
  });
});
