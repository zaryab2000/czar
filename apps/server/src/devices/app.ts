import { createHash } from "node:crypto";
import { validateRecordedExchange } from "@czar/api-contract";
import type { Config } from "@czar/config";
import { jcsString } from "@czar/hashing";
import type { AppPage, Device, PairingCode } from "@czar/schemas";
import type { Context } from "hono";
import type { Pool } from "pg";
import { problem, type CzarCode } from "#src/http/problem";
import { findOrCreateIdempotency, fingerprintRequest } from "#src/http/idempotency";
import { issuePairingCodeWithExpiry, type PairDependencies } from "#src/devices/pair";
import { CURSOR_MAX_LENGTH, parseIdempotencyKey, RequestValidationError } from "#src/http/validate";

type ServerContext = Context<any, any, any>;
type DeviceCursor = { readonly createdAt: string; readonly deviceId: string };

export async function createPairingCodeRoute(
  context: ServerContext,
  dependencies: PairDependencies,
): Promise<Response> {
  const userId = authenticatedUser(context);
  if (!userId) return appProblem(context, 401, "session-expired");
  const key = parseIdempotencyKey(context.req.header("Idempotency-Key"));
  const client = await dependencies.pool.connect();
  try {
    await client.query("BEGIN");
    const scope = `createPairingCode:${userId}`;
    const fingerprint = fingerprintRequest(Buffer.alloc(0));
    const saved = await findOrCreateIdempotency(client, dependencies.config, {
      scope,
      key,
      fingerprint,
      now: dependencies.clock.now(),
    });
    if (!saved.fingerprint.equals(fingerprint)) {
      return await rollbackProblem(context, client, 409, "idempotency-conflict");
    }
    if (saved.status !== null) {
      if (
        !saved.response_body ||
        !saved.response_hash ||
        !responseMatches(saved.response_body, saved.response_hash)
      ) {
        return await rollbackProblem(context, client, 409, "replay-not-stored");
      }
      await client.query("COMMIT");
      return context.json(saved.response_body, saved.status as 201);
    }
    const issued = await issuePairingCodeWithExpiry(
      client,
      userId,
      dependencies.config,
      dependencies.clock,
      dependencies.random,
    );
    const response: PairingCode = issued;
    assertResponse("createPairingCode", 201, response);
    await saveIdempotency(client, scope, key, 201, response);
    await client.query("COMMIT");
    return context.json(response, 201);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listDevicesRoute(
  context: ServerContext,
  dependencies: { readonly pool: Pool; readonly config: Config },
): Promise<Response> {
  const userId = authenticatedUser(context);
  if (!userId) return appProblem(context, 401, "session-expired");
  const { cursor, limit } = parseDevicePage(new URL(context.req.url), dependencies.config);
  const values: unknown[] = [userId];
  const after = cursor ? decodeCursor(cursor) : undefined;
  let condition = "user_id=$1";
  if (after) {
    values.push(new Date(after.createdAt), after.deviceId);
    condition += ` AND (created_at,device_id)<($${values.length - 1},$${values.length})`;
  }
  values.push(limit + 1);
  const result = await dependencies.pool.query<{
    device_id: string;
    device_name: string;
    platform: Device["platform"];
    created_at: Date;
    revoked_at: Date | null;
  }>(
    `SELECT device_id,device_name,platform,created_at,revoked_at FROM devices
     WHERE ${condition} ORDER BY created_at DESC,device_id DESC LIMIT $${values.length}`,
    values,
  );
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const items: Device[] = rows.map((row) => ({
    deviceId: row.device_id,
    deviceName: row.device_name,
    platform: row.platform,
    createdAt: row.created_at.toISOString(),
    ...(row.revoked_at ? { revokedAt: row.revoked_at.toISOString() } : {}),
  }));
  const last = rows.at(-1);
  const response: AppPage<Device> = {
    items,
    nextCursor: hasMore && last ? encodeCursor(last) : null,
  };
  assertResponse("listDevices", 200, response);
  return context.json(response);
}

export async function revokeDeviceRoute(
  context: ServerContext,
  dependencies: PairDependencies,
): Promise<Response> {
  const userId = authenticatedUser(context);
  if (!userId) return appProblem(context, 401, "session-expired");
  const key = parseIdempotencyKey(context.req.header("Idempotency-Key"));
  const deviceId = context.req.param("deviceId") ?? "";
  if (!/^dev_[0-9A-HJKMNP-TV-Z]{26}$/.test(deviceId)) throw new RequestValidationError();
  const client = await dependencies.pool.connect();
  try {
    await client.query("BEGIN");
    const scope = `revokeDevice:${userId}:${deviceId}`;
    const fingerprint = fingerprintRequest(Buffer.alloc(0));
    const saved = await findOrCreateIdempotency(client, dependencies.config, {
      scope,
      key,
      fingerprint,
      now: dependencies.clock.now(),
    });
    if (!saved.fingerprint.equals(fingerprint)) {
      return await rollbackProblem(context, client, 409, "idempotency-conflict");
    }
    if (saved.status !== null) {
      if (
        !saved.response_body ||
        !saved.response_hash ||
        !responseMatches(saved.response_body, saved.response_hash)
      ) {
        return await rollbackProblem(context, client, 409, "replay-not-stored");
      }
      await client.query("COMMIT");
      return context.body(null, 204);
    }
    const revoked = await client.query(
      `UPDATE devices SET revoked_at=COALESCE(revoked_at,$3)
       WHERE device_id=$1 AND user_id=$2 RETURNING device_id`,
      [deviceId, userId, dependencies.clock.now()],
    );
    if (!revoked.rowCount) return await rollbackProblem(context, client, 404, "validation");
    await saveIdempotency(client, scope, key, 204, {});
    await client.query("COMMIT");
    return context.body(null, 204);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function authenticatedUser(context: ServerContext): string | undefined {
  return context.get("appUserId") as string | undefined;
}

function parseDevicePage(
  url: URL,
  config: Config,
): { readonly cursor: string | null; readonly limit: number } {
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? Number(config.get("api.pageDefaultLimit")) : Number(rawLimit);
  const cursor = url.searchParams.get("cursor");
  if (
    !Number.isSafeInteger(limit) ||
    limit < Number(config.get("api.pageMinLimit")) ||
    limit > Number(config.get("api.pageMaxLimit")) ||
    (cursor !== null && cursor.length > CURSOR_MAX_LENGTH)
  ) {
    throw new RequestValidationError();
  }
  return { cursor, limit };
}

function decodeCursor(value: string): DeviceCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as DeviceCursor;
    if (
      !parsed ||
      typeof parsed.createdAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.createdAt)) ||
      typeof parsed.deviceId !== "string" ||
      !/^dev_[0-9A-HJKMNP-TV-Z]{26}$/.test(parsed.deviceId)
    ) {
      throw new Error("invalid cursor");
    }
    return parsed;
  } catch {
    throw new RequestValidationError("Device list cursor is invalid.");
  }
}

