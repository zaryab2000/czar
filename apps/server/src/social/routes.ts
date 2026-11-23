import { createHash } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Pool, PoolClient } from "pg";
import { apiContracts, validateRecordedExchange } from "@czar/api-contract";
import type { Config } from "@czar/config";
import { jcsString } from "@czar/hashing";
import { validateSocialLeadCard } from "@czar/schemas";
import { regexScreen } from "#src/boundary/index";
import { appSessionVerifier, digest } from "#src/http/auth";
import { findOrCreateIdempotency, fingerprintRequest } from "#src/http/idempotency";
import { randomId, ulid, type RandomSource } from "#src/http/ids";
import { parseIdempotencyKey, RequestValidationError } from "#src/http/validate";
import { listFeedPosts, listThreadPosts, tombstonePost } from "#src/social/posts";
import { findOrCreateRepresentative, updateRepresentative } from "#src/social/representatives";
import { getIncident, getThread, listIncidents, listThreads } from "#src/social/threads";

interface Dependencies {
  pool: Pool;
  config: Config;
  clock: { now(): Date };
  random: RandomSource;
}

type ServerContext = Context<any, any, any>;
type MutationResult = { status: 200 | 202 | 204; body: Record<string, unknown> };

class SocialError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function respond(
  context: ServerContext,
  operation: string,
  status: number,
  body: unknown,
  requestBody?: unknown,
): Response {
  const valid = validateRecordedExchange(operation, {
    ...(requestBody === undefined ? {} : { requestBody }),
    responseStatus: status,
    ...(status === 204 ? {} : { responseBody: body }),
  });
  if (!valid.valid)
    throw new Error(
      `Social ${operation} response violates API contract: ${valid.errors.join(", ")}`,
    );
  return status === 204
    ? context.body(null, 204)
    : context.json(body, status as ContentfulStatusCode);
}

function fail(context: ServerContext, error: SocialError): Response {
  const body = {
    type: `https://czar.dev/problems/${error.code}`,
    title: error.code,
    status: error.status,
    detail: error.code,
    czarCode: error.code,
    retryable: error.status === 429,
  };
  const operation = operationFor(context.req.method, context.req.path);
  const contract = operation ? apiContracts.get(operation) : undefined;
  const validator = contract?.responses.get(String(error.status)) ?? contract?.responses.get("4XX");
  if (validator && !validator(body)) throw new Error(`Invalid ${operation} problem response.`);
  return context.json(body, error.status as ContentfulStatusCode, {
    "Content-Type": "application/problem+json",
  });
}

const OPERATIONS: readonly [string, RegExp, string][] = [
  ["GET", /^\/v1\/social\/feed$/, "listSocialFeed"],
  ["GET", /^\/v1\/social\/threads$/, "listSocialThreads"],
  ["GET", /^\/v1\/social\/threads\/[^/]+$/, "getSocialThread"],
  ["GET", /^\/v1\/social\/incidents$/, "listSocialIncidents"],
  ["GET", /^\/v1\/social\/services\/[^/]+\/signals$/, "getSocialServiceSignals"],
  ["GET", /^\/v1\/social\/me$/, "getSocialMe"],
  ["PUT", /^\/v1\/social\/me$/, "updateSocialMe"],
  ["GET", /^\/v1\/social\/me\/activity$/, "listSocialActivity"],
  ["GET", /^\/v1\/social\/me\/lessons$/, "listSocialLessons"],
  ["DELETE", /^\/v1\/social\/me\/lessons\/[^/]+$/, "dismissSocialLesson"],
  ["POST", /^\/v1\/social\/leads$/, "suggestSocialLead"],
  ["DELETE", /^\/v1\/social\/posts\/[^/]+$/, "deleteSocialPost"],
];

function operationFor(method: string, path: string): string | undefined {
  return OPERATIONS.find(
    ([routeMethod, pattern]) => routeMethod === method && pattern.test(path),
  )?.[2];
}

function validateRequest(operation: string, body: unknown): void {
  const validator = apiContracts.get(operation)?.request;
  if (!validator || !validator(body)) throw new SocialError(400, "validation");
}

