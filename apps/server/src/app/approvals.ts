import { createHash } from "node:crypto";
import { apiContracts, validateRecordedExchange } from "@czar/api-contract";
import type { Config } from "@czar/config";
import { categoryHash, jcsString } from "@czar/hashing";
import type {
  ApprovalIntent,
  AppPlan,
  Plan,
  SubjectsRevision,
  SubmittedNotice,
} from "@czar/schemas";
import type { ApprovalSummary, AppPage } from "@czar/schemas";
import { encodeOpenEnvelope } from "@czar/vault-client";
import type { Context } from "hono";
import type { Pool } from "pg";
import { createPublicClient, defineChain, http, type Address } from "viem";
import { getVault, getVaultFactory } from "@czar/vault-client";
import type { AppReadOptions } from "#src/app/reads";
import { problem, type CzarCode } from "#src/http/problem";
import { findOrCreateIdempotency, fingerprintRequest } from "#src/http/idempotency";
import { parseIdempotencyKey, RequestValidationError } from "#src/http/validate";

interface ApprovalDependencies {
  readonly pool: Pool;
  readonly config: Config;
  readonly clock: { now(): Date };
  readonly appReadOptions?: AppReadOptions;
  readonly revisePlanSubjects?: (
    userId: string,
    planId: string,
    revision: SubjectsRevision,
  ) => Promise<Plan | null>;
}

type ServerContext = Context<any, any, any>;

export async function getApprovalRoute(
  context: ServerContext,
  dependencies: ApprovalDependencies,
): Promise<Response> {
  const userId = context.get("appUserId") as string | undefined;
  if (!userId) return problemResponse(context, 401, "validation");
  const found = await dependencies.pool.query<{ plan: AppPlan }>(
    `SELECT p.plan FROM plans p
     JOIN objectives o ON o.objective_id=p.objective_id
     WHERE p.plan_id=$1 AND o.user_id=$2`,
    [context.req.param("planId"), userId],
  );
  const plan = found.rows[0]?.plan;
  if (!plan) return problemResponse(context, 404, "validation");
  assertExchange("getApproval", 200, plan);
  return context.json(plan);
}

export async function listApprovalsRoute(
  context: ServerContext,
  dependencies: ApprovalDependencies,
): Promise<Response> {
  const userId = context.get("appUserId") as string | undefined;
  if (!userId) return problemResponse(context, 401, "session-expired");
  const params = new URL(context.req.url).searchParams;
  const status = params.get("status") ?? "pending";
  if (!isApprovalStatus(status)) throw new RequestValidationError();
  const limit = Number(params.get("limit") ?? dependencies.config.get("api.pageDefaultLimit"));
  if (
    !Number.isSafeInteger(limit) ||
    limit < Number(dependencies.config.get("api.pageMinLimit")) ||
    limit > Number(dependencies.config.get("api.pageMaxLimit"))
  ) {
    throw new RequestValidationError();
  }
  const cursor = decodeApprovalCursor(params.get("cursor"));
  const rows = await dependencies.pool.query<ApprovalRow>(
    `SELECT p.plan_id,p.plan,p.state AS plan_state,o.objective_id,o.state AS objective_state,
            o.submission,p.created_at,$2::text AS status
     FROM plans p JOIN objectives o ON o.objective_id=p.objective_id
     WHERE o.user_id=$1 AND (
       ($2='pending' AND p.state='offered' AND o.state='awaiting-approval'
         AND NOT EXISTS (SELECT 1 FROM outbox_events e WHERE e.name='approval.intent-issued'
           AND e.objective_id=o.objective_id)) OR
       ($2='intent-issued' AND p.state='offered' AND o.state='awaiting-approval'
         AND EXISTS (SELECT 1 FROM outbox_events e WHERE e.name='approval.intent-issued'
           AND e.objective_id=o.objective_id)) OR
       ($2='submitted' AND p.state='approved' AND o.state='opening') OR
       ($2='opened' AND o.envelope_ref IS NOT NULL) OR
       ($2='expired' AND p.state='expired') OR
       ($2='declined' AND o.state='dismissed'))
       AND ($3::timestamptz IS NULL OR (p.created_at,p.plan_id)<($3,$4))
     ORDER BY p.created_at DESC,p.plan_id DESC LIMIT $5`,
    [userId, status, cursor?.createdAt ?? null, cursor?.planId ?? null, limit + 1],
  );
  const hasMore = rows.rows.length > limit;
  const pageRows = rows.rows.slice(0, limit);
  const items = pageRows.map(toApprovalSummary);
  const last = pageRows.at(-1);
  const response: AppPage<ApprovalSummary> = {
    items,
    nextCursor: hasMore && last ? encodeApprovalCursor(last) : null,
  };
  if (status === "pending") {
    context.header(
      "X-Czar-Pending-Poll-Seconds",
      String(dependencies.config.get("app.pendingPollSeconds")),
    );
    context.header(
      "X-Czar-Approval-Confirm-Timeout-Seconds",
      String(dependencies.config.get("app.approvalConfirmTimeoutSeconds")),
    );
  }
  assertExchange("listApprovals", 200, response);
  return context.json(response);
}

