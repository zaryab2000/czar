import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { apiContracts, validateRecordedExchange } from "@czar/api-contract";
import type { Config } from "@czar/config";
import type { Logger } from "@czar/logging";
import {
  assertNoLocalOnly,
  LocalOnlyFieldError,
  SchemaValidationError,
  validateEnvelope,
} from "@czar/schemas";
import type { ObjectiveSubmission, ResultAck } from "@czar/schemas";
import type { Plan, SubjectsRevision } from "@czar/schemas";
import type { Pool } from "pg";
import { appSessionVerifier, authenticateDevice, digest, type Principal } from "#src/http/auth";
import {
  parseIdempotencyKey,
  parseObjectiveId,
  parseObjectiveListParams,
  parseResultId,
  RequestValidationError,
} from "#src/http/validate";
import { problem, type CzarCode } from "#src/http/problem";
import { findOrCreateIdempotency, fingerprintRequest } from "#src/http/idempotency";
import { createPairingCodeRoute, listDevicesRoute, revokeDeviceRoute } from "#src/devices/app";
import { PairingRejected, consumePairingCode, type PairDependencies } from "#src/devices/pair";
import { submitObjective } from "#src/objectives/service";
import { completeModelCall, type ModelClient, type ModelCallRequest } from "#src/models/proxy";
import {
  authorizeJobDeliverableRequest,
  getJobBrief,
  JobRequestRejected,
  uploadJobDeliverable,
  type JobDeliveryDependencies,
} from "#src/payer/job";
import {
  createApprovalIntentRoute,
  getApprovalRoute,
  listApprovalsRoute,
  notifySubmittedRoute,
  revisePlanSubjectsRoute,
} from "#src/app/approvals";
import { createFreezeIntentRoute } from "#src/app/freeze";
import { createAuthChallengeRoute, createSessionRoute, registerPasskeyRoute } from "#src/app/auth";
import {
  getEnvelopeRoute,
  getMeRoute,
  listEnvelopesRoute,
  listManualReturnsRoute,
  listReceiptsRoute,
  type AppReadOptions,
} from "#src/app/reads";
import { getAppWalletConfigRoute, resolveAppWalletConfig } from "#src/app/wallet-config";
import { acknowledgeResult, getResult } from "#src/results/service";

export interface AppDependencies extends PairDependencies {
  logger: Logger;
  modelClient?: ModelClient;
  jobDelivery?: JobDeliveryDependencies;
  appReadOptions?: AppReadOptions;
  revisePlanSubjects?: (
    userId: string,
    planId: string,
    revision: SubjectsRevision,
  ) => Promise<Plan | null>;
}

interface RequestState {
  operationId: string;
  started: number;
  traceId: string;
  principal?: Principal;
}
type ServerContext = Context<any, any, any>;