async function jsonRequest(
  context: ServerContext,
  operation: string,
): Promise<{ body: any; raw: Buffer }> {
  if (!context.req.header("Content-Type")?.toLowerCase().startsWith("application/json")) {
    throw new SocialError(400, "validation");
  }
  const raw = Buffer.from(await context.req.raw.clone().arrayBuffer());
  let body: unknown;
  try {
    body = JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    throw new SocialError(400, "validation");
  }
  validateRequest(operation, body);
  return { body, raw };
}

function queryPage(url: URL, config: Config): { limit: number; cursor?: string } {
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? Number(config.get("api.pageDefaultLimit")) : Number(rawLimit);
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (
    !Number.isSafeInteger(limit) ||
    limit < Number(config.get("api.pageMinLimit")) ||
    limit > Number(config.get("api.pageMaxLimit")) ||
    (cursor && cursor.length > 512)
  ) {
    throw new SocialError(400, "validation");
  }
  return { limit, ...(cursor ? { cursor } : {}) };
}

function optionalQuery(url: URL, key: string, pattern: RegExp): string | undefined {
  const value = url.searchParams.get(key) ?? undefined;
  if (value !== undefined && !pattern.test(value)) throw new SocialError(400, "validation");
  return value;
}

function owner(context: ServerContext): string {
  const userId = context.get("appUserId") as string | undefined;
  if (!userId) throw new SocialError(401, "session-expired");
  return userId;
}

function rateLimit(deps: Dependencies, publicRead: boolean): MiddlewareHandler {
  return async (context, next) => {
    const address = (context.env as { remoteAddr?: string } | undefined)?.remoteAddr ?? "unknown";
    const principal = publicRead ? address : owner(context);
    const surface = publicRead ? "social-public" : "app";
    const limit = Number(
      deps.config.get(
        publicRead ? "social.publicReadRateLimitPerMinute" : "api.rateLimitAppPerMin",
      ),
    );
    const now = deps.clock.now();
    const window = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    const row = await deps.pool.query<{ count: number }>(
      `INSERT INTO rate_limit_buckets(surface,principal_hash,window_start,count)
       VALUES($1,$2,$3,1) ON CONFLICT(surface,principal_hash,window_start)
       DO UPDATE SET count=rate_limit_buckets.count+1 RETURNING count`,
      [surface, digest(principal), window],
    );
    const count = row.rows[0]?.count ?? limit + 1;
    context.header("RateLimit-Limit", String(limit));
    context.header("RateLimit-Remaining", String(Math.max(0, limit - count)));
    context.header(
      "RateLimit-Reset",
      String(Math.ceil((window.getTime() + 60_000 - now.getTime()) / 1000)),
    );
    if (count > limit) return fail(context, new SocialError(429, "rate-limited"));
    return next();
  };
}

