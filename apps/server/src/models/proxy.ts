import { Ajv2020 } from "ajv/dist/2020.js";
import type { Config, ParameterKey } from "@czar/config";
import { validateRecordedExchange } from "@czar/api-contract";
import type { Logger } from "@czar/logging";
import type { Pool, PoolClient } from "pg";
import { findOrCreateIdempotency, fingerprintRequest } from "#src/http/idempotency";

export type ModelPrompt = "P-01" | "P-04" | "P-05" | "P-06" | "P-07";

export interface ModelCallRequest {
  readonly prompt: ModelPrompt;
  readonly promptHash: string;
  readonly input: Record<string, unknown>;
  readonly schema: Record<string, unknown>;
}

export interface ModelCompletion {
  readonly output: Record<string, unknown>;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

export interface ModelClient {
  complete(
    request: ModelCallRequest,
    options: {
      readonly maxTotalTokens: number;
      readonly timeoutMs: number;
      readonly signal: AbortSignal;
    },
  ): Promise<ModelCompletion>;
}

export interface ModelProxyResult {
  readonly status: 200 | 400 | 409 | 503;
  readonly body: Record<string, unknown>;
  readonly code?: "validation" | "replay-not-stored" | "upstream-unavailable";
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}

const PROMPT_PARAMS: Readonly<
  Record<ModelPrompt, { monthly: ParameterKey; perCall: ParameterKey; timeout: ParameterKey }>
> = {
  "P-01": {
    monthly: "models.screenMonthlyTokens",
    perCall: "models.screen.maxTokensPerCall",
    timeout: "models.screen.timeoutMs",
  },
  "P-04": {
    monthly: "models.soulMonthlyTokens",
    perCall: "models.soul-compiler.maxTokensPerCall",
    timeout: "models.soul-compiler.timeoutMs",
  },
  "P-05": {
    monthly: "models.drivesMonthlyTokens",
    perCall: "models.drives-helper.maxTokensPerCall",
    timeout: "models.drives-helper.timeoutMs",
  },
  "P-06": {
    monthly: "models.refusalMonthlyTokens",
    perCall: "models.refusal-classifier.maxTokensPerCall",
    timeout: "models.refusal-classifier.timeoutMs",
  },
  "P-07": {
    monthly: "models.sourceExtractorMonthlyTokens",
    perCall: "models.sourceExtractor.maxTokensPerCall",
    timeout: "models.sourceExtractor.timeoutMs",
  },
};

/** HTTP 102 marks a key whose provider call is in flight; any reuse gets 409 replay-not-stored. */
const IN_FLIGHT_STATUS = 102;

type Reservation =
  | { readonly kind: "replay" }
  | { readonly kind: "exhausted" }
  | { readonly kind: "reserved"; readonly reservationId: string; readonly maxTotalTokens: number };

/**
 * Three steps so no database lock or pooled connection is held during the provider call (SCR-117):
 * 1. short transaction: claim the idempotency key and reserve budget;
 * 2. provider call with the reserved ceiling and the prompt timeout;
 * 3. short transaction: release the reservation, record actual counts, finalize the key.
 */
export async function completeModelCall(
  pool: Pool,
  config: Config,
  logger: Logger,
  modelClient: ModelClient,
  input: {
    readonly body: ModelCallRequest;
    readonly rawBody: Buffer;
    readonly key: string;
    readonly deviceId: string;
    readonly userId: string;
    readonly now: Date;
  },
): Promise<ModelProxyResult> {
  const validateOutput = compileOutputValidator(input.body.schema);
  if (!validateOutput) return { status: 400, code: "validation", body: {} };
  const scope = `completeModelCall:${input.deviceId}`;
  const monthStart = `${input.now.toISOString().slice(0, 7)}-01`;
  const params = PROMPT_PARAMS[input.body.prompt];
  const timeoutMs = Number(config.get(params.timeout));

  const reservation = await inTransaction(pool, (client) =>
    reserve(client, config, input, scope, monthStart, timeoutMs),
  );
  if (reservation.kind === "replay") return { status: 409, code: "replay-not-stored", body: {} };
  if (reservation.kind === "exhausted")
    return { status: 503, code: "upstream-unavailable", body: {} };

  let completion: ModelCompletion | undefined;
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const pending = modelClient.complete(input.body, {
      maxTotalTokens: reservation.maxTotalTokens,
      timeoutMs,
      signal,
    });
    const result: unknown = await raceWithAbort(pending, signal);
    if (validCompletion(result)) completion = result;
  } catch {
    completion = undefined;
  }

  const result = await inTransaction(pool, (client) =>
    settle(client, input, scope, monthStart, reservation, completion, validateOutput),
  );
  if (result.usage) {
    logger.info(result.status === 200 ? "model_call_completed" : "model_call_rejected", {
      promptHash: input.body.promptHash,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    });
  }
  return result;
}

