import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { apiContracts, validateRecordedExchange } from "@czar/api-contract";
import type { Config } from "@czar/config";
import type { Logger } from "@czar/logging";
import { assertNoLocalOnly, LocalOnlyFieldError, SchemaValidationError } from "@czar/schemas";
import type { ObjectiveSubmission } from "@czar/schemas";
import type { Pool } from "pg";
import { authenticateDevice, digest, type Principal } from "#src/http/auth";
import {
  parseIdempotencyKey,
  parseObjectiveId,
  parseObjectiveListParams,
  RequestValidationError,
} from "#src/http/validate";
import { problem, type CzarCode } from "#src/http/problem";
import { findOrCreateIdempotency, fingerprintRequest } from "#src/http/idempotency";
import { PairingRejected, consumePairingCode, type PairDependencies } from "#src/devices/pair";
import { submitObjective } from "#src/objectives/service";
import { completeModelCall, type ModelClient, type ModelCallRequest } from "#src/models/proxy";

export interface AppDependencies extends PairDependencies {
  logger: Logger;
  modelClient?: ModelClient;
}

interface RequestState {
  operationId: string;
  started: number;
  traceId: string;
  principal?: Principal;
}
type ServerContext = Context<any, any, any>;

export function createApp(dependencies: AppDependencies): Hono {
  const app = new Hono();
  app.onError((error, context) => {
    const code = error instanceof RequestValidationError ? "validation" : "upstream-unavailable";
    const status = code === "validation" ? 400 : 503;
    const operationId = operationFor(context.req.path, context.req.method);
    if (operationId !== "unknown") {
      const pair = operationId === "pairDevice";
      const limit = Number(
        dependencies.config.get(pair ? "api.rateLimitAppPerMin" : "api.rateLimitDaemonPerMin"),
      );
      const nowSeconds = dependencies.clock.now().getTime() / 1000;
      context.header("RateLimit-Limit", String(limit));
      context.header("RateLimit-Remaining", String(limit));
      context.header("RateLimit-Reset", String(Math.ceil(60 - (nowSeconds % 60))));
    }
    return problemResponse(context, status, code, code === "upstream-unavailable");
  });
  app.use("/v1/*", async (context, next) => {
    const state: RequestState = {
      operationId: operationFor(context.req.path, context.req.method),
      started: performance.now(),
      traceId: dependencies.random.bytes(16).toString("hex"),
    };
    if (state.operationId !== "unknown") {
      const isPairing = state.operationId === "pairDevice";
      const limit = Number(
        dependencies.config.get(isPairing ? "api.rateLimitAppPerMin" : "api.rateLimitDaemonPerMin"),
      );
      const nowSeconds = dependencies.clock.now().getTime() / 1000;
      context.header("RateLimit-Limit", String(limit));
      context.header("RateLimit-Remaining", String(limit));
      context.header("RateLimit-Reset", String(Math.ceil(60 - (nowSeconds % 60))));
    }
    try {
      await next();
    } catch (error) {
      const code = error instanceof RequestValidationError ? "validation" : "upstream-unavailable";
      const status = code === "validation" ? 400 : 503;
      context.res = problemResponse(context, status, code, code === "upstream-unavailable");
    }
    const response = context.res;
    const status = response.status;
    dependencies.logger.info("http_request", {
      traceId: state.traceId,
      method: context.req.method,
      route: state.operationId,
      httpStatus: status,
      durationMs: Math.max(0, Math.round(performance.now() - state.started)),
      ...(status >= 400
        ? {
            czarCode: (await safeCzarCode(response)) ?? "validation",
            retryable: status === 503 || status === 429,
          }
        : {}),
    });
    return;
  });

  app.post("/v1/devices/pair", (context) => pairRoute(context, dependencies));
  app.post("/v1/objectives", (context) => submitRoute(context, dependencies));
  app.post("/v1/models/complete", (context) => modelRoute(context, dependencies));
  app.get("/v1/objectives", (context) => listRoute(context, dependencies));
  app.get("/v1/objectives/:objectiveId", (context) => getRoute(context, dependencies));
  return app;
}