async function mutate(
  context: ServerContext,
  deps: Dependencies,
  operation: string,
  raw: Buffer,
  action: (client: PoolClient) => Promise<MutationResult>,
): Promise<Response> {
  let key: string;
  try {
    key = parseIdempotencyKey(context.req.header("Idempotency-Key"));
  } catch {
    throw new SocialError(400, "validation");
  }
  const userId = owner(context);
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const scope = `social:${operation}:${userId}:${context.req.path}`;
    const fingerprint = fingerprintRequest(raw);
    const saved = await findOrCreateIdempotency(client, deps.config, {
      scope,
      key,
      fingerprint,
      now: deps.clock.now(),
    });
    if (!saved.fingerprint.equals(fingerprint)) throw new SocialError(409, "idempotency-conflict");
    if (saved.status !== null) {
      const hash =
        saved.response_body && createHash("sha256").update(jcsString(saved.response_body)).digest();
      if (!hash || !saved.response_hash?.equals(hash))
        throw new SocialError(409, "replay-not-stored");
      const response = respond(
        context,
        operation,
        saved.status,
        saved.response_body,
        raw.length ? (JSON.parse(raw.toString("utf8")) as unknown) : undefined,
      );
      await client.query("COMMIT");
      return response;
    }
    const result = await action(client);
    const hash = createHash("sha256").update(jcsString(result.body)).digest();
    await client.query(
      `UPDATE idempotency SET status=$3,response_body=$4::jsonb,response_hash=$5
       WHERE scope=$1 AND key=$2`,
      [scope, key, result.status, JSON.stringify(result.body), hash],
    );
    const response = respond(
      context,
      operation,
      result.status,
      result.body,
      raw.length ? (JSON.parse(raw.toString("utf8")) as unknown) : undefined,
    );
    await client.query("COMMIT");
    return response;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function socialRoutes(deps: Dependencies): Hono {
  const app = new Hono();
  const publicLimit = rateLimit(deps, true);
  const ownerLimit = rateLimit(deps, false);
  const session = appSessionVerifier(deps.pool, deps.config);
  app.onError((error, context) =>
    fail(
      context,
      error instanceof SocialError
        ? error
        : error instanceof RequestValidationError
          ? new SocialError(400, "validation")
          : new SocialError(503, "upstream-unavailable"),
    ),
  );

  app.get("/feed", publicLimit, async (context) => {
    const url = new URL(context.req.url);
    const page = queryPage(url, deps.config);
    const kind = optionalQuery(url, "kind", /^(experience|question|reply|lead|system)$/);
    const network = optionalQuery(url, "network", /^eip155:[0-9]+$/);
    const response = await listFeedPosts(deps.pool, { ...page, kind, network });
    context.header("X-Czar-Social-Poll-Seconds", String(deps.config.get("social.webPollSeconds")));
    return respond(context, "listSocialFeed", 200, response);
  });
  app.get("/threads", publicLimit, async (context) => {
    const url = new URL(context.req.url);
    const page = queryPage(url, deps.config);
    const kind = optionalQuery(url, "kind", /^(service|question|incident)$/);
    const state = optionalQuery(url, "state", /^(open|closed|expired)$/);
    const serviceId = optionalQuery(url, "serviceId", /^svc_[0-9a-f]{32}$/);
    return respond(
      context,
      "listSocialThreads",
      200,
      await listThreads(deps.pool, { ...page, kind, state, serviceId }),
    );
  });
  app.get("/threads/:threadId", publicLimit, async (context) => {
    const threadId = context.req.param("threadId");
    if (!/^thr_[0-9A-HJKMNP-TV-Z]{26}$/.test(threadId ?? ""))
      throw new SocialError(400, "validation");
    const thread = await getThread(deps.pool, threadId!);
    if (!thread) throw new SocialError(404, "unknown-thread");
    const posts = await listThreadPosts(deps.pool, threadId!);
    const incident = thread.incidentId ? await getIncident(deps.pool, thread.incidentId) : null;
    return respond(context, "getSocialThread", 200, {
      thread,
      posts,
      ...(incident ? { incident } : {}),
    });
  });
  app.get("/incidents", publicLimit, async (context) => {
    const url = new URL(context.req.url);
    const page = queryPage(url, deps.config);
    const state = optionalQuery(url, "state", /^(open|closed)$/);
    const network = optionalQuery(url, "network", /^eip155:[0-9]+$/);
    return respond(
      context,
      "listSocialIncidents",
      200,
      await listIncidents(deps.pool, { ...page, state, network }),
    );
  });
  app.get("/services/:serviceId/signals", publicLimit, (context) => serviceSignals(context, deps));

  app.get("/me", session, ownerLimit, (context) => socialMe(context, deps));
  app.put("/me", session, ownerLimit, (context) => socialMeUpdate(context, deps));
  app.get("/me/activity", session, ownerLimit, (context) => socialActivity(context, deps));
  app.get("/me/lessons", session, ownerLimit, (context) => socialLessons(context, deps));
  app.delete("/me/lessons/:lessonId", session, ownerLimit, (context) =>
    dismissLesson(context, deps),
  );
  app.post("/leads", session, ownerLimit, (context) => suggestLead(context, deps));
  app.delete("/posts/:postId", session, ownerLimit, (context) => deletePost(context, deps));
  return app;
}

async function serviceSignals(context: ServerContext, deps: Dependencies): Promise<Response> {
  const serviceId = context.req.param("serviceId");
  const network = new URL(context.req.url).searchParams.get("network");
  if (!/^svc_[0-9a-f]{32}$/.test(serviceId ?? "") || !network || !/^eip155:[0-9]+$/.test(network)) {
    throw new SocialError(400, "validation");
  }
  const [thread, count, incident] = await Promise.all([
    deps.pool.query<{ thread_id: string }>(
      "SELECT thread_id FROM social_threads WHERE kind='service' AND network=$1 AND service_id=$2",
      [network, serviceId],
    ),
    deps.pool.query<{
      count: number;
      delivered: number;
      rated_bad: number;
      last_observed: string | null;
    }>(
      `SELECT count(*)::integer AS count,
         count(*) FILTER (WHERE p.card->>'deliveryOutcome'='delivered')::integer AS delivered,
         count(*) FILTER (WHERE p.card->>'rating'='bad')::integer AS rated_bad,
         max(p.card->>'observedAt') AS last_observed
       FROM social_posts p JOIN social_threads t ON t.thread_id=p.thread_id
       WHERE t.network=$1 AND t.service_id=$2 AND p.kind='experience'
         AND p.superseded_by IS NULL AND p.tombstoned_at IS NULL`,
      [network, serviceId],
    ),
    deps.pool.query<{ incident_id: string }>(
      `SELECT incident_id FROM social_incidents
       WHERE network=$1 AND service_id=$2 AND state='open' ORDER BY opened_at DESC LIMIT 1`,
      [network, serviceId],
    ),
  ]);
  const row = count.rows[0];
  const openIncident = incident.rows[0]
    ? await getIncident(deps.pool, incident.rows[0].incident_id)
    : null;
  return respond(context, "getSocialServiceSignals", 200, {
    serviceId,
    network,
    ...(openIncident ? { openIncident } : {}),
    threadId: thread.rows[0]?.thread_id ?? null,
    recentExperiences: {
      count: row?.count ?? 0,
      delivered: row?.delivered ?? 0,
      ratedBad: row?.rated_bad ?? 0,
    },
    lastObservedAt: row?.last_observed ?? null,
  });
}

function publicRepresentative(row: {
  representative_id: string;
  handle: string;
  sharing: string;
  paused: boolean;
  controlled: boolean;
  consent_text_version: string | null;
}): Record<string, unknown> {
  return {
    representativeId: row.representative_id,
    handle: row.handle,
    sharing: row.sharing,
    paused: row.paused,
    controlled: row.controlled,
    consentTextVersion: row.consent_text_version,
  };
}

async function socialMe(context: ServerContext, deps: Dependencies): Promise<Response> {
  const representative = await findOrCreateRepresentative(deps.pool, owner(context), deps.random);
  const stats = await deps.pool.query<{ posts: number; replies: number; lessons_active: number }>(
    `SELECT
       (SELECT count(*)::integer FROM social_posts WHERE author_id=$1 AND kind='experience'
         AND superseded_by IS NULL AND tombstoned_at IS NULL) AS posts,
       (SELECT count(*)::integer FROM social_posts WHERE author_id=$1 AND kind='reply'
         AND superseded_by IS NULL AND tombstoned_at IS NULL) AS replies,
       (SELECT count(*)::integer FROM social_lessons WHERE user_id=$2 AND state='active'
         AND expires_at>now()) AS lessons_active`,
    [representative.representative_id, representative.user_id],
  );
  return respond(context, "getSocialMe", 200, {
    representative: publicRepresentative(representative),
    stats: {
      posts: stats.rows[0]?.posts ?? 0,
      replies: stats.rows[0]?.replies ?? 0,
      lessonsActive: stats.rows[0]?.lessons_active ?? 0,
    },
  });
}

async function socialMeUpdate(context: ServerContext, deps: Dependencies): Promise<Response> {
  const { body, raw } = await jsonRequest(context, "updateSocialMe");
  return mutate(context, deps, "updateSocialMe", raw, async (client) => {
    const representative = await findOrCreateRepresentative(client, owner(context), deps.random);
    if (
      body.sharing !== undefined &&
      body.sharing !== representative.sharing &&
      body.consentTextVersion !== deps.config.get("social.consentTextVersion")
    ) {
      throw new SocialError(422, "consent-required");
    }
    const updated = await updateRepresentative(client, owner(context), body, deps.clock.now());
    if (!updated) throw new SocialError(404, "validation");
    return { status: 200, body: publicRepresentative(updated) };
  });
}

async function socialActivity(context: ServerContext, deps: Dependencies): Promise<Response> {
  const userId = owner(context);
  const page = queryPage(new URL(context.req.url), deps.config);
  const rows = await deps.pool.query<{
    run_id: string;
    kind: string;
    action: string;
    stop_reason: string;
    post_id: string | null;
    started_at: Date;
  }>(
    `SELECT r.run_id,i.kind,r.action,r.stop_reason,r.post_id,r.started_at
     FROM social_runs r JOIN social_inbox i ON i.inbox_id=r.inbox_id
     JOIN social_representatives rep ON rep.representative_id=r.representative_id
     WHERE rep.user_id=$1 AND ($2::text IS NULL OR (r.started_at,r.run_id)<
       (SELECT started_at,run_id FROM social_runs WHERE run_id=$2))
     ORDER BY r.started_at DESC,r.run_id DESC LIMIT $3`,
    [userId, page.cursor ?? null, page.limit + 1],
  );
  const items = rows.rows.slice(0, page.limit).map((row) => ({
    runId: row.run_id,
    kind: row.kind,
    action: row.action,
    stopReason: row.stop_reason,
    ...(row.post_id ? { postId: row.post_id } : {}),
    startedAt: row.started_at.toISOString(),
  }));
  return respond(context, "listSocialActivity", 200, {
    items,
    nextCursor: rows.rows.length > page.limit ? (rows.rows[page.limit - 1]?.run_id ?? null) : null,
  });
}

async function socialLessons(context: ServerContext, deps: Dependencies): Promise<Response> {
  const rows = await deps.pool.query<{
    lesson_id: string;
    network: string;
    service_id: string;
    task_class: string;
    proposition: string;
    strength: string;
    handle: string;
    expires_at: Date;
    state: string;
  }>(
    `SELECT l.lesson_id,l.network,l.service_id,l.task_class,l.proposition,
       l.strength,r.handle,l.expires_at,l.state
     FROM social_lessons l JOIN social_posts p ON p.post_id=l.source_post_id
     JOIN social_representatives r ON r.representative_id=p.author_id
     WHERE l.user_id=$1 ORDER BY l.created_at DESC LIMIT 200`,
    [owner(context)],
  );
  return respond(context, "listSocialLessons", 200, {
    lessons: rows.rows.map((row) => ({
      lessonId: row.lesson_id,
      network: row.network,
      serviceId: row.service_id,
      taskClass: row.task_class,
      proposition: row.proposition,
      strength: Number(row.strength),
      sourceHandle: row.handle,
      expiresAt: row.expires_at.toISOString(),
      state: row.state,
    })),
  });
}

async function dismissLesson(context: ServerContext, deps: Dependencies): Promise<Response> {
  const lessonId = context.req.param("lessonId");
  if (!/^les_[0-9A-HJKMNP-TV-Z]{26}$/.test(lessonId ?? ""))
    throw new SocialError(400, "validation");
  return mutate(context, deps, "dismissSocialLesson", Buffer.alloc(0), async (client) => {
    const changed = await client.query(
      "UPDATE social_lessons SET state='dismissed' WHERE lesson_id=$1 AND user_id=$2 RETURNING lesson_id",
      [lessonId, owner(context)],
    );
    if (!changed.rowCount) throw new SocialError(404, "unknown-lesson");
    return { status: 204, body: {} };
  });
}

function validateLeadOrigin(origin: string, config: Config): void {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new SocialError(400, "validation");
  }
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new SocialError(400, "validation");
  if (url.protocol === "http:") {
    const allowed = config.has("fetch.localMerchantOrigins")
      ? (config.get("fetch.localMerchantOrigins") as string[])
      : [];
    if (!/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(origin) || !allowed.includes(origin)) {
      throw new SocialError(400, "validation");
    }
    return;
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.port ||
    !/^[a-z0-9.-]+$/.test(host) ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    host.includes("..")
  ) {
    throw new SocialError(400, "validation");
  }
}

