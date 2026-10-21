import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Config } from "@czar/config";
import { bearerToken, ulid, type RandomSource } from "#src/http/ids";

export interface PairDependencies {
  pool: Pool;
  config: Config;
  clock: { now(): Date };
  random: RandomSource;
}

export async function issuePairingCode(
  pool: Pool,
  userId: string,
  config: Config,
  clock: { now(): Date },
  random: RandomSource,
): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const number = randomInteger(random, 100_000_000);
    const code = String(number).padStart(8, "0");
    const expires = new Date(
      clock.now().getTime() + Number(config.get("app.pairingCodeTtlMinutes")) * 60_000,
    );
    const result = await pool.query(
      `INSERT INTO pairing_codes (code_digest, user_id, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (code_digest) DO UPDATE SET user_id=EXCLUDED.user_id,
         expires_at=EXCLUDED.expires_at,used_at=NULL,created_at=EXCLUDED.created_at
       WHERE pairing_codes.expires_at <= $4`,
      [hash(code), userId, expires, clock.now()],
    );
    if (result.rowCount) return code;
  }
  throw new Error("Could not issue a unique pairing code after 100 attempts.");
}

export async function consumePairingCode(
  client: PoolClient,
  request: { pairingCode: string; deviceName: string; platform: string },
  dependencies: PairDependencies,
): Promise<{ deviceId: string; deviceToken: string }> {
  const codeDigest = hash(request.pairingCode);
  const found = await client.query<{ user_id: string; expires_at: Date; used_at: Date | null }>(
    "SELECT user_id, expires_at, used_at FROM pairing_codes WHERE code_digest = $1 FOR UPDATE",
    [codeDigest],
  );
  const code = found.rows[0];
  if (!code || code.used_at || code.expires_at <= dependencies.clock.now())
    throw new PairingRejected();
  const deviceId = ulid("dev_", dependencies.clock.now(), dependencies.random);
  const deviceToken = bearerToken(dependencies.random);
  await client.query(
    `INSERT INTO devices (device_id, user_id, device_name, platform, token_hash)
     VALUES ($1, $2, $3, $4, $5)`,
    [deviceId, code.user_id, request.deviceName, request.platform, hash(deviceToken)],
  );
  await client.query("UPDATE pairing_codes SET used_at = $2 WHERE code_digest = $1", [
    codeDigest,
    dependencies.clock.now(),
  ]);
  return { deviceId, deviceToken };
}

export class PairingRejected extends Error {}

function hash(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function randomInteger(random: RandomSource, upperBound: number): number {
  const range = 2 ** 32;
  const ceiling = range - (range % upperBound);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = random.bytes(4).readUInt32BE(0);
    if (value < ceiling) return value % upperBound;
  }
  throw new Error("Random source failed rejection sampling after 100 attempts.");
}
