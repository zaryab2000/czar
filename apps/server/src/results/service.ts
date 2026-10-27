import { createHash } from "node:crypto";
import { validateRecordedExchange } from "@czar/api-contract";
import type { Config } from "@czar/config";
import { jcsString } from "@czar/hashing";
import type { Result, ResultAck } from "@czar/schemas";
import type { Pool, PoolClient } from "pg";
import { findOrCreateIdempotency, fingerprintRequest } from "#src/http/idempotency";

export type AckResultOutcome = "accepted" | "not-found" | "idempotency-conflict" | "replay-invalid";

/** Returns the owner's result, or null when the result is missing or belongs to another user.
 *
 * @param pool - Server database connection pool.
 * @param userId - User authenticated by the device token.
 * @param resultId - Result identifier from the route.
 */
export async function getResult(
  pool: Pool,
  userId: string,
  resultId: string,
): Promise<Result | null> {
  const found = await pool.query<{
    result_id: string;
    objective_id: string;
    rendered_body: string;
    provenance: Result["provenance"];
    created_at: Date;
  }>(
    `SELECT r.result_id,r.objective_id,r.rendered_body,r.provenance,r.created_at
     FROM results r JOIN objectives o ON o.objective_id=r.objective_id
     WHERE r.result_id=$1 AND o.result_id=r.result_id AND o.user_id=$2`,
    [resultId, userId],
  );
  const row = found.rows[0];
  if (!row) return null;
  const response: Result = {
    resultId: row.result_id,
    objectiveId: row.objective_id,
    mimeType: isJsonBody(row.rendered_body) ? "application/json" : "text/markdown",
    body: row.rendered_body,
    provenance: row.provenance,
    createdAt: row.created_at.toISOString(),
  };
  assertExchange("getResult", undefined, 200, response);
  return response;
}

function isJsonBody(body: string): boolean {
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
}

/** Persists one owner-scoped write-back acknowledgment with idempotent replay handling.
 *
 * @param pool - Server database connection pool.
 * @param config - Server configuration for the idempotency lifetime.
 * @param input - Authenticated owner, request body, key, and request time.
 */
export async function acknowledgeResult(
  pool: Pool,
  config: Config,
  input: {
    readonly userId: string;
    readonly objectiveId: string;
    readonly body: ResultAck;
    readonly rawBody: Buffer;
    readonly key: string;
    readonly now: Date;
  },
): Promise<AckResultOutcome> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await acknowledgeWithinTransaction(client, config, input);
    await client.query(result === "accepted" ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function acknowledgeWithinTransaction(
  client: PoolClient,
  config: Config,
  input: Parameters<typeof acknowledgeResult>[2],
): Promise<AckResultOutcome> {
  const ownerResult = await client.query<{ result_id: string }>(
    `SELECT o.result_id FROM objectives o
     JOIN results r ON r.result_id=o.result_id AND r.objective_id=o.objective_id
     WHERE o.objective_id=$1 AND o.user_id=$2 FOR UPDATE OF o`,
    [input.objectiveId, input.userId],
  );
  const resultId = ownerResult.rows[0]?.result_id;
  if (!resultId || resultId !== input.body.resultId) return "not-found";

  const fingerprint = fingerprintRequest(input.rawBody);
  const scope = `ackResult:${input.userId}:${input.objectiveId}`;
  const saved = await findOrCreateIdempotency(client, config, {
    scope,
    key: input.key,
    fingerprint,
    now: input.now,
  });
  if (!saved.fingerprint.equals(fingerprint)) return "idempotency-conflict";
  if (saved.status !== null) {
    if (
      saved.status !== 204 ||
      !saved.response_body ||
      !saved.response_hash ||
      !sameHash(saved.response_body, saved.response_hash)
    ) {
      return "replay-invalid";
    }
    return "accepted";
  }

  assertExchange("ackResult", input.body, 204);
  await client.query(
    `INSERT INTO outbox_events(name,objective_id,payload)
     VALUES('result.acknowledged',$1,$2::jsonb)`,
    [input.objectiveId, JSON.stringify(input.body)],
  );
  await storeIdempotency(client, scope, input.key);
  return "accepted";
}

async function storeIdempotency(client: PoolClient, scope: string, key: string): Promise<void> {
  const body = {};
  const responseHash = createHash("sha256").update(jcsString(body)).digest();
  await client.query(
    `UPDATE idempotency SET status=204,response_body=$3::jsonb,response_hash=$4
     WHERE scope=$1 AND key=$2`,
    [scope, key, JSON.stringify(body), responseHash],
  );
}

function sameHash(body: Record<string, unknown>, hash: Buffer): boolean {
  return createHash("sha256").update(jcsString(body)).digest().equals(hash);
}

function assertExchange(
  operationId: string,
  requestBody: unknown,
  responseStatus: number,
  responseBody?: unknown,
): void {
  const result = validateRecordedExchange(operationId, {
    ...(requestBody === undefined ? {} : { requestBody }),
    responseStatus,
    ...(responseBody === undefined ? {} : { responseBody }),
  });
  if (!result.valid) throw new Error(`Server response failed ${operationId} contract validation.`);
}