function validateLeadText(body: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(body)) {
    if (typeof value !== "string") continue;
    if (
      (field !== "origin" && /https?:\/\//i.test(value)) ||
      /(?:obs_|usr_|dev_|obj_|pln_|prq_|pay_)[0-9A-Za-z_]+/.test(value) ||
      /0x(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{40})(?![0-9a-fA-F])/.test(value) ||
      /\.(?:md|csv|xlsx?|docx?|json|txt)\b/i.test(value) ||
      regexScreen(value).some((flag) => flag !== "none")
    ) {
      throw new SocialError(400, "validation");
    }
  }
}

async function suggestLead(context: ServerContext, deps: Dependencies): Promise<Response> {
  const { body, raw } = await jsonRequest(context, "suggestSocialLead");
  validateLeadOrigin(body.origin, deps.config);
  validateLeadText(body);
  if (body.network !== deps.config.get("selection.paymentNetwork")) {
    throw new SocialError(400, "validation");
  }
  return mutate(context, deps, "suggestSocialLead", raw, async (client) => {
    const representative = await findOrCreateRepresentative(client, owner(context), deps.random);
    if (representative.sharing === "off" || representative.paused) {
      throw new SocialError(422, "consent-required");
    }
    const pathHint = body.pathHint ?? null;
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${body.network}:${body.origin}:${pathHint ?? ""}`,
    ]);
    const existing = await client.query<{ lead_id: string; post_id: string }>(
      `SELECT lead_id,post_id FROM social_leads
       WHERE network=$1 AND origin=$2 AND path_hint IS NOT DISTINCT FROM $3`,
      [body.network, body.origin, pathHint],
    );
    if (existing.rows[0])
      return {
        status: 202,
        body: {
          leadId: existing.rows[0].lead_id,
          postId: existing.rows[0].post_id,
        },
      };
    const budget = await client.query(
      `INSERT INTO social_budgets(representative_id,day,posts) VALUES($1,$2,1)
       ON CONFLICT(representative_id,day) DO UPDATE SET posts=social_budgets.posts+1
       WHERE social_budgets.posts<$3 RETURNING posts`,
      [
        representative.representative_id,
        deps.clock.now().toISOString().slice(0, 10),
        deps.config.get("social.repDailyPostCap"),
      ],
    );
    if (!budget.rowCount) throw new SocialError(429, "rate-limited");
    const threadId = randomId("thr_", deps.random);
    const postId = randomId("pst_", deps.random);
    const leadId = ulid("led_", deps.clock.now(), deps.random);
    const card = {
      cardVersion: "1",
      network: body.network,
      origin: body.origin,
      ...(pathHint ? { pathHint } : {}),
      capabilityTag: body.capabilityTag,
      ...(body.claimedOutputFormat ? { claimedOutputFormat: body.claimedOutputFormat } : {}),
      source: "owner-suggested",
    };
    if (!validateSocialLeadCard(card)) throw new SocialError(400, "validation");
    await client.query(
      `INSERT INTO social_threads(thread_id,kind,network,task_class,capability_tag,
        subject_key,opened_by,contributions,expires_at)
       VALUES($1,'question',$2,$3,$4,$5,$6,1,$7)`,
      [
        threadId,
        body.network,
        body.capabilityTag,
        body.capabilityTag,
        `question:${threadId}`,
        representative.representative_id,
        new Date(
          deps.clock.now().getTime() +
            Number(deps.config.get("social.questionLifetimeHours")) * 3_600_000,
        ),
      ],
    );
    await client.query(
      `INSERT INTO social_posts(post_id,thread_id,author_id,kind,card,action_id)
       VALUES($1,$2,$3,'lead',$4,$5)`,
      [
        postId,
        threadId,
        representative.representative_id,
        JSON.stringify(card),
        `owner-lead:${leadId}`,
      ],
    );
    await client.query(
      `INSERT INTO social_leads(lead_id,post_id,network,origin,path_hint,capability_tag)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [leadId, postId, body.network, body.origin, pathHint, body.capabilityTag],
    );
    await client.query(
      "INSERT INTO outbox_events(name,payload,delivered_at) VALUES('social.post.published',$1,now())",
      [JSON.stringify({ postId, threadId })],
    );
    return { status: 202, body: { leadId, postId } };
  });
}

async function deletePost(context: ServerContext, deps: Dependencies): Promise<Response> {
  const postId = context.req.param("postId");
  if (!/^pst_[0-9A-HJKMNP-TV-Z]{26}$/.test(postId ?? "")) throw new SocialError(400, "validation");
  return mutate(context, deps, "deleteSocialPost", Buffer.alloc(0), async (client) => {
    const result = await tombstonePost(client, postId!, owner(context), deps.clock.now());
    if (result === "unknown") throw new SocialError(404, "unknown-post");
    if (result === "not-your-post") throw new SocialError(403, "not-your-post");
    return { status: 204, body: {} };
  });
}
