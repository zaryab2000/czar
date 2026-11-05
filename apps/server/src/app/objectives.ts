// Tasks a signed-in owner starts in the browser (SCR-181 §1–§5, UX-01). The server builds the objective
// submission itself and hands it to the same intake as POST /v1/objectives (validation, objectiveHash,
// outbox `objective.received`), inside one transaction that also holds this route's own idempotency record
// and the user's one web device. Layer 1 redaction runs over the title, description and source before
// anything is stored; layer 2 does not run on this path (SCR-181 §4). Nothing here logs user text.
import { createHash, randomBytes } from "node:crypto";
import type { Config } from "@czar/config";
import { H, jcsString, objectiveHash, taskSpecHash } from "@czar/hashing";
import { redactSecrets } from "@czar/redaction";
import {
  validateSchema,
  type AppObjective,
  type AppObjectiveRequest,
  type ObjectiveSubmission,
  type TaskSpec,
} from "@czar/schemas";
import type { Pool, PoolClient } from "pg";
import { findOrCreateIdempotency, fingerprintRequest } from "#src/http/idempotency";
import { ulid, type RandomSource } from "#src/http/ids";
import { RequestValidationError } from "#src/http/validate";
import { hashesMatch, submitWithinTransaction } from "#src/objectives/service";

/** `soulVersionHash` for a browser task: there is no local soul on the web (SCR-181 §3). */
export const WEB_NO_SOUL = H("czar.web-objective.no-soul.v1");
const WEB_DEVICE_NAME = "Browser";
/** The audit report's columns (SCR-181 §3). */
const AUDIT_FIELDS = ["severity", "location", "issue", "fix"];
const CAPABILITIES: Readonly<Record<AppObjectiveRequest["kind"], readonly string[]>> = {
  "smart-contract-audit": ["code-review"],
};
const AUDIT_KIND = "smart-contract-audit";
/** The web device's token hash: 32 random bytes, never issued as a token (SCR-181 §1). */
const UNISSUED_TOKEN_BYTES = 32;
const MS_PER_HOUR = 3_600_000;
/** `GET /v1/app/objectives` page size: at most 50, 50 when left out (OpenAPI listAppObjectives). */
const MAX_PAGE = 50;
const CURSOR_MAX_LENGTH = 512;
const OBJECTIVE_ID = /^obj_[0-9A-HJKMNP-TV-Z]{26}$/;

export type CreateAppObjectiveOutcome =
  | {
      readonly kind: "created";
      readonly body: { readonly objectiveId: string; readonly state: "received" };
      readonly replayed: boolean;
      /** How many secrets layer 1 removed; 0 on a replay. */
      readonly removed: number;
    }
  | {
      readonly kind: "problem";
      readonly status: 403 | 409 | 429;
      readonly code: "no-vault" | "device-revoked" | "idempotency-conflict" | "rate-limited";
    };

const responseDigest = (body: Record<string, unknown>) =>
  createHash("sha256").update(jcsString(body)).digest();

function redact(text: string): { text: string; removed: number } {
  const result = redactSecrets(text);
  return { text: result.text, removed: result.hits.reduce((sum, hit) => sum + hit.count, 0) };
}

