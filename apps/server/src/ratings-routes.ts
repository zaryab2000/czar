import { apiContracts, validateRecordedExchange } from "@czar/api-contract";
import type { Config } from "@czar/config";
import type { Logger } from "@czar/logging";
import type { Context } from "hono";
import type { Pool } from "pg";
import { getRatingPrompt, listAppResults } from "#src/app/results";
import { submitRating, RatingRejected, type RatingRequest } from "#src/evidence/ratings";
import { parseIdempotencyKey, parseObjectiveId, RequestValidationError } from "#src/http/validate";
import { problem } from "#src/http/problem";
import type { RandomSource } from "#src/http/ids";

type ServerContext = Context<any, any, any>;

export interface RatingRouteDependencies {
  readonly pool: Pool;
  readonly config: Config;
  readonly logger: Logger;
  readonly clock: { readonly now: () => Date };
  readonly random: RandomSource;
}

/** Accept a device or app rating after the surface has authenticated its user. */
export async function postRatingRoute(
  context: ServerContext,
  deps: RatingRouteDependencies,
  userId: string,
  surface: "cli" | "web",
): Promise<Response> {
  const key = parseIdempotencyKey(context.req.header("Idempotency-Key"));
  const { body, bytes } = await readRatingRequest(context, surface);
  try {
    const outcome = await submitRating(deps.pool, deps.config, {
      userId,
      surface,
      request: body,
      rawBody: bytes,
      key,
      now: deps.clock.now(),
      random: deps.random,
    });
    const operationId = surface === "cli" ? "submitRating" : "submitAppRating";
    assertExchange(operationId, body, 202, outcome.accepted);
    if (!outcome.replayed) {
      deps.logger.info("ratings_posted", { surface, value: body.value });
      if (outcome.correction) deps.logger.info("ratings_corrected", { surface });
    }
    return context.json(outcome.accepted, 202);
  } catch (error) {
    if (!(error instanceof RatingRejected)) throw error;
    return context.json(problem(error.status, error.code), error.status as 403 | 404 | 409 | 422, {
      "Content-Type": "application/problem+json",
    });
  }
}

/** Return one owner's result rating prompt. */
export async function getRatingPromptRoute(
  context: ServerContext,
  deps: RatingRouteDependencies,
  userId: string,
): Promise<Response> {
  const objectiveId = parseObjectiveId(context.req.param("objectiveId") ?? "");
  const prompt = await getRatingPrompt(
    deps.pool,
    deps.config,
    userId,
    objectiveId,
    deps.clock.now(),
  );
  if (!prompt)
    return context.json(problem(404, "unknown-objective"), 404, {
      "Content-Type": "application/problem+json",
    });
  assertExchange("getRatingPrompt", undefined, 200, prompt);
  const steps = prompt.steps.filter((step) => step.canRate).length;
  if (steps > 0) deps.logger.info("ratings_prompt_shown", { surface: "cli", steps });
  return context.json(prompt);
}

/** Page sanitized result cards for the authenticated app session. */
export async function listAppResultsRoute(
  context: ServerContext,
  deps: RatingRouteDependencies,
): Promise<Response> {
  const userId = context.get("appUserId") as string | undefined;
  if (!userId)
    return context.json(problem(401, "session-expired"), 401, {
      "Content-Type": "application/problem+json",
    });
  const page = await listAppResults(
    deps.pool,
    deps.config,
    userId,
    deps.clock.now(),
    new URL(context.req.url),
  );
  assertExchange("listAppResults", undefined, 200, page);
  const steps = page.items.reduce(
    (count, card) => count + card.suppliers.filter((step) => step.canRate).length,
    0,
  );
  if (steps > 0) deps.logger.info("ratings_prompt_shown", { surface: "web", steps });
  return context.json(page);
}

async function readRatingRequest(
  context: ServerContext,
  surface: "cli" | "web",
): Promise<{ readonly body: RatingRequest; readonly bytes: Buffer }> {
  if (!context.req.header("Content-Type")?.toLowerCase().startsWith("application/json"))
    throw new RequestValidationError();
  const bytes = Buffer.from(await context.req.raw.clone().arrayBuffer());
  let body: unknown;
  try {
    body = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new RequestValidationError();
  }
  const operationId = surface === "cli" ? "submitRating" : "submitAppRating";
  const validator = apiContracts.get(operationId)?.request;
  if (!validator || !validator(body)) throw new RequestValidationError();
  return { body: body as RatingRequest, bytes };
}

function assertExchange(
  operationId: string,
  requestBody: unknown,
  responseStatus: number,
  responseBody: unknown,
): void {
  const result = validateRecordedExchange(operationId, {
    ...(requestBody === undefined ? {} : { requestBody }),
    responseStatus,
    responseBody,
  });
  if (!result.valid) throw new Error(`Server response failed ${operationId} contract validation.`);
}