export function createApp(dependencies: AppDependencies): Hono {
  const walletConfig = resolveAppWalletConfig(dependencies.config);
  const app = new Hono();
  app.onError((error, context) => {
    const code = error instanceof RequestValidationError ? "validation" : "upstream-unavailable";
    const status = code === "validation" ? 400 : 503;
    const operationId = operationFor(context.req.path, context.req.method);
    if (operationId !== "unknown") {
      const pair = isDeviceOperation(operationId);
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
      const isPairing = isDeviceOperation(state.operationId);
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

  app.get("/health", async (context) => {
    await dependencies.pool.query("SELECT 1");
    return context.json({ status: "ok" });
  });
  app.post("/v1/devices/pair", (context) => pairRoute(context, dependencies));
  app.post(
    "/v1/devices/pairing-codes",
    appSessionVerifier(dependencies.pool, dependencies.config),
    (context, next) => appRateLimit(context, next, dependencies),
    (context) => createPairingCodeRoute(context, dependencies),
  );
  app.get(
    "/v1/devices",
    appSessionVerifier(dependencies.pool, dependencies.config),
    (context, next) => appRateLimit(context, next, dependencies),
    (context) => listDevicesRoute(context, dependencies),
  );
  app.post(
    "/v1/devices/:deviceId/revoke",
    appSessionVerifier(dependencies.pool, dependencies.config),
    (context, next) => appRateLimit(context, next, dependencies),
    (context) => revokeDeviceRoute(context, dependencies),
  );
  app.post("/v1/auth/challenge", (context) =>
    publicAuthRoute(context, appAuthDependencies(dependencies), createAuthChallengeRoute),
  );
  app.post("/v1/auth/passkey", (context) =>
    publicAuthRoute(context, appAuthDependencies(dependencies), registerPasskeyRoute),
  );
  app.post("/v1/auth/session", (context) =>
    publicAuthRoute(context, appAuthDependencies(dependencies), createSessionRoute),
  );
  app.post("/v1/objectives", (context) => submitRoute(context, dependencies));
  app.post("/v1/models/complete", (context) => modelRoute(context, dependencies));
  app.get("/v1/objectives", (context) => listRoute(context, dependencies));
  app.get("/v1/objectives/:objectiveId", (context) => getRoute(context, dependencies));
  app.get("/v1/results/:resultId", async (context) => {
    const auth = await authenticateDevice(context, dependencies.pool);
    const rate = await applyRateLimit(
      dependencies.pool,
      dependencies.config,
      dependencies.clock.now(),
      "daemon",
      auth.principal?.deviceId ?? auth.digest,
    );
    setRateHeaders(context, rate);
    if (!rate.allowed) return problemResponse(context, 429, "rate-limited", true);
    if (!auth.principal) return problemResponse(context, 401, auth.code ?? "validation");
    const resultId = parseResultId(context.req.param("resultId") ?? "");
    const result = await getResult(dependencies.pool, auth.principal.userId, resultId);
    if (!result) return problemResponse(context, 404, "validation");
    assertResponseContract("getResult", 200, result);
    return jsonResponse(context, 200, result);
  });
  app.post("/v1/objectives/:objectiveId/results/ack", async (context) => {
    const auth = await authenticateDevice(context, dependencies.pool);
    const rate = await applyRateLimit(
      dependencies.pool,
      dependencies.config,
      dependencies.clock.now(),
      "daemon",
      auth.principal?.deviceId ?? auth.digest,
    );
    setRateHeaders(context, rate);
    if (!rate.allowed) return problemResponse(context, 429, "rate-limited", true);
    if (!auth.principal) return problemResponse(context, 401, auth.code ?? "validation");
    const objectiveId = parseObjectiveId(context.req.param("objectiveId") ?? "");
    const raw = await readJson(context, "ackResult");
    const outcome = await acknowledgeResult(dependencies.pool, dependencies.config, {
      userId: auth.principal.userId,
      objectiveId,
      body: raw.value as ResultAck,
      rawBody: raw.bytes,
      key: parseIdempotencyKey(context.req.header("Idempotency-Key")),
      now: dependencies.clock.now(),
    });
    if (outcome === "not-found") return problemResponse(context, 404, "validation");
    if (outcome === "idempotency-conflict")
      return problemResponse(context, 409, "idempotency-conflict");
    if (outcome === "replay-invalid") return problemResponse(context, 409, "replay-not-stored");
    return context.body(null, 204);
  });
  app.get("/v1/jobs/:jobKey/brief", (context) => jobBriefRoute(context, dependencies));
  app.post("/v1/jobs/:jobKey/deliverable", (context) => jobDeliverableRoute(context, dependencies));
  app.get("/v1/app/wallet-config", (context) => getAppWalletConfigRoute(context, walletConfig));
  app.get(
    "/v1/me",
    appSessionVerifier(dependencies.pool, dependencies.config),
    (context, next) => appRateLimit(context, next, dependencies),
    (context) => getMeRoute(context, appReadDependencies(dependencies)),
  );
  app.get(
    "/v1/envelopes",
    appSessionVerifier(dependencies.pool, dependencies.config),
    (context, next) => appRateLimit(context, next, dependencies),
    (context) => listEnvelopesRoute(context, appReadDependencies(dependencies)),
  );
  app.get(
    "/v1/envelopes/:envelopeRef",
    appSessionVerifier(dependencies.pool, dependencies.config),
    (context, next) => appRateLimit(context, next, dependencies),
    (context) => getEnvelopeRoute(context, appReadDependencies(dependencies)),
  );
  app.get(
    "/v1/ledger/receipts",
    appSessionVerifier(dependencies.pool, dependencies.config),
    (context, next) => appRateLimit(context, next, dependencies),
    (context) => listReceiptsRoute(context, appReadDependencies(dependencies)),
  );
  app.get(
    "/v1/pockets/manual-returns",
    appSessionVerifier(dependencies.pool, dependencies.config),
    (context, next) => appRateLimit(context, next, dependencies),
    (context) => listManualReturnsRoute(context, appReadDependencies(dependencies)),
  );
  app.get(
    "/v1/approvals",
    appSessionVerifier(dependencies.pool, dependencies.config),
    (context, next) => appRateLimit(context, next, dependencies),
    (context) => listApprovalsRoute(context, dependencies),
  );
  app.get(
    "/v1/approvals/:planId",
    appSessionVerifier(dependencies.pool, dependencies.config),
    (context, next) => appRateLimit(context, next, dependencies),
    (context) => getApprovalRoute(context, dependencies),
  );
  app.post(
    "/v1/approvals/:planId/subjects",
    appSessionVerifier(dependencies.pool, dependencies.config),
    (context, next) => appRateLimit(context, next, dependencies),
    (context) => revisePlanSubjectsRoute(context, dependencies),
  );
  app.post(
    "/v1/approvals/:planId/intent",
    appSessionVerifier(dependencies.pool, dependencies.config),
    (context, next) => appRateLimit(context, next, dependencies),
    (context) => createApprovalIntentRoute(context, dependencies),
  );
  app.post(
    "/v1/approvals/:planId/submitted",
    appSessionVerifier(dependencies.pool, dependencies.config),
    (context, next) => appRateLimit(context, next, dependencies),
    (context) => notifySubmittedRoute(context, dependencies),
  );
  app.post(
    "/v1/freeze/intent",
    appSessionVerifier(dependencies.pool, dependencies.config),
    (context, next) => appRateLimit(context, next, dependencies),
    (context) => createFreezeIntentRoute(context, dependencies.pool),
  );
  app.get(
    "/v1/soul/pointer",
    appSessionVerifier(dependencies.pool, dependencies.config),
    (context, next) => appRateLimit(context, next, dependencies),
    (context) => soulPointerRoute(context),
  );
  return app;
}

async function jobBriefRoute(context: ServerContext, deps: AppDependencies): Promise<Response> {
  const auth = providerRequest(context, "brief");
  if (!deps.jobDelivery) return problemResponse(context, 503, "upstream-unavailable", true);
  let result;
  try {
    result = await getJobBrief(auth.request, deps.jobDelivery);
  } catch (error) {
    if (!(error instanceof JobRequestRejected)) {
      deps.logger.error("job_brief_upstream_failure", { rule: "job_brief", state: "error" });
      return problemResponse(context, 503, "upstream-unavailable", true);
    }
    return problemResponse(context, 404, "validation");
  }
  const rate = await applyRateLimit(deps.pool, deps.config, deps.clock.now(), "app", auth.address);
  setRateHeaders(context, rate);
  if (!rate.allowed) return problemResponse(context, 429, "rate-limited", true);
  assertExchange("getJobBrief", undefined, 200, result);
  return jsonResponse(context, 200, result);
}

async function jobDeliverableRoute(
  context: ServerContext,
  deps: AppDependencies,
): Promise<Response> {
  const auth = providerRequest(context, "upload");
  if (!deps.jobDelivery) return problemResponse(context, 503, "upstream-unavailable", true);
  if (context.req.header("Content-Type")?.split(";")[0]?.trim() !== "application/octet-stream")
    return problemResponse(context, 400, "validation");
  const maxBytes = Number(deps.config.get("acceptance.deliverableMaxBytes"));
  const declaredBytes = Number(context.req.header("Content-Length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes)
    return problemResponse(context, 413, "validation");
  const body = await readLimitedBody(context, maxBytes);
  if (!body) return problemResponse(context, 413, "validation");
  try {
    await authorizeJobDeliverableRequest({ ...auth.request, body }, deps.jobDelivery);
  } catch (error) {
    if (!(error instanceof JobRequestRejected)) {
      deps.logger.error("job_deliverable_upstream_failure", {
        rule: "job_deliverable",
        state: "error",
      });
      return problemResponse(context, 503, "upstream-unavailable", true);
    }
    return problemResponse(context, 404, "validation");
  }
  const rate = await applyRateLimit(deps.pool, deps.config, deps.clock.now(), "app", auth.address);
  setRateHeaders(context, rate);
  if (!rate.allowed) return problemResponse(context, 429, "rate-limited", true);
  let result;
  try {
    result = await uploadJobDeliverable({ ...auth.request, body }, deps.jobDelivery);
  } catch (error) {
    if (error instanceof RangeError) return problemResponse(context, 413, "validation");
    if (error instanceof JobRequestRejected) return problemResponse(context, 404, "validation");
    deps.logger.error("job_deliverable_upstream_failure", {
      rule: "job_deliverable",
      state: "error",
    });
    return problemResponse(context, 503, "upstream-unavailable", true);
  }
  const response = { contentHash: result.contentHash };
  assertResponseContract("uploadJobDeliverable", 201, response);
  return jsonResponse(context, 201, response);
}

function providerRequest(
  context: ServerContext,
  kind: "brief" | "upload",
): {
  address: string;
  request: {
    jobKey: `0x${string}`;
    issuedAt: bigint;
    signature: `0x${string}`;
    providerAddress: `0x${string}`;
  };
} {
  const jobKey = context.req.param("jobKey") ?? "";
  const address = context.req.header("X-Czar-Provider-Address") ?? "";
  const issuedAt =
    context.req.header(kind === "brief" ? "X-Czar-Brief-Issued-At" : "X-Czar-Upload-Issued-At") ??
    "";
  const signature =
    context.req.header(kind === "brief" ? "X-Czar-Brief-Signature" : "X-Czar-Upload-Signature") ??
    "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(jobKey) || !/^0x[0-9a-fA-F]{40}$/.test(address))
    throw new RequestValidationError();
  if (!/^\d+$/.test(issuedAt) || !/^0x[0-9a-fA-F]+$/.test(signature))
    throw new RequestValidationError();
  return {
    address,
    request: {
      jobKey: jobKey as `0x${string}`,
      issuedAt: BigInt(issuedAt),
      signature: signature as `0x${string}`,
      providerAddress: address as `0x${string}`,
    },
  };
}

async function readLimitedBody(
  context: ServerContext,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const reader = context.req.raw.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function soulPointerRoute(context: ServerContext): Response {
  const body = {
    available: false as const,
    message:
      "Open the Czar viewer on your computer to tell Czar about your work (about five minutes, optional).",
    desktopUrl: "http://127.0.0.1/soul" as const,
  };
  assertExchange("getSoulPointer", undefined, 200, body);
  return jsonResponse(context, 200, body);
}

function appReadDependencies(dependencies: AppDependencies) {
  return {
    pool: dependencies.pool,
    config: dependencies.config,
    ...(dependencies.appReadOptions ? { options: dependencies.appReadOptions } : {}),
  };
}

function appAuthDependencies(dependencies: AppDependencies) {
  return {
    ...dependencies,
    rpcUrl: dependencies.config.get("app.arcRpcUrl") as string,
    origin: dependencies.config.get("app.origin") as string,
  };
}

async function appRateLimit(
  context: ServerContext,
  next: () => Promise<void>,
  deps: AppDependencies,
): Promise<Response | void> {
  const userId = context.get("appUserId") as string | undefined;
  if (!userId) return problemResponse(context, 401, "session-expired");
  const rate = await applyRateLimit(deps.pool, deps.config, deps.clock.now(), "app", userId);
  setRateHeaders(context, rate);
  if (!rate.allowed) return problemResponse(context, 429, "rate-limited", true);
  await next();
}

async function publicAuthRoute(
  context: ServerContext,
  dependencies: AppDependencies & { origin: string; rpcUrl: string },
  route: (
    context: ServerContext,
    dependencies: AppDependencies & { origin: string; rpcUrl: string },
  ) => Promise<Response>,
): Promise<Response> {
  const ip =
    context.req.header("CF-Connecting-IP") ?? context.req.header("X-Forwarded-For") ?? "unknown";
  const rate = await applyRateLimit(
    dependencies.pool,
    dependencies.config,
    dependencies.clock.now(),
    "app-auth",
    digest(ip),
  );
  setRateHeaders(context, rate);
  if (!rate.allowed) return problemResponse(context, 429, "rate-limited", true);
  return route(context, dependencies);
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
    `SELECT o.objective_id,o.state,o.updated_at,o.envelope_ref,
            p.plan_id,p.plan->>'cap' AS plan_cap,
            p.plan->>'category' AS plan_category,
            jsonb_array_length(p.plan->'steps') AS plan_step_count
     FROM objectives o LEFT JOIN plans p ON p.plan_id=o.plan_id
     WHERE o.objective_id=$1 AND o.device_id=$2`,
    [objectiveId, auth.principal.deviceId],
  );
  if (!found.rowCount) return problemResponse(context, 404, "validation");
  const row = found.rows[0] as {
    objective_id: string;
    state: string;
    updated_at: Date;
    envelope_ref: string | null;
    plan_id: string | null;
    plan_cap: string | null;
    plan_category: string | null;
    plan_step_count: number | null;
  };
  const planId = row.plan_id;
  const planSummary = planId
    ? await objectivePlanSummary({ ...row, plan_id: planId }, deps)
    : undefined;
  const response = {
    objectiveId: row.objective_id,
    status: row.state,
    ...(planSummary ? { planSummary } : {}),
    updatedAt: row.updated_at.toISOString(),
  };
  assertExchange("getObjective", undefined, 200, response);
  return jsonResponse(context, 200, response);
}

async function objectivePlanSummary(
  row: {
    plan_id: string;
    plan_cap: string | null;
    plan_category: string | null;
    plan_step_count: number | null;
    envelope_ref: string | null;
  },
  dependencies: AppDependencies,
) {
  if (row.plan_cap === null || row.plan_category === null || row.plan_step_count === null) {
    throw new Error(`Stored plan ${row.plan_id} is missing summary fields.`);
  }
  const spent = row.envelope_ref ? await readEnvelopeSpent(row.envelope_ref, dependencies) : "0";
  return {
    planId: row.plan_id,
    cap: row.plan_cap,
    category: row.plan_category,
    stepCount: row.plan_step_count,
    ...(spent === undefined ? {} : { spent }),
  };
}

async function readEnvelopeSpent(
  envelopeRef: string,
  dependencies: AppDependencies,
): Promise<string | undefined> {
  const indexerUrl = dependencies.appReadOptions?.indexerUrl;
  if (!indexerUrl) {
    dependencies.logger.warn("objective_spent_lookup_unavailable", {
      rule: "objective-spent-indexer",
      state: "indexer-unavailable",
    });
    return undefined;
  }
  try {
    const response = await fetch(
      new URL(`/envelopes/${encodeURIComponent(envelopeRef)}`, indexerUrl),
      { signal: AbortSignal.timeout(Number(dependencies.config.get("fetch.timeoutMs"))) },
    );
    if (!response.ok) throw new Error(`Indexer returned ${response.status}.`);
    const body = (await response.json()) as { envelope?: unknown };
    if (!body.envelope || !validateEnvelope(body.envelope)) {
      throw new Error("Indexer returned an invalid envelope.");
    }
    if (body.envelope.envelopeRef !== envelopeRef) {
      throw new Error("Indexer returned a different envelope.");
    }
    return body.envelope.spent;
  } catch {
    dependencies.logger.warn("objective_spent_lookup_unavailable", {
      rule: "objective-spent-indexer",
      state: "indexer-unavailable",
    });
    return undefined;
  }
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

function assertResponseContract(operationId: string, status: number, body: unknown): void {
  const validator = apiContracts.get(operationId)?.responses.get(String(status));
  if (!validator || !validator(body))
    throw new Error(`Server response failed ${operationId} contract validation.`);
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
  if (method === "GET" && path === "/v1/app/wallet-config") return "getAppWalletConfig";
  if (method === "GET" && path === "/v1/me") return "getMe";
  if (method === "GET" && path === "/v1/envelopes") return "listEnvelopes";
  if (method === "GET" && /^\/v1\/envelopes\/[^/]+$/.test(path)) return "getEnvelope";
  if (method === "GET" && path === "/v1/ledger/receipts") return "listReceipts";
  if (method === "GET" && path === "/v1/pockets/manual-returns") return "listManualReturns";
  if (method === "POST" && path === "/v1/auth/challenge") return "createAuthChallenge";
  if (method === "POST" && path === "/v1/auth/passkey") return "registerPasskey";
  if (method === "POST" && path === "/v1/auth/session") return "createSession";
  if (method === "POST" && path === "/v1/devices/pair") return "pairDevice";
  if (method === "POST" && path === "/v1/devices/pairing-codes") return "createPairingCode";
  if (method === "GET" && path === "/v1/devices") return "listDevices";
  if (method === "POST" && /^\/v1\/devices\/[^/]+\/revoke$/.test(path)) return "revokeDevice";
  if (method === "POST" && path === "/v1/objectives") return "submitObjective";
  if (method === "POST" && /^\/v1\/objectives\/[^/]+\/results\/ack$/.test(path)) return "ackResult";
  if (method === "POST" && path === "/v1/models/complete") return "completeModelCall";
  if (method === "GET" && path === "/v1/objectives") return "listObjectives";
  if (method === "GET" && path.startsWith("/v1/objectives/")) return "getObjective";
  if (method === "GET" && /^\/v1\/results\/[^/]+$/.test(path)) return "getResult";
  if (method === "GET" && /^\/v1\/jobs\/[^/]+\/brief$/.test(path)) return "getJobBrief";
  if (method === "POST" && /^\/v1\/jobs\/[^/]+\/deliverable$/.test(path))
    return "uploadJobDeliverable";
  if (method === "GET" && path === "/v1/soul/pointer") return "getSoulPointer";
  if (method === "GET" && path === "/v1/approvals") return "listApprovals";
  if (method === "GET" && /^\/v1\/approvals\/[^/]+$/.test(path)) return "getApproval";
  if (method === "POST" && /^\/v1\/approvals\/[^/]+\/intent$/.test(path)) {
    return "createApprovalIntent";
  }
  if (method === "POST" && /^\/v1\/approvals\/[^/]+\/submitted$/.test(path)) {
    return "notifySubmitted";
  }
  if (method === "POST" && path === "/v1/freeze/intent") return "createFreezeIntent";
  return "unknown";
}

function isDeviceOperation(operationId: string): boolean {
  return ["pairDevice", "createPairingCode", "listDevices", "revokeDevice"].includes(operationId);
}