export async function createAppObjective(
  pool: Pool,
  config: Config,
  input: {
    readonly userId: string;
    /** sha256 of the session token, to tell whether this session began after a revocation. */
    readonly sessionTokenHash: Buffer;
    readonly request: AppObjectiveRequest;
    readonly rawBody: Buffer;
    readonly key: string;
    readonly now: Date;
    readonly random: RandomSource;
  },
): Promise<CreateAppObjectiveOutcome> {
  const source = input.request.contractSource === "" ? undefined : input.request.contractSource;
  // Exactly one of the source and the address (an empty source counts as absent).
  if ((source === undefined) === (input.request.contractAddress === undefined))
    throw new RequestValidationError();
  if (source !== undefined && source.length > Number(config.get("app.objectiveMaxSourceChars")))
    throw new RequestValidationError();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const outcome = await createWithin(client, config, { ...input, source });
    await client.query(outcome.kind === "created" ? "COMMIT" : "ROLLBACK");
    return outcome;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function createWithin(
  client: PoolClient,
  config: Config,
  input: Parameters<typeof createAppObjective>[2] & { readonly source: string | undefined },
): Promise<CreateAppObjectiveOutcome> {
  // 1. This route's own idempotency: the same key and body replay the stored answer.
  const scope = `createAppObjective:${input.userId}`;
  const fingerprint = fingerprintRequest(input.rawBody);
  const record = await findOrCreateIdempotency(client, config, {
    scope,
    key: input.key,
    fingerprint,
    now: input.now,
  });
  if (!record.fingerprint.equals(fingerprint))
    return { kind: "problem", status: 409, code: "idempotency-conflict" };
  if (record.status !== null) {
    const stored = record.response_body;
    if (!stored || !record.response_hash || !responseDigest(stored).equals(record.response_hash))
      throw new Error("Stored idempotency response failed its integrity check.");
    return {
      kind: "created",
      body: stored as { objectiveId: string; state: "received" },
      replayed: true,
      removed: 0,
    };
  }

  // 2. A wallet first.
  const user = await client.query<{ vault: string | null }>(
    "SELECT vault FROM users WHERE user_id=$1",
    [input.userId],
  );
  if (!user.rows[0]?.vault) return { kind: "problem", status: 403, code: "no-vault" };

  // 3. The user's one web device, locked so this user's browser tasks are counted one at a time.
  await client.query(
    `INSERT INTO devices (device_id,user_id,device_name,platform,token_hash,created_at)
     VALUES ($1,$2,$3,'web',$4,$5)
     ON CONFLICT (user_id) WHERE platform='web' DO NOTHING`,
    [
      ulid("dev_", input.now, input.random),
      input.userId,
      WEB_DEVICE_NAME,
      randomBytes(UNISSUED_TOKEN_BYTES),
      input.now,
    ],
  );
  const device = (
    await client.query<{ device_id: string; revoked_at: Date | null }>(
      "SELECT device_id,revoked_at FROM devices WHERE user_id=$1 AND platform='web' FOR UPDATE",
      [input.userId],
    )
  ).rows[0];
  if (!device) throw new Error("The web device was not created.");
  if (device.revoked_at !== null) {
    // Revoking the browser device stops new browser tasks until the owner signs in again.
    const session = await client.query<{ created_at: Date }>(
      "SELECT created_at FROM sessions WHERE token_hash=$1",
      [input.sessionTokenHash],
    );
    const signedInAt = session.rows[0]?.created_at;
    if (!signedInAt || signedInAt <= device.revoked_at)
      return { kind: "problem", status: 403, code: "device-revoked" };
    await client.query("UPDATE devices SET revoked_at=NULL WHERE device_id=$1", [device.device_id]);
  }

  // 4. The hourly limit on browser tasks.
  const recent = await client.query<{ count: string }>(
    "SELECT count(*) FROM objectives WHERE device_id=$1 AND created_at > $2",
    [device.device_id, new Date(input.now.getTime() - MS_PER_HOUR)],
  );
  if (Number(recent.rows[0]?.count ?? 0) >= Number(config.get("app.webObjectivesPerUserPerHour")))
    return { kind: "problem", status: 429, code: "rate-limited" };

  // 5. The submission, built here from layer-1-redacted text.
  const { submission, removed } = buildSubmission(config, input, device.device_id);
  if (!validateSchema("objective-submission", submission) || !hashesMatch(submission))
    throw new RequestValidationError();

  // 6. The same intake as POST /v1/objectives.
  const result = await submitWithinTransaction(client, config, {
    body: submission,
    rawBody: Buffer.from(JSON.stringify(submission)),
    key: input.key,
    deviceId: device.device_id,
    userId: input.userId,
    now: input.now,
  });
  if (result.code === "idempotency-conflict")
    return { kind: "problem", status: 409, code: "idempotency-conflict" };
  if (result.code !== undefined) throw new RequestValidationError();

  const body = { objectiveId: submission.objectiveId, state: "received" as const };
  await client.query(
    `UPDATE idempotency SET status=201,response_body=$3::jsonb,response_hash=$4
     WHERE scope=$1 AND key=$2`,
    [scope, input.key, JSON.stringify(body), responseDigest(body)],
  );
  return { kind: "created", body, replayed: false, removed };
}

function buildSubmission(
  config: Config,
  input: Parameters<typeof createWithin>[2],
  deviceId: string,
): { submission: ObjectiveSubmission; removed: number } {
  const { request } = input;
  const title = redact(request.title);
  const description = redact(request.description);
  const source = input.source === undefined ? undefined : redact(input.source);
  const taskSpec: TaskSpec = {
    schemaVersion: "1.1",
    kind: "list-fill",
    topic: title.text,
    subjects: [{ label: request.contractAddress ?? title.text }],
    fields: [...AUDIT_FIELDS],
    ...(source === undefined ? {} : { context: source.text }),
    sourceTrust: "user-prompt",
    output: { format: "json", formatSource: "default" },
  };
  const objectiveId = ulid("obj_", input.now, input.random);
  const goal = description.text.trim() === "" ? `Audit ${title.text}` : description.text;
  const capabilities = [...CAPABILITIES[request.kind]];
  const minutesSaved = Number(config.get("app.webObjectiveMinutesSaved"));
  const hourlyBand = String(
    config.get("app.webObjectiveHourlyBand"),
  ) as ObjectiveSubmission["hourlyBand"];
  const hashed = {
    objectiveId,
    soulVersionHash: WEB_NO_SOUL,
    observationHashes: [] as string[],
    detector: "placeholder" as const,
    goal,
    capabilities,
    minutesSaved,
    hourlyBand,
  };
  const submission = {
    schemaVersion: "1.0",
    ...hashed,
    objectiveHash: objectiveHash({ ...hashed, taskSpecHash: taskSpecHash(taskSpec) }),
    ...(request.maxTotal === undefined ? {} : { constraints: { maxTotal: request.maxTotal } }),
    redaction: { layer2: { hits: 0, entities: [] } },
    deviceId,
    submittedAt: input.now.toISOString(),
    taskSpec,
  } as ObjectiveSubmission;
  return {
    submission,
    removed: title.removed + description.removed + (source?.removed ?? 0),
  };
}

interface ObjectiveRow {
  readonly objective_id: string;
  readonly state: AppObjective["state"];
  readonly plan_id: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly topic: string | null;
  readonly spec_kind: string | null;
  readonly capabilities: unknown;
  readonly platform: string;
}

const SELECT_OBJECTIVES = `SELECT o.objective_id,o.state,o.plan_id,o.created_at,o.updated_at,
    o.submission #>> '{taskSpec,topic}' AS topic,
    o.submission #>> '{taskSpec,kind}' AS spec_kind,
    o.submission -> 'capabilities' AS capabilities,
    d.platform
  FROM objectives o JOIN devices d ON d.device_id=o.device_id`;

function toAppObjective(row: ObjectiveRow): AppObjective {
  const audit = Array.isArray(row.capabilities) && row.capabilities.includes("code-review");
  return {
    objectiveId: row.objective_id,
    title: row.topic ?? "",
    kind: audit ? AUDIT_KIND : (row.spec_kind ?? "unknown"),
    state: row.state,
    ...(row.plan_id === null ? {} : { planId: row.plan_id }),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    origin: row.platform === "web" ? "web" : "device",
  };
}

interface Cursor {
  readonly createdAt: string;
  readonly objectiveId: string;
}

function parseCursor(value: string | null): Cursor | null {
  if (value === null) return null;
  if (value.length > CURSOR_MAX_LENGTH) throw new RequestValidationError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new RequestValidationError();
  }
  const cursor = parsed as Partial<Cursor> | null;
  if (
    typeof cursor?.createdAt !== "string" ||
    Number.isNaN(Date.parse(cursor.createdAt)) ||
    typeof cursor.objectiveId !== "string" ||
    !OBJECTIVE_ID.test(cursor.objectiveId)
  )
    throw new RequestValidationError();
  return { createdAt: cursor.createdAt, objectiveId: cursor.objectiveId };
}

