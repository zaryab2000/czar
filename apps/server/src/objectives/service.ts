import { createHash } from "node:crypto";
import { validateRecordedExchange } from "@czar/api-contract";
import type { Config } from "@czar/config";
import { jcsString, objectiveHash, taskSpecHash } from "@czar/hashing";
import type { ObjectiveSubmission } from "@czar/schemas";
import type { Pool, PoolClient } from "pg";
import { findOrCreateIdempotency, fingerprintRequest } from "#src/http/idempotency";

export interface SubmissionResult {
  status: number;
  body: Record<string, unknown>;
  code?: "hash-mismatch" | "idempotency-conflict" | "validation";
}

export async function submitObjective(
  pool: Pool,
  config: Config,
  input: {
    body: ObjectiveSubmission;
    rawBody: Buffer;
    key: string;
    deviceId: string;
    userId: string;
    now: Date;
  },
): Promise<SubmissionResult> {
  if (input.body.deviceId !== input.deviceId) return { status: 400, code: "validation", body: {} };
  if (!hashesMatch(input.body)) return { status: 422, code: "hash-mismatch", body: {} };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await submitWithinTransaction(client, config, input);
    await client.query(result.status < 400 ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    if (isObjectiveIdConflict(error)) return { status: 409, code: "validation", body: {} };
    throw error;
  } finally {
    client.release();
  }
}

async function submitWithinTransaction(
  client: PoolClient,
  config: Config,
  input: Parameters<typeof submitObjective>[2],
): Promise<SubmissionResult> {
  const fingerprint = fingerprintRequest(input.rawBody);
  const scope = `submitObjective:${input.deviceId}`;
  const row = await findOrCreateIdempotency(client, config, {
    scope,
    key: input.key,
    fingerprint,
    now: input.now,
  });
  if (!row.fingerprint.equals(fingerprint)) {
    return { status: 409, code: "idempotency-conflict", body: {} };
  }
  if (row.status !== null) {
    if (
      !row.response_body ||
      !row.response_hash ||
      !sameHash(row.response_body, row.response_hash)
    ) {
      throw new Error("Stored idempotency response failed its integrity check.");
    }
    return { status: row.status, body: row.response_body };
  }
  const updatedAt = input.now.toISOString();
  const responseBody = {
    objectiveId: input.body.objectiveId,
    status: "received",
    updatedAt,
  };
  const contract = validateRecordedExchange("submitObjective", {
    requestBody: input.body,
    responseStatus: 202,
    responseBody,
  });
  if (!contract.valid) throw new Error("Objective response failed OpenAPI validation.");
  await client.query(
    `INSERT INTO objectives (objective_id,user_id,device_id,submission,objective_hash,state,created_at,updated_at)
     VALUES ($1,$2,$3,$4::jsonb,$5,'received',$6,$6)`,
    [
      input.body.objectiveId,
      input.userId,
      input.deviceId,
      JSON.stringify(input.body),
      input.body.objectiveHash,
      input.now,
    ],
  );
  await client.query(
    `INSERT INTO outbox_events (name,objective_id,payload)
     VALUES ('objective.received',$1,$2::jsonb)`,
    [
      input.body.objectiveId,
      JSON.stringify({
        objectiveId: input.body.objectiveId,
        objectiveHash: input.body.objectiveHash,
      }),
    ],
  );
  const responseHash = responseDigest(responseBody);
  await client.query(
    `UPDATE idempotency SET status=202,response_body=$3::jsonb,response_hash=$4
     WHERE scope=$1 AND key=$2`,
    [scope, input.key, JSON.stringify(responseBody), responseHash],
  );
  return { status: 202, body: responseBody };
}

function hashesMatch(body: ObjectiveSubmission): boolean {
  const specHash = taskSpecHash(body.taskSpec);
  return (
    objectiveHash({
      objectiveId: body.objectiveId,
      soulVersionHash: body.soulVersionHash,
      observationHashes: body.observationHashes,
      detector: body.detector,
      goal: body.goal,
      capabilities: body.capabilities,
      ...(body.deadline === undefined ? {} : { deadline: body.deadline }),
      minutesSaved: body.minutesSaved,
      hourlyBand: body.hourlyBand,
      taskSpecHash: specHash,
    }) === body.objectiveHash
  );
}

function responseDigest(body: Record<string, unknown>): Buffer {
  return createHash("sha256").update(jcsString(body)).digest();
}

function sameHash(body: Record<string, unknown>, storedHash: Buffer): boolean {
  return responseDigest(body).equals(storedHash);
}

function isObjectiveIdConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === "objectives_pkey"
  );
}