async function reserve(
  client: PoolClient,
  config: Config,
  input: Parameters<typeof completeModelCall>[4],
  scope: string,
  monthStart: string,
  timeoutMs: number,
): Promise<Reservation> {
  const fingerprint = fingerprintRequest(input.rawBody);
  const idempotency = await findOrCreateIdempotency(client, config, {
    scope,
    key: input.key,
    fingerprint,
    now: input.now,
    replayStored: false,
  });
  if (idempotency.status !== null || !idempotency.fingerprint.equals(fingerprint)) {
    return { kind: "replay" };
  }
  // One budget writer per user at a time; held only for this short transaction.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `model-budget:${input.userId}`,
  ]);
  const totals = await client.query<{ user_total: string; prompt_total: string }>(
    `SELECT
       COALESCE((SELECT SUM(input_tokens + output_tokens) FROM model_usage
                 WHERE user_id=$1 AND month_start=$2), 0)
     + COALESCE((SELECT SUM(tokens) FROM model_reservations
                 WHERE user_id=$1 AND month_start=$2 AND expires_at > $4), 0) AS user_total,
       COALESCE((SELECT SUM(input_tokens + output_tokens) FROM model_usage
                 WHERE user_id=$1 AND month_start=$2 AND prompt=$3), 0)
     + COALESCE((SELECT SUM(tokens) FROM model_reservations
                 WHERE user_id=$1 AND month_start=$2 AND prompt=$3 AND expires_at > $4), 0)
       AS prompt_total`,
    [input.userId, monthStart, input.body.prompt, input.now],
  );
  const row = totals.rows[0];
  if (!row) throw new Error("Model budget totals query returned no row.");
  const params = PROMPT_PARAMS[input.body.prompt];
  const maxTotalTokens = Math.min(
    Number(config.get(params.perCall)),
    Number(config.get(params.monthly)) - Number(row.prompt_total),
    Number(config.get("models.userMonthlyTokens")) - Number(row.user_total),
  );
  if (maxTotalTokens <= 0) {
    await markIdempotencyResult(client, scope, input.key, 503);
    return { kind: "exhausted" };
  }
  const expiresAt = new Date(
    input.now.getTime() + timeoutMs + Number(config.get("models.reservationGraceSeconds")) * 1000,
  );
  const inserted = await client.query<{ reservation_id: string }>(
    `INSERT INTO model_reservations (user_id,month_start,prompt,tokens,expires_at)
     VALUES ($1,$2,$3,$4,$5) RETURNING reservation_id`,
    [input.userId, monthStart, input.body.prompt, maxTotalTokens, expiresAt],
  );
  const reservationId = inserted.rows[0]?.reservation_id;
  if (!reservationId) throw new Error("Model budget reservation was not created.");
  await markIdempotencyResult(client, scope, input.key, IN_FLIGHT_STATUS);
  return { kind: "reserved", reservationId, maxTotalTokens };
}

async function settle(
  client: PoolClient,
  input: Parameters<typeof completeModelCall>[4],
  scope: string,
  monthStart: string,
  reservation: Extract<Reservation, { kind: "reserved" }>,
  completion: ModelCompletion | undefined,
  validateOutput: (value: unknown) => boolean,
): Promise<ModelProxyResult> {
  await client.query("DELETE FROM model_reservations WHERE reservation_id=$1", [
    reservation.reservationId,
  ]);
  if (!completion) {
    await markIdempotencyResult(client, scope, input.key, 503);
    return { status: 503, code: "upstream-unavailable", body: {} };
  }
  await recordUsage(client, input, completion.usage, monthStart);
  const used = completion.usage.inputTokens + completion.usage.outputTokens;
  const body = { output: completion.output, usage: completion.usage };
  const ok =
    used <= reservation.maxTotalTokens &&
    validateOutput(completion.output) &&
    validateRecordedExchange("completeModelCall", {
      requestBody: input.body,
      responseStatus: 200,
      responseBody: body,
    }).valid;
  const status = ok ? 200 : 503;
  await recordIdempotencyUsage(client, scope, input.key, status, completion.usage);
  if (!ok) return { status: 503, code: "upstream-unavailable", body: {}, usage: completion.usage };
  return { status: 200, body, usage: completion.usage };
}

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function compileOutputValidator(
  schema: Record<string, unknown>,
): ((value: unknown) => boolean) | null {
  try {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    return ajv.compile(schema);
  } catch {
    return null;
  }
}

function validUsage(value: unknown): value is ModelCompletion["usage"] {
  if (typeof value !== "object" || value === null) return false;
  if (!("inputTokens" in value) || !("outputTokens" in value)) return false;
  const inputTokens = value.inputTokens;
  const outputTokens = value.outputTokens;
  return (
    typeof inputTokens === "number" &&
    Number.isSafeInteger(inputTokens) &&
    inputTokens >= 0 &&
    typeof outputTokens === "number" &&
    Number.isSafeInteger(outputTokens) &&
    outputTokens >= 0
  );
}

function validCompletion(value: unknown): value is ModelCompletion {
  if (typeof value !== "object" || value === null || !("output" in value)) return false;
  const output = value.output;
  return (
    typeof output === "object" &&
    output !== null &&
    !Array.isArray(output) &&
    "usage" in value &&
    validUsage(value.usage)
  );
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function recordUsage(
  client: PoolClient,
  input: Parameters<typeof completeModelCall>[4],
  usage: ModelCompletion["usage"],
  monthStart: string,
): Promise<void> {
  await client.query(
    `INSERT INTO model_usage (user_id,month_start,prompt,input_tokens,output_tokens)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id,month_start,prompt) DO UPDATE
       SET input_tokens=model_usage.input_tokens+EXCLUDED.input_tokens,
           output_tokens=model_usage.output_tokens+EXCLUDED.output_tokens`,
    [input.userId, monthStart, input.body.prompt, usage.inputTokens, usage.outputTokens],
  );
}

async function recordIdempotencyUsage(
  client: PoolClient,
  scope: string,
  key: string,
  status: number,
  usage: ModelCompletion["usage"],
): Promise<void> {
  await client.query(
    `UPDATE idempotency SET status=$3,model_input_tokens=$4,model_output_tokens=$5,
       replay_stored=false WHERE scope=$1 AND key=$2`,
    [scope, key, status, usage.inputTokens, usage.outputTokens],
  );
}

async function markIdempotencyResult(
  client: PoolClient,
  scope: string,
  key: string,
  status: number,
): Promise<void> {
  await client.query(
    "UPDATE idempotency SET status=$3,replay_stored=false WHERE scope=$1 AND key=$2",
    [scope, key, status],
  );
}