async function pairRoute(context: ServerContext, deps: AppDependencies): Promise<Response> {
  const rate = await applyRateLimit(
    deps.pool,
    deps.config,
    deps.clock.now(),
    "pair",
    digest("pair"),
  );
  setRateHeaders(context, rate);
  if (!rate.allowed) return problemResponse(context, 429, "rate-limited", true);
  const raw = await readJson(context, "pairDevice");
  const requestBody = raw.value;
  validateRequest("pairDevice", requestBody);
  parseIdempotencyKey(context.req.header("Idempotency-Key"));
  const pairRequest = requestBody as { pairingCode: string; deviceName: string; platform: string };
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const key = context.req.header("Idempotency-Key") as string;
    const scope = `pair:${digest(pairRequest.pairingCode).toString("hex")}`;
    const fingerprint = fingerprintRequest(raw.bytes);
    const existing = await findOrCreateIdempotency(client, deps.config, {
      scope,
      key,
      fingerprint,
      now: deps.clock.now(),
      replayStored: false,
    });
    if (!existing.fingerprint.equals(fingerprint))
      return await finishProblem(client, context, 409, "idempotency-conflict");
    if (existing.status !== null)
      return await finishProblem(client, context, 409, "replay-not-stored");
    let responseBody: { deviceId: string; deviceToken: string };
    try {
      responseBody = await consumePairingCode(client, pairRequest, deps);
    } catch (error) {
      if (error instanceof PairingRejected)
        return await finishProblem(client, context, 400, "validation");
      throw error;
    }
    assertExchange("pairDevice", requestBody, 201, responseBody);
    await client.query("UPDATE idempotency SET status=201 WHERE scope=$1 AND key=$2", [scope, key]);
    await client.query("COMMIT");
    return jsonResponse(context, 201, responseBody);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function submitRoute(context: ServerContext, deps: AppDependencies): Promise<Response> {
  const auth = await authenticateDevice(context, deps.pool);
  const rate = await applyRateLimit(
    deps.pool,
    deps.config,
    deps.clock.now(),
    "daemon",
    auth.principal?.deviceId ?? auth.digest,
  );
  context.header("RateLimit-Limit", String(rate.limit));
  context.header("RateLimit-Remaining", String(rate.remaining));
  context.header("RateLimit-Reset", String(rate.reset));
  if (!rate.allowed) return problemResponse(context, 429, "rate-limited", true);
  if (!auth.principal) return problemResponse(context, 401, auth.code ?? "validation");
  const raw = await readJson(context, "submitObjective");
  const body = raw.value as ObjectiveSubmission;
  try {
    assertNoLocalOnly(body, "objective-submission");
  } catch (error) {
    if (error instanceof LocalOnlyFieldError || error instanceof SchemaValidationError) {
      throw new RequestValidationError();
    }
    throw error;
  }
  const key = parseIdempotencyKey(context.req.header("Idempotency-Key"));
  const result = await submitObjective(deps.pool, deps.config, {
    body,
    rawBody: raw.bytes,
    key,
    deviceId: auth.principal.deviceId,
    userId: auth.principal.userId,
    now: deps.clock.now(),
  });
  if (result.code) return problemResponse(context, result.status, result.code);
  return jsonResponse(context, result.status, result.body);
}

async function modelRoute(context: ServerContext, deps: AppDependencies): Promise<Response> {
  const auth = await authenticateDevice(context, deps.pool);
  const rate = await applyRateLimit(
    deps.pool,
    deps.config,
    deps.clock.now(),
    "daemon",
    auth.principal?.deviceId ?? auth.digest,
  );
  setRateHeaders(context, rate);
  if (!rate.allowed) return problemResponse(context, 429, "rate-limited", true);
  if (!auth.principal) return problemResponse(context, 401, auth.code ?? "validation");
  const raw = await readJson(context, "completeModelCall");
  const body = raw.value as ModelCallRequest;
  const key = parseIdempotencyKey(context.req.header("Idempotency-Key"));
  if (!deps.modelClient) return problemResponse(context, 503, "upstream-unavailable", true);
  const result = await completeModelCall(deps.pool, deps.config, deps.logger, deps.modelClient, {
    body,
    rawBody: raw.bytes,
    key,
    deviceId: auth.principal.deviceId,
    userId: auth.principal.userId,
    now: deps.clock.now(),
  });
  if (result.code) {
    return problemResponse(context, result.status, result.code, result.status === 503);
  }
  return jsonResponse(context, 200, result.body);
}

async function listRoute(context: ServerContext, deps: AppDependencies): Promise<Response> {
  const auth = await authenticateDevice(context, deps.pool);
  const rate = await applyRateLimit(
    deps.pool,
    deps.config,
    deps.clock.now(),
    "daemon",
    auth.principal?.deviceId ?? auth.digest,
  );
  setRateHeaders(context, rate);
  if (!rate.allowed) return problemResponse(context, 429, "rate-limited", true);
  if (!auth.principal) return problemResponse(context, 401, auth.code ?? "validation");
  const params = parseObjectiveListParams(new URL(context.req.url));
  const now = deps.clock.now();
  await deps.pool.query("DELETE FROM objective_cursors WHERE expires_at <= $1", [now]);
  let after: { createdAt: Date; objectiveId: string } | undefined;
  if (params.cursor !== undefined) {
    const cursor = await deps.pool.query<{
      device_id: string;
      state_filter: string | null;
      last_created_at: Date;
      last_objective_id: string;
      expires_at: Date;
    }>("SELECT * FROM objective_cursors WHERE cursor_hash=$1", [digest(params.cursor)]);
    const row = cursor.rows[0];
    if (
      !row ||
      row.expires_at <= now ||
      row.device_id !== auth.principal.deviceId ||
      row.state_filter !== (params.status ?? null)
    ) {
      throw new RequestValidationError();
    }
    after = { createdAt: row.last_created_at, objectiveId: row.last_objective_id };
  }
  const where = ["device_id=$1"];
  const values: unknown[] = [auth.principal.deviceId];
  if (params.status !== undefined) {
    values.push(params.status);
    where.push(`state=$${values.length}`);
  }
  if (after) {
    values.push(after.createdAt, after.objectiveId);
    where.push(`(created_at,objective_id)<($${values.length - 1},$${values.length})`);
  }
  values.push(params.limit + 1);
  const rows = await deps.pool.query<{
    objective_id: string;
    state: string;
    updated_at: Date;
    created_at: Date;
  }>(
    `SELECT objective_id,state,updated_at,created_at FROM objectives
     WHERE ${where.join(" AND ")} ORDER BY created_at DESC,objective_id DESC LIMIT $${values.length}`,
    values,
  );
  const hasMore = rows.rows.length > params.limit;
  const page = rows.rows.slice(0, params.limit);
  const items = page.map((row) => ({
    objectiveId: row.objective_id,
    status: row.state,
    updatedAt: row.updated_at.toISOString(),
  }));
  let nextCursor: string | null = null;
  if (hasMore) {
    const last = page.at(-1);
    if (!last) throw new Error("Pagination returned an empty page with another row available.");
    nextCursor = deps.random.bytes(32).toString("base64url");
    await deps.pool.query(
      `INSERT INTO objective_cursors (cursor_hash,device_id,state_filter,last_created_at,last_objective_id,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        digest(nextCursor),
        auth.principal.deviceId,
        params.status ?? null,
        last.created_at,
        last.objective_id,
        new Date(now.getTime() + Number(deps.config.get("api.cursorTtlMinutes")) * 60_000),
      ],
    );
  }
  const response = { items, nextCursor };
  assertExchange("listObjectives", undefined, 200, response);
  return jsonResponse(context, 200, response);
}

async function getRoute(context: ServerContext, deps: AppDependencies): Promise<Response> {
  const auth = await authenticateDevice(context, deps.pool);
  const rate = await applyRateLimit(
    deps.pool,
    deps.config,
    deps.clock.now(),
    "daemon",
    auth.principal?.deviceId ?? auth.digest,
  );
  setRateHeaders(context, rate);
  if (!rate.allowed) return problemResponse(context, 429, "rate-limited", true);
  if (!auth.principal) return problemResponse(context, 401, auth.code ?? "validation");
  const objectiveId = parseObjectiveId(context.req.param("objectiveId") ?? "");
  const found = await deps.pool.query(
    "SELECT objective_id,state,updated_at FROM objectives WHERE objective_id=$1 AND device_id=$2",
    [objectiveId, auth.principal.deviceId],
  );
  if (!found.rowCount) return problemResponse(context, 404, "validation");
  const row = found.rows[0] as { objective_id: string; state: string; updated_at: Date };
  const response = {
    objectiveId: row.objective_id,
    status: row.state,
    updatedAt: row.updated_at.toISOString(),
  };
  assertExchange("getObjective", undefined, 200, response);
  return jsonResponse(context, 200, response);
}

async function readJson(
  context: ServerContext,
  operationId: string,
): Promise<{ value: unknown; bytes: Buffer }> {
  if (!context.req.header("Content-Type")?.toLowerCase().startsWith("application/json"))
    throw new RequestValidationError();
  const bytes = Buffer.from(await context.req.raw.clone().arrayBuffer());
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new RequestValidationError();
  }
  validateRequest(operationId, value);
  return { value, bytes };
}

function validateRequest(operationId: string, body: unknown): void {
  const validator = apiContracts.get(operationId)?.request;
  if (!validator || !validator(body)) throw new RequestValidationError();
}

function assertExchange(
  operationId: string,
  requestBody: unknown,
  status: number,
  responseBody: unknown,
): void {
  const result = validateRecordedExchange(operationId, {
    ...(requestBody === undefined ? {} : { requestBody }),
    responseStatus: status,
    responseBody,
  });
  if (!result.valid) throw new Error(`Server response failed ${operationId} contract validation.`);
}

async function applyRateLimit(
  pool: Pool,
  config: Config,
  now: Date,
  surface: string,
  principal: string | Buffer,
): Promise<{ limit: number; remaining: number; reset: number; allowed: boolean }> {
  const limit =
    surface === "daemon"
      ? Number(config.get("api.rateLimitDaemonPerMin"))
      : Number(config.get("api.rateLimitAppPerMin"));
  const principalHash = Buffer.isBuffer(principal) ? principal : digest(principal);
  const window = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const row = await pool.query<{ count: number }>(
    `INSERT INTO rate_limit_buckets (surface,principal_hash,window_start,count)
     VALUES ($1,$2,$3,1) ON CONFLICT (surface,principal_hash,window_start)
     DO UPDATE SET count=rate_limit_buckets.count+1 RETURNING count`,
    [surface, principalHash, window],
  );
  const count = Number(row.rows[0]?.count ?? limit + 1);
  return {
    limit,
    remaining: Math.max(0, limit - count),
    reset: Math.max(0, Math.ceil((window.getTime() + 60_000 - now.getTime()) / 1000)),
    allowed: count <= limit,
  };
}

function setRateHeaders(
  context: { header(name: string, value: string): void },
  rate: { limit: number; remaining: number; reset: number },
): void {
  context.header("RateLimit-Limit", String(rate.limit));
  context.header("RateLimit-Remaining", String(rate.remaining));
  context.header("RateLimit-Reset", String(rate.reset));
}

async function finishProblem(
  client: import("pg").PoolClient,
  context: ServerContext,
  status: number,
  code: CzarCode,
): Promise<Response> {
  await client.query("ROLLBACK");
  return problemResponse(context, status, code);
}

function problemResponse(
  context: ServerContext,
  status: number,
  code: CzarCode,
  retryable = false,
): Response {
  return context.json(
    problem(status, code, retryable, context.req.path),
    status as ContentfulStatusCode,
    {
      "Content-Type": "application/problem+json",
    },
  );
}

function jsonResponse(context: ServerContext, status: number, body: unknown): Response {
  return context.json(body, status as ContentfulStatusCode, { "Content-Type": "application/json" });
}

async function safeCzarCode(response: Response): Promise<CzarCode | undefined> {
  try {
    return ((await response.clone().json()) as { czarCode?: CzarCode }).czarCode;
  } catch {
    return undefined;
  }
}

function operationFor(path: string, method: string): string {
  if (method === "POST" && path === "/v1/devices/pair") return "pairDevice";
  if (method === "POST" && path === "/v1/objectives") return "submitObjective";
  if (method === "POST" && path === "/v1/models/complete") return "completeModelCall";
  if (method === "GET" && path === "/v1/objectives") return "listObjectives";
  if (method === "GET" && path.startsWith("/v1/objectives/")) return "getObjective";
  return "unknown";
}