function parseLimit(value: string | null): number {
  if (value === null) return MAX_PAGE;
  if (!/^[1-9][0-9]*$/.test(value)) throw new RequestValidationError();
  const limit = Number(value);
  if (limit > MAX_PAGE) throw new RequestValidationError();
  return limit;
}

/** The session user's objectives from the web and their devices, newest first (SCR-181 §2). */
export async function listAppObjectives(
  pool: Pool,
  userId: string,
  url: URL,
): Promise<{ readonly items: AppObjective[]; readonly nextCursor: string | null }> {
  const limit = parseLimit(url.searchParams.get("limit"));
  const cursor = parseCursor(url.searchParams.get("cursor"));
  const rows = await pool.query<ObjectiveRow>(
    `${SELECT_OBJECTIVES}
     WHERE o.user_id=$1 AND ($2::timestamptz IS NULL OR (o.created_at,o.objective_id) < ($2,$3))
     ORDER BY o.created_at DESC,o.objective_id DESC LIMIT $4`,
    [userId, cursor?.createdAt ?? null, cursor?.objectiveId ?? null, limit + 1],
  );
  const page = rows.rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor =
    rows.rows.length > limit && last
      ? Buffer.from(
          JSON.stringify({
            createdAt: last.created_at.toISOString(),
            objectiveId: last.objective_id,
          }),
        ).toString("base64url")
      : null;
  return { items: page.map(toAppObjective), nextCursor };
}

/** One of the session user's objectives, or null when it is not theirs. */
export async function getAppObjective(
  pool: Pool,
  userId: string,
  objectiveId: string,
): Promise<AppObjective | null> {
  const rows = await pool.query<ObjectiveRow>(
    `${SELECT_OBJECTIVES} WHERE o.user_id=$1 AND o.objective_id=$2`,
    [userId, objectiveId],
  );
  const row = rows.rows[0];
  return row === undefined ? null : toAppObjective(row);
}