function encodeCursor(row: { created_at: Date; device_id: string }): string {
  return Buffer.from(
    JSON.stringify({ createdAt: row.created_at.toISOString(), deviceId: row.device_id }),
  ).toString("base64url");
}

async function saveIdempotency(
  client: import("pg").PoolClient,
  scope: string,
  key: string,
  status: number,
  body: object,
): Promise<void> {
  const responseHash = createHash("sha256").update(jcsString(body)).digest();
  await client.query(
    `UPDATE idempotency SET status=$3,response_body=$4::jsonb,response_hash=$5
     WHERE scope=$1 AND key=$2`,
    [scope, key, status, JSON.stringify(body), responseHash],
  );
}

function responseMatches(body: object, responseHash: Buffer): boolean {
  return createHash("sha256").update(jcsString(body)).digest().equals(responseHash);
}

function assertResponse(operationId: string, status: number, body: unknown): void {
  if (
    !validateRecordedExchange(operationId, { responseStatus: status, responseBody: body }).valid
  ) {
    throw new Error(`Server response failed ${operationId} contract validation.`);
  }
}

async function rollbackProblem(
  context: ServerContext,
  client: import("pg").PoolClient,
  status: 404 | 409,
  code: CzarCode,
): Promise<Response> {
  await client.query("ROLLBACK");
  return appProblem(context, status, code);
}

function appProblem(context: ServerContext, status: 401 | 404 | 409, code: CzarCode): Response {
  return context.json(problem(status, code, false, context.req.path), status, {
    "Content-Type": "application/problem+json",
  });
}
