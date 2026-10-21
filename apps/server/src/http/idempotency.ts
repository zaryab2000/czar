import { createHash } from "node:crypto";
import type { Config } from "@czar/config";
import type { PoolClient } from "pg";

export interface IdempotencyRecord {
  readonly fingerprint: Buffer;
  readonly status: number | null;
  readonly response_body: Record<string, unknown> | null;
  readonly response_hash: Buffer | null;
  readonly replay_stored: boolean;
}

export async function findOrCreateIdempotency(
  client: PoolClient,
  config: Config,
  input: {
    scope: string;
    key: string;
    fingerprint: Buffer;
    now: Date;
    replayStored?: boolean;
  },
): Promise<IdempotencyRecord> {
  await client.query("DELETE FROM idempotency WHERE expires_at <= $1", [input.now]);
  const expiresAt = new Date(
    input.now.getTime() + Number(config.get("api.idempotencyTtlHours")) * 3_600_000,
  );
  await client.query(
    `INSERT INTO idempotency (scope,key,fingerprint,expires_at,replay_stored)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [input.scope, input.key, input.fingerprint, expiresAt, input.replayStored ?? true],
  );
  const result = await client.query<IdempotencyRecord>(
    `SELECT fingerprint,status,response_body,response_hash,replay_stored
     FROM idempotency WHERE scope=$1 AND key=$2 FOR UPDATE`,
    [input.scope, input.key],
  );
  const record = result.rows[0];
  if (!record) throw new Error("Idempotency record was not created.");
  return record;
}

export function fingerprintRequest(rawBody: Buffer): Buffer {
  return createHash("sha256").update(rawBody).digest();
}