export async function revisePlanSubjectsRoute(
  context: ServerContext,
  dependencies: ApprovalDependencies,
): Promise<Response> {
  const userId = context.get("appUserId") as string | undefined;
  if (!userId) return problemResponse(context, 401, "session-expired");
  if (!dependencies.revisePlanSubjects)
    return problemResponse(context, 503, "upstream-unavailable");
  const key = parseIdempotencyKey(context.req.header("Idempotency-Key"));
  const raw = await optionalJson(context);
  const validator = apiContracts.get("revisePlanSubjects")?.request;
  if (!validator || !validator(raw.value)) throw new RequestValidationError();
  const revision = raw.value as SubjectsRevision;
  const planId = context.req.param("planId");
  if (!planId) return problemResponse(context, 404, "validation");
  const client = await dependencies.pool.connect();
  try {
    await client.query("BEGIN");
    const scope = `revisePlanSubjects:${userId}:${planId}`;
    const fingerprint = fingerprintRequest(raw.bytes);
    const saved = await findOrCreateIdempotency(client, dependencies.config, {
      scope,
      key,
      fingerprint,
      now: dependencies.clock.now(),
    });
    if (!saved.fingerprint.equals(fingerprint)) {
      return await finishAppProblem(client, context, 409, "idempotency-conflict");
    }
    if (saved.status !== null) {
      if (
        !saved.response_body ||
        !saved.response_hash ||
        !sameResponseHash(saved.response_body, saved.response_hash)
      ) {
        return await finishAppProblem(client, context, 409, "replay-not-stored");
      }
      await client.query("COMMIT");
      return context.json(saved.response_body, saved.status as 200);
    }
    const revised = await dependencies.revisePlanSubjects(userId, planId, revision);
    if (!revised) {
      await client.query("ROLLBACK");
      return context.json(problem(422, "validation"), 422, {
        "Content-Type": "application/problem+json",
      });
    }
    const owned = await client.query(
      "SELECT 1 FROM objectives WHERE objective_id=$1 AND user_id=$2",
      [revised.objectiveId, userId],
    );
    if (!owned.rowCount) return await finishAppProblem(client, context, 404, "validation");
    assertExchange("revisePlanSubjects", 200, revised, revision);
    await client.query(
      `UPDATE idempotency SET status=200,response_body=$3::jsonb,response_hash=$4
       WHERE scope=$1 AND key=$2`,
      [scope, key, JSON.stringify(revised), responseDigest(revised)],
    );
    await client.query("COMMIT");
    return context.json(revised);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createApprovalIntentRoute(
  context: ServerContext,
  dependencies: ApprovalDependencies,
): Promise<Response> {
  const userId = context.get("appUserId") as string | undefined;
  if (!userId) return problemResponse(context, 401, "session-expired");
  const key = parseIdempotencyKey(context.req.header("Idempotency-Key"));
  const raw = await optionalJson(context);
  const body = raw.value;
  const validator = apiContracts.get("createApprovalIntent")?.request;
  if (!validator || !validator(body)) throw new RequestValidationError();
  const client = await dependencies.pool.connect();
  try {
    await client.query("BEGIN");
    const scope = `createApprovalIntent:${userId}:${context.req.param("planId")}`;
    const fingerprint = fingerprintRequest(raw.bytes);
    const saved = await findOrCreateIdempotency(client, dependencies.config, {
      scope,
      key,
      fingerprint,
      now: dependencies.clock.now(),
    });
    if (!saved.fingerprint.equals(fingerprint)) {
      return await finishAppProblem(client, context, 409, "idempotency-conflict");
    }
    if (saved.status !== null) {
      if (
        !saved.response_body ||
        !saved.response_hash ||
        !sameResponseHash(saved.response_body, saved.response_hash)
      ) {
        return await finishAppProblem(client, context, 409, "replay-not-stored");
      }
      await client.query("COMMIT");
      return context.json(saved.response_body, saved.status as 200);
    }
    const found = await client.query<{
      objective_id: string;
      plan: AppPlan;
      state: string;
      vault: string | null;
      network: string;
    }>(
      `SELECT o.objective_id,p.plan,p.state,u.vault,u.network FROM plans p
       JOIN objectives o ON o.objective_id=p.objective_id
       JOIN users u ON u.user_id=o.user_id
       WHERE p.plan_id=$1 AND o.user_id=$2 FOR UPDATE OF p,o`,
      [context.req.param("planId"), userId],
    );
    const row = found.rows[0];
    if (!row || !row.vault) return await finishAppProblem(client, context, 404, "validation");
    if (
      row.state !== "offered" ||
      Date.parse(row.plan.expiresAt) <= dependencies.clock.now().getTime()
    ) {
      return await finishAppProblem(client, context, 409, "plan-expired");
    }
    const unavailable = await approvalUnavailable(row, dependencies.appReadOptions);
    if (unavailable) return await finishAppProblem(client, context, 409, unavailable);
    const response = intentForPlan(row.plan, row.vault);
    assertExchange("createApprovalIntent", 200, response, body);
    await client.query(
      `INSERT INTO outbox_events (name,objective_id,payload)
       SELECT 'approval.intent-issued',$1,$2::jsonb
       WHERE NOT EXISTS (SELECT 1 FROM outbox_events e WHERE e.name='approval.intent-issued'
         AND e.objective_id=$1)`,
      [row.objective_id, JSON.stringify({ planId: row.plan.planId })],
    );
    await client.query(
      `UPDATE idempotency SET status=200,response_body=$3::jsonb,response_hash=$4
       WHERE scope=$1 AND key=$2`,
      [scope, key, JSON.stringify(response), responseDigest(response)],
    );
    await client.query("COMMIT");
    return context.json(response);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function approvalUnavailable(
  row: { readonly plan: AppPlan; readonly vault: string | null; readonly network: string },
  options: AppReadOptions | undefined,
): Promise<"paused" | "frozen" | "insufficient-free-balance" | undefined> {
  if (!options || !row.vault) return undefined;
  const chainId = Number(row.network.split(":")[1]);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error("Cannot check approval availability for an unsupported network.");
  }
  const chain = defineChain({
    id: chainId,
    name: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
    rpcUrls: { default: { http: [options.rpcUrl] } },
  });
  const client = createPublicClient({ chain, transport: http(options.rpcUrl) });
  const blockNumber = await client.getBlockNumber();
  const vault = getVault(row.vault as Address, client);
  const factory = getVaultFactory(options.factoryAddress, client);
  const [paused, frozen, free] = await Promise.all([
    factory.read.guardianPaused({ blockNumber }),
    vault.read.frozen({ blockNumber }),
    vault.read.freeBalance({ blockNumber }),
  ]);
  if (paused) return "paused";
  if (frozen) return "frozen";
  if (free < BigInt(row.plan.cap)) return "insufficient-free-balance";
  return undefined;
}

export async function notifySubmittedRoute(
  context: ServerContext,
  dependencies: ApprovalDependencies,
): Promise<Response> {
  const userId = context.get("appUserId") as string | undefined;
  if (!userId) return problemResponse(context, 401, "session-expired");
  parseIdempotencyKey(context.req.header("Idempotency-Key"));
  const body = (await optionalJson(context)).value;
  const validator = apiContracts.get("notifySubmitted")?.request;
  if (!validator || !validator(body)) throw new RequestValidationError();
  const exchange = validateRecordedExchange("notifySubmitted", {
    requestBody: body,
    responseStatus: 202,
  });
  if (!exchange.valid)
    throw new Error("Server response failed notifySubmitted contract validation.");
  const notice = body as SubmittedNotice;
  const client = await dependencies.pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<{
      objective_id: string;
      objective_state: string;
      plan_state: string;
    }>(
      `SELECT o.objective_id,o.state AS objective_state,p.state AS plan_state
       FROM plans p JOIN objectives o ON o.objective_id=p.objective_id
       WHERE p.plan_id=$1 AND o.user_id=$2 FOR UPDATE OF o,p`,
      [context.req.param("planId"), userId],
    );
    const row = found.rows[0];
    if (!row) return await finishAppProblem(client, context, 404, "validation");
    const existing = await client.query<{ payload: { userOpHash?: string } }>(
      `SELECT payload FROM outbox_events WHERE name='approval.submitted' AND objective_id=$1`,
      [row.objective_id],
    );
    if (existing.rowCount) {
      const currentHash = existing.rows[0]?.payload.userOpHash;
      if (currentHash?.toLowerCase() !== notice.userOpHash.toLowerCase()) {
        return await finishAppProblem(client, context, 409, "idempotency-conflict");
      }
      await client.query("COMMIT");
      return context.body(null, 202);
    }
    if (row.objective_state !== "awaiting-approval" || row.plan_state !== "offered") {
      return await finishAppProblem(client, context, 409, "validation");
    }
    await client.query("UPDATE plans SET state='approved',updated_at=$2 WHERE plan_id=$1", [
      context.req.param("planId"),
      dependencies.clock.now(),
    ]);
    await client.query(
      "UPDATE objectives SET state='opening',updated_at=$2 WHERE objective_id=$1",
      [row.objective_id, dependencies.clock.now()],
    );
    await client.query(
      `INSERT INTO outbox_events (name,objective_id,payload)
       VALUES ('approval.submitted',$1,$2::jsonb)`,
      [row.objective_id, JSON.stringify(notice)],
    );
    await client.query("COMMIT");
    return context.body(null, 202);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function intentForPlan(plan: AppPlan, vault: string): ApprovalIntent {
  const [namespace, rawChainId] = plan.network.split(":");
  const chainId = Number(rawChainId);
  if (namespace !== "eip155" || !Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error("Cannot create approval intent for an unsupported plan network.");
  }
  const expiresAt = Math.floor(Date.parse(plan.expiresAt) / 1000);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    throw new Error("Cannot create approval intent for an invalid plan expiry.");
  }
  const decoded = {
    cap: plan.cap,
    maxStepAmount: plan.maxStepAmount,
    pocketCapBps: plan.pocketCapBps,
    expiresAt,
    categoryId: categoryHash(plan.category),
    objectiveHash: plan.objectiveHash as `0x${string}`,
    planHash: plan.planHash as `0x${string}`,
    payeeRoot: plan.payeeRoot as `0x${string}`,
  };
  const address = vault as `0x${string}`;
  return {
    planId: plan.planId,
    planHash: decoded.planHash,
    objectiveHash: decoded.objectiveHash,
    payeeRoot: decoded.payeeRoot,
    vault: address,
    to: address,
    calldata: encodeOpenEnvelope({
      cap: BigInt(decoded.cap),
      maxStepAmount: BigInt(decoded.maxStepAmount),
      pocketCapBps: decoded.pocketCapBps,
      expiresAt: BigInt(decoded.expiresAt),
      categoryId: decoded.categoryId,
      objectiveHash: decoded.objectiveHash,
      planHash: decoded.planHash,
      payeeRoot: decoded.payeeRoot,
    }),
    value: "0",
    chainId,
    decoded,
    expiresAt: plan.expiresAt,
  };
}

interface ApprovalRow {
  readonly plan_id: string;
  readonly plan: AppPlan;
  readonly plan_state: string;
  readonly objective_id: string;
  readonly objective_state: string;
  readonly submission: { readonly goal?: string };
  readonly created_at: Date;
  readonly status: ApprovalSummary["status"];
}

function toApprovalSummary(row: ApprovalRow): ApprovalSummary {
  return {
    planId: row.plan_id,
    objectiveId: row.objective_id,
    goal: row.submission.goal ?? "",
    cap: row.plan.cap,
    capDisplay: formatUsd(row.plan.cap),
    category: row.plan.category,
    stepCount: row.plan.steps.length,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.plan.expiresAt,
    status: row.status,
  };
}

function formatUsd(amount: string): string {
  const value = BigInt(amount);
  const whole = (value / 1_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let fraction = (value % 1_000_000n).toString().padStart(6, "0");
  while (fraction.length > 2 && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  return `$${whole}.${fraction}`;
}

function isApprovalStatus(value: string): value is ApprovalSummary["status"] {
  return ["pending", "intent-issued", "submitted", "opened", "expired", "declined"].includes(value);
}

function decodeApprovalCursor(value: string | null): { createdAt: string; planId: string } | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      createdAt?: unknown;
      planId?: unknown;
    };
    if (
      typeof parsed.createdAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.createdAt)) ||
      typeof parsed.planId !== "string"
    ) {
      throw new RequestValidationError();
    }
    return { createdAt: parsed.createdAt, planId: parsed.planId };
  } catch (error) {
    if (error instanceof RequestValidationError) throw error;
    throw new RequestValidationError();
  }
}

