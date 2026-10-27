import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "@czar/logging";
import { loadConfig } from "@czar/config";
import { createApp, issuePairingCode, migrate } from "@czar/server";
import { KEYCHAIN_ACCOUNTS } from "@czar/daemon";
import { pairDevice, PairingError } from "@czar/daemon/pairing";
import { Pool } from "pg";
import { memoryKeychain } from "./support.ts";

const adminUrl = "postgres://postgres@127.0.0.1:15432/postgres";
const userId = "usr_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const config = loadConfig({
  envFile: {
    "app.circleClientUrl": "https://example.invalid/circle",
    "app.circleClientKey": "test-public-key",
    "app.arcRpcUrl": "https://example.invalid/rpc",
  },
});
let admin: Pool;
let pool: Pool;
let databaseName: string;
let currentTime: Date;
let logLines: string[];
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  admin = new Pool({ connectionString: adminUrl });
  databaseName = `czar_pair_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  pool = new Pool({ connectionString: databaseUrl.toString() });
  await migrate(pool);
  await pool.query("INSERT INTO users (user_id) VALUES ($1)", [userId]);
  currentTime = new Date("2026-10-21T00:00:00.000Z");
  logLines = [];
  app = createApp({
    pool,
    config,
    logger: createLogger({
      service: "server",
      component: "CZ-12",
      sink: (line) => logLines.push(line),
    }),
    clock: { now: () => new Date(currentTime) },
    random: { bytes: randomBytes },
  });
});

afterAll(async () => {
  await pool?.end();
  if (admin && databaseName) {
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.end();
  }
});

describe("device pairing integration", () => {
  it("stores the returned token only in the keychain and pairs each code once", async () => {
    const keychain = memoryKeychain();
    const code = await newCode();
    expect(code).toMatch(/^\d{8}$/);
    const idempotencyKey = randomUUID();
    let responseToken = "";
    let requestBody = "";
    const fetcher = localServerFetch(
      async (response) => {
        if (response.status !== 201) return;
        const body = (await response.clone().json()) as Record<string, unknown>;
        expect(Object.keys(body).toSorted()).toEqual(["deviceId", "deviceToken"]);
        responseToken = String(body["deviceToken"]);
      },
      (_url, init) => {
        requestBody = String(init.body);
      },
    );
    const paired = await pairDevice({
      code,
      deviceName: "Research laptop",
      platform: "macos",
      keychain,
      idempotencyKey,
      fetcher,
    });

    expect(paired.deviceId).toMatch(/^dev_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(keychain.get(KEYCHAIN_ACCOUNTS.deviceToken)).toBe(responseToken);
    expect(process.argv).not.toContain(responseToken);
    expect(logLines.join("\n")).not.toContain(responseToken);
    expect(requestBody).not.toContain(responseToken);
    expect(await storedTokenHash(paired.deviceId)).toEqual(
      createHash("sha256").update(responseToken).digest(),
    );
    expect(await storedDeviceName(paired.deviceId)).toBe("Research laptop");

    await expect(
      pairDevice({ code, deviceName: "Research laptop", platform: "macos", keychain, fetcher }),
    ).rejects.toThrow(PairingError);
    expect(keychain.get(KEYCHAIN_ACCOUNTS.deviceToken)).toBe(responseToken);
    expect(await deviceCount(paired.deviceId)).toBe(1);
  });

  it("rejects a code after its five-minute lifetime", async () => {
    const keychain = memoryKeychain();
    const code = await newCode();
    currentTime = new Date(currentTime.getTime() + 5 * 60_000 + 1);

    await expect(
      pairDevice({
        code,
        deviceName: "Work Mac",
        platform: "macos",
        keychain,
        fetcher: localServerFetch(),
      }),
    ).rejects.toThrow(/invalid, used, or expired/);
    expect(keychain.get(KEYCHAIN_ACCOUNTS.deviceToken)).toBeNull();
  });

  it("stops on replay-not-stored and tells the user to request a new code", async () => {
    const keychain = memoryKeychain();
    const code = await newCode();
    const idempotencyKey = randomUUID();
    let calls = 0;
    const fetcher = async (input: URL, init: RequestInit) => {
      calls += 1;
      return app.request(input.toString(), init);
    };
    const first = await pairDevice({
      code,
      deviceName: "Office Mac",
      platform: "macos",
      keychain,
      idempotencyKey,
      fetcher,
    });

    await expect(
      pairDevice({
        code,
        deviceName: "Office Mac",
        platform: "macos",
        keychain,
        idempotencyKey,
        fetcher,
      }),
    ).rejects.toThrow(/Request a new pairing code/);
    expect(calls).toBe(2);
    expect(keychain.get(KEYCHAIN_ACCOUNTS.deviceToken)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await deviceCount(first.deviceId)).toBe(1);
  });
});

async function newCode(): Promise<string> {
  return issuePairingCode(
    pool,
    userId,
    config,
    { now: () => new Date(currentTime) },
    { bytes: randomBytes },
  );
}

function localServerFetch(
  onResponse?: (response: Response) => Promise<void>,
  onRequest?: (input: URL, init: RequestInit) => void,
) {
  return async (input: URL, init: RequestInit) => {
    expect(input.toString()).toBe("http://localhost/v1/devices/pair");
    expect(init.headers).toMatchObject({ "Idempotency-Key": expect.any(String) });
    onRequest?.(input, init);
    const response = await app.request(input.toString(), init);
    await onResponse?.(response);
    return response;
  };
}

async function storedTokenHash(deviceId: string): Promise<Buffer> {
  const row = await pool.query<{ token_hash: Buffer }>(
    "SELECT token_hash FROM devices WHERE device_id=$1",
    [deviceId],
  );
  return row.rows[0]?.token_hash ?? Buffer.alloc(0);
}

async function deviceCount(deviceId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM devices WHERE device_id=$1",
    [deviceId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function storedDeviceName(deviceId: string): Promise<string | undefined> {
  const result = await pool.query<{ device_name: string }>(
    "SELECT device_name FROM devices WHERE device_id=$1",
    [deviceId],
  );
  return result.rows[0]?.device_name;
}
