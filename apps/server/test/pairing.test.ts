import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { setupDatabase } from "#test/db";
import { createTestContext, seedPairingCode, TEST_USER_ID } from "#test/fixtures";
import { issuePairingCode } from "#src/devices/pair";
import { loadConfig } from "@czar/config";

const getPool = setupDatabase();
const config = loadConfig();

describe("device pairing", () => {
  it("pairCode_isSingleUse_andOnlyDigestIsStored", async () => {
    const pool = getPool();
    const context = createTestContext(pool);
    await seedPairingCode(pool, "00000017");
    const request = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "00000000-0000-4000-8000-000000000017",
      },
      body: JSON.stringify({ pairingCode: "00000017", deviceName: "Pair test", platform: "linux" }),
    } as const;
    const first = await context.app.request("/v1/devices/pair", request);
    const payload = (await first.json()) as { deviceToken: string };
    expect(first.status).toBe(201);
    const saved = await pool.query(
      "SELECT token_hash FROM devices WHERE device_name = 'Pair test'",
    );
    expect(saved.rows[0]?.token_hash).toEqual(
      createHash("sha256").update(payload.deviceToken).digest(),
    );
    const retry = await context.app.request("/v1/devices/pair", {
      ...request,
      headers: { ...request.headers, "Idempotency-Key": "00000000-0000-4000-8000-000000000018" },
    });
    expect(retry.status).toBe(400);
  });

  it("pairCode_concurrentConsumptionCreatesOneDevice", async () => {
    const pool = getPool();
    const context = createTestContext(pool);
    await seedPairingCode(pool, "00000020");
    const makeRequest = (key: string) =>
      context.app.request("/v1/devices/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({
          pairingCode: "00000020",
          deviceName: "Concurrent",
          platform: "windows",
        }),
      });
    const responses = await Promise.all([
      makeRequest("00000000-0000-4000-8000-000000000021"),
      makeRequest("00000000-0000-4000-8000-000000000022"),
    ]);
    expect(responses.map((response) => response.status).toSorted()).toEqual([201, 400]);
    const devices = await pool.query(
      "SELECT device_id FROM devices WHERE device_name='Concurrent'",
    );
    expect(devices.rowCount).toBe(1);
  });

  it("expiredPairIdempotencyKey_isRemovedBeforeRetry", async () => {
    const pool = getPool();
    const context = createTestContext(pool);
    await seedPairingCode(pool, "00000019");
    const request = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "00000000-0000-4000-8000-000000000020",
      },
      body: JSON.stringify({
        pairingCode: "00000019",
        deviceName: "Expired key",
        platform: "linux",
      }),
    } as const;
    const first = await context.app.request("/v1/devices/pair", request);
    expect(first.status).toBe(201);
    await pool.query("UPDATE idempotency SET expires_at=$1", [
      new Date("2026-10-20T00:00:00.000Z"),
    ]);
    const retry = await context.app.request("/v1/devices/pair", request);
    expect(retry.status).toBe(400);
  });

  it("pairCode_expiredCodeCannotCreateDevice", async () => {
    const pool = getPool();
    const context = createTestContext(pool);
    await seedPairingCode(pool, "00000018");
    await pool.query("UPDATE pairing_codes SET expires_at = $1", [
      new Date("2026-10-20T00:00:00.000Z"),
    ]);
    const response = await context.app.request("/v1/devices/pair", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "00000000-0000-4000-8000-000000000019",
      },
      body: JSON.stringify({ pairingCode: "00000018", deviceName: "Expired", platform: "linux" }),
    });
    expect(response.status).toBe(400);
    expect(
      await pool.query("SELECT device_id FROM devices WHERE device_name = 'Expired'"),
    ).toMatchObject({ rowCount: 0 });
  });

  it("issuePairingCode_returnsEightDigits_andPersistsDigest", async () => {
    const pool = getPool();
    const context = createTestContext(pool);
    await pool.query("INSERT INTO users (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [
      TEST_USER_ID,
    ]);
    const code = await issuePairingCode(pool, TEST_USER_ID, config, context.clock, context.random);
    expect(code).toMatch(/^\d{8}$/);
    const row = await pool.query("SELECT code_digest FROM pairing_codes WHERE code_digest = $1", [
      createHash("sha256").update(code).digest(),
    ]);
    expect(row.rowCount).toBe(1);
  });
});
