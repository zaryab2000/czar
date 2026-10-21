import { Ajv2020 } from "ajv/dist/2020.js";
import type { Config } from "@czar/config";
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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await completeWithinTransaction(
      client,
      config,
      input,
      modelClient,
      validateOutput,
    );
    await client.query("COMMIT");
    if (result.usage) {
      logger.info(result.status === 200 ? "model_call_completed" : "model_call_rejected", {
        promptHash: input.body.promptHash,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      });
    }
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function completeWithinTransaction(
  client: PoolClient,
  config: Config,
  input: Parameters<typeof completeModelCall>[4],
  modelClient: ModelClient,
  validateOutput: (value: unknown) => boolean,
): Promise<ModelProxyResult> {
  const fingerprint = fingerprintRequest(input.rawBody);
  const scope = `completeModelCall:${input.deviceId}`;
  const idempotency = await findOrCreateIdempotency(client, config, {
    scope,
    key: input.key,
    fingerprint,
    now: input.now,
    replayStored: false,
  });
  if (idempotency.status !== null || !idempotency.fingerprint.equals(fingerprint)) {
    return { status: 409, code: "replay-not-stored", body: {} };
  }

  const monthStart = `${input.now.toISOString().slice(0, 7)}-01`;
  await client.query(
    `INSERT INTO model_usage (user_id,month_start) VALUES ($1,$2)
     ON CONFLICT (user_id,month_start) DO NOTHING`,
    [input.userId, monthStart],
  );
  const usageResult = await client.query<{
    input_tokens: string;
    output_tokens: string;
    source_extractor_tokens: string;
  }>(
    `SELECT input_tokens,output_tokens,source_extractor_tokens FROM model_usage
     WHERE user_id=$1 AND month_start=$2 FOR UPDATE`,
    [input.userId, monthStart],
  );
  const usage = usageResult.rows[0];
  if (!usage) throw new Error("Monthly model usage row was not created.");
  const totalUsed = Number(usage.input_tokens) + Number(usage.output_tokens);
  const sourceUsed = Number(usage.source_extractor_tokens);
  const sourceCap = Number(config.get("models.sourceExtractorMonthlyTokens"));
  const userCap = Number(config.get("models.userMonthlyTokens"));
  const remainingUserTokens = userCap - totalUsed;
  const remainingSourceTokens = sourceCap - sourceUsed;
  const maxTotalTokens =
    input.body.prompt === "P-07"
      ? Math.min(remainingUserTokens, remainingSourceTokens)
      : remainingUserTokens;
  if (maxTotalTokens <= 0) {
    await markIdempotencyResult(client, scope, input.key, 503);
    return { status: 503, code: "upstream-unavailable", body: {} };
  }

  let result: unknown;
  try {
    const timeoutMs = promptTimeoutMs(config, input.body.prompt);
    const signal = AbortSignal.timeout(timeoutMs);
    const pending = modelClient.complete(input.body, { maxTotalTokens, timeoutMs, signal });
    result = await raceWithAbort(pending, signal);
  } catch {
    await markIdempotencyResult(client, scope, input.key, 503);
    return { status: 503, code: "upstream-unavailable", body: {} };
  }
  if (!validCompletion(result)) {
    await markIdempotencyResult(client, scope, input.key, 503);
    return { status: 503, code: "upstream-unavailable", body: {} };
  }
  const completion = result;

  const nextTotal = totalUsed + completion.usage.inputTokens + completion.usage.outputTokens;
  const nextSource =
    sourceUsed +
    (input.body.prompt === "P-07"
      ? completion.usage.inputTokens + completion.usage.outputTokens
      : 0);
  await recordUsage(client, input, completion.usage, monthStart);
  const outputValid = validateOutput(completion.output);
  const withinBudgets =
    nextTotal <= userCap && (input.body.prompt !== "P-07" || nextSource <= sourceCap);
  const status = outputValid && withinBudgets ? 200 : 503;
  await recordIdempotencyUsage(client, scope, input.key, status, completion.usage);
  if (!outputValid || !withinBudgets) {
    return { status: 503, code: "upstream-unavailable", body: {}, usage: completion.usage };
  }
  const body = { output: completion.output, usage: completion.usage };
  const contract = validateRecordedExchange("completeModelCall", {
    requestBody: input.body,
    responseStatus: 200,
    responseBody: body,
  });
  if (!contract.valid) {
    await markIdempotencyResult(client, scope, input.key, 503);
    return { status: 503, code: "upstream-unavailable", body: {}, usage: completion.usage };
  }
  return { status: 200, body, usage: completion.usage };
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

function promptTimeoutMs(config: Config, prompt: ModelPrompt): number {
  switch (prompt) {
    case "P-01":
      return Number(config.get("models.screen.timeoutMs"));
    case "P-04":
      return Number(config.get("models.soul-compiler.timeoutMs"));
    case "P-05":
      return Number(config.get("models.drives-helper.timeoutMs"));
    case "P-06":
      return Number(config.get("models.refusal-classifier.timeoutMs"));
    case "P-07":
      return Number(config.get("models.sourceExtractor.timeoutMs"));
  }
}

async function recordUsage(
  client: PoolClient,
  input: Parameters<typeof completeModelCall>[4],
  usage: ModelCompletion["usage"],
  monthStart: string,
): Promise<void> {
  const sourceTokens = input.body.prompt === "P-07" ? usage.inputTokens + usage.outputTokens : 0;
  await client.query(
    `UPDATE model_usage SET input_tokens=input_tokens+$3,output_tokens=output_tokens+$4,
       source_extractor_tokens=source_extractor_tokens+$5
     WHERE user_id=$1 AND month_start=$2`,
    [input.userId, monthStart, usage.inputTokens, usage.outputTokens, sourceTokens],
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
