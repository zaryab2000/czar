import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { setupDatabase } from "#test/db";
import { createTestContext, TEST_DEVICE_ID, TEST_TOKEN, TEST_USER_ID } from "#test/fixtures";

const getPool = setupDatabase();
const appToken = Buffer.alloc(32, 11).toString("base64url");
const appTokenHash = createHash("sha256").update(appToken).digest();

async function setupAppSession(pool: Awaited<ReturnType<typeof getPool>>): Promise<void> {
  await pool.query("INSERT INTO users (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [
    TEST_USER_ID,
  ]);
  await pool.query(
    `INSERT INTO sessions (token_hash,user_id,expires_at) VALUES ($1,$2,$3)
     ON CONFLICT (token_hash) DO UPDATE SET expires_at=EXCLUDED.expires_at`,
    [appTokenHash, TEST_USER_ID, new Date(Date.now() + 60 * 60_000)],
  );
}

function appHeaders(key?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${appToken}`,
    ...(key ? { "Idempotency-Key": key } : {}),
  };
}

describe("app device management", () => {
  it("issues a private, expiring code and replays it only for the same key", async () => {
    const pool = getPool();
    const context = createTestContext(pool);
    await setupAppSession(pool);
    const key = "7bd0c9be-b78e-4b24-a06c-7be2be7ef001";
    const first = await context.app.request("/v1/devices/pairing-codes", {
      method: "POST",
      headers: appHeaders(key),
    });
    const body = (await first.json()) as { code: string; expiresAt: string };
    expect(first.status).toBe(201);
    expect(body.code).toMatch(/^\d{8}$/);
    expect(Date.parse(body.expiresAt) - context.clock.now().getTime()).toBe(5 * 60_000);
    const stored = await pool.query("SELECT code_digest FROM pairing_codes");
    expect(stored.rows[0]?.code_digest).toEqual(createHash("sha256").update(body.code).digest());
    expect(context.logLines.join("\n")).not.toContain(body.code);
    const retry = await context.app.request("/v1/devices/pairing-codes", {
      method: "POST",
      headers: appHeaders(key),
    });
    expect(retry.status).toBe(201);
    await expect(retry.json()).resolves.toEqual(body);
    context.clock.advance(5 * 60_000);
    const paired = await context.app.request("/v1/devices/pair", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "7bd0c9be-b78e-4b24-a06c-7be2be7ef002",
      },
      body: JSON.stringify({ pairingCode: body.code, deviceName: "Expired", platform: "macos" }),
    });
    expect(paired.status).toBe(400);
  });

  it("lists only the session user's devices and returns 404 for foreign device revocation", async () => {
    const pool = getPool();
    const context = createTestContext(pool);
    await setupAppSession(pool);
    const foreignUser = "usr_01K7ZT9P4N5Q6R7S8T9V0W1X2Z";
    const foreignDevice = "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2Z";
    await pool.query("INSERT INTO users (user_id) VALUES ($1)", [foreignUser]);
    const ownerDeviceA = "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2A";
    const ownerDeviceB = "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2B";
    await pool.query(
      `INSERT INTO devices (device_id,user_id,device_name,platform,token_hash,created_at)
       VALUES ($1,$2,'Owner old','macos',$3,$5),($4,$2,'Owner new','linux',$6,$7)`,
      [
        ownerDeviceA,
        TEST_USER_ID,
        Buffer.alloc(32, 13),
        ownerDeviceB,
        "2026-10-21T00:00:00.0006Z",
        Buffer.alloc(32, 14),
        "2026-10-21T00:00:00.0007Z",
      ],
    );
    await pool.query(
      `INSERT INTO devices (device_id,user_id,device_name,platform,token_hash)
       VALUES ($1,$2,'Foreign','linux',$3)`,
      [foreignDevice, foreignUser, Buffer.alloc(32, 12)],
    );
    const list = await context.app.request("/v1/devices?limit=1", { headers: appHeaders() });
    const firstPage = (await list.json()) as {
      items: readonly { deviceId: string }[];
      nextCursor: string | null;
    };
    expect(list.status).toBe(200);
    expect(firstPage.items.map((device) => device.deviceId)).toEqual([ownerDeviceB]);
    expect(firstPage.nextCursor).not.toBeNull();
    const next = await context.app.request(
      `/v1/devices?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor ?? "")}`,
      { headers: appHeaders() },
    );
    const secondPage = (await next.json()) as {
      items: readonly { deviceId: string }[];
      nextCursor: string | null;
    };
    expect(secondPage.items.map((device) => device.deviceId)).toEqual([ownerDeviceA]);
    expect(secondPage.nextCursor).toBeNull();
    const revoke = await context.app.request(`/v1/devices/${foreignDevice}/revoke`, {
      method: "POST",
      headers: appHeaders("7bd0c9be-b78e-4b24-a06c-7be2be7ef003"),
    });
    expect(revoke.status).toBe(404);
  });

  it("revokes an owned device and refuses its token afterwards", async () => {
    const pool = getPool();
    const context = createTestContext(pool);
    await setupAppSession(pool);
    await pool.query(
      `INSERT INTO devices (device_id,user_id,device_name,platform,token_hash)
       VALUES ($1,$2,'Owner device','macos',$3)`,
      [TEST_DEVICE_ID, TEST_USER_ID, createHash("sha256").update(TEST_TOKEN).digest()],
    );
    const response = await context.app.request(`/v1/devices/${TEST_DEVICE_ID}/revoke`, {
      method: "POST",
      headers: appHeaders("7bd0c9be-b78e-4b24-a06c-7be2be7ef004"),
    });
    expect(response.status).toBe(204);
    const replay = await context.app.request(`/v1/devices/${TEST_DEVICE_ID}/revoke`, {
      method: "POST",
      headers: appHeaders("7bd0c9be-b78e-4b24-a06c-7be2be7ef004"),
    });
    expect(replay.status).toBe(204);
    const daemon = await context.app.request("/v1/objectives", {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(daemon.status).toBe(401);
    await expect(daemon.json()).resolves.toMatchObject({ czarCode: "device-revoked" });
  });

  it("requires idempotency keys and rejects malformed cursors", async () => {
    const pool = getPool();
    const context = createTestContext(pool);
    await setupAppSession(pool);
    const missingKey = await context.app.request("/v1/devices/pairing-codes", {
      method: "POST",
      headers: appHeaders(),
    });
    expect(missingKey.status).toBe(400);
    const malformedCursor = await context.app.request("/v1/devices?cursor=not-a-cursor", {
      headers: appHeaders(),
    });
    expect(malformedCursor.status).toBe(400);
  });
});