function encodeApprovalCursor(row: ApprovalRow): string {
  return Buffer.from(
    JSON.stringify({ createdAt: row.created_at.toISOString(), planId: row.plan_id }),
  ).toString("base64url");
}

async function optionalJson(context: ServerContext): Promise<{ value: unknown; bytes: Buffer }> {
  const bytes = Buffer.from(await context.req.raw.clone().arrayBuffer());
  if (bytes.length === 0) return { value: {}, bytes };
  const contentType = context.req.header("Content-Type");
  if (!contentType?.toLowerCase().startsWith("application/json")) {
    throw new RequestValidationError();
  }
  try {
    return { value: JSON.parse(bytes.toString("utf8")) as unknown, bytes };
  } catch {
    throw new RequestValidationError();
  }
}

function responseDigest(body: object): Buffer {
  return createHash("sha256").update(jcsString(body)).digest();
}

function sameResponseHash(body: object, storedHash: Buffer): boolean {
  return responseDigest(body).equals(storedHash);
}

async function finishAppProblem(
  client: import("pg").PoolClient,
  context: ServerContext,
  status: 404 | 409,
  code: CzarCode,
): Promise<Response> {
  await client.query("ROLLBACK");
  return problemResponse(context, status, code);
}

function assertExchange(
  operationId: string,
  responseStatus: number,
  responseBody: unknown,
  requestBody?: unknown,
): void {
  const result = validateRecordedExchange(operationId, {
    ...(requestBody === undefined ? {} : { requestBody }),
    responseStatus,
    responseBody,
  });
  if (!result.valid) throw new Error(`Server response failed ${operationId} contract validation.`);
}

function problemResponse(context: ServerContext, status: number, czarCode: CzarCode): Response {
  return context.json(
    problem(status, czarCode, false, context.req.path),
    status as 400 | 401 | 404 | 409 | 429,
    { "Content-Type": "application/problem+json" },
  );
}
