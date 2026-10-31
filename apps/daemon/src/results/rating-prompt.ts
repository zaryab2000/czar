import { createHash, randomUUID } from "node:crypto";
import { validateRecordedExchange } from "@czar/api-contract";
import type { MemoryDatabase } from "#src/database";
import type { ObjectiveFetch } from "#src/objective-http";

interface RatingStep {
  readonly stepIndex: number;
  readonly merchantLabel: string;
  readonly effectiveRating: "good" | "bad" | "none";
  readonly ratingId?: string;
  readonly canRate: boolean;
  readonly canCorrect: boolean;
}

interface RatingPrompt {
  readonly objectiveId: string;
  readonly steps: RatingStep[];
}

export interface RatingPromptDeps {
  readonly database: MemoryDatabase;
  readonly deviceToken: string;
  readonly serverOrigin: URL;
  readonly print: (line: string) => void;
  readonly ask: (line: string) => Promise<string>;
  readonly fetcher?: ObjectiveFetch;
}

const ratingQuestion = (label: string) =>
  `Was the result from ${label} good?  [g] good  [b] bad  [enter] skip`;

/** Ask the paired owner for one rating per eligible supplier after local result write-back. */
export async function runRatingPrompt(objectiveId: string, deps: RatingPromptDeps): Promise<void> {
  const prompt = await fetchRatingPrompt(objectiveId, deps);
  for (const step of prompt.steps) {
    const label = printableLabel(step.merchantLabel);
    if (step.canRate) {
      const answer = await deps.ask(ratingQuestion(label));
      await postIfRated(answer, objectiveId, step, label, deps);
      continue;
    }
    if (step.effectiveRating === "none") continue;
    if (!step.canCorrect) {
      deps.print(`Current rating for ${label}: ${step.effectiveRating}.`);
      continue;
    }
    if (!step.ratingId) throw new Error("Czar returned a correction without a rating ID.");
    const change = await deps.ask(
      `Current rating for ${label}: ${step.effectiveRating}.  [c] change  [enter] skip`,
    );
    if (change !== "c") continue;
    const answer = await deps.ask(ratingQuestion(label));
    await postIfRated(answer, objectiveId, step, label, deps);
  }
}

async function postIfRated(
  answer: string,
  objectiveId: string,
  step: RatingStep,
  label: string,
  deps: RatingPromptDeps,
): Promise<void> {
  if (answer !== "g" && answer !== "b") return;
  const value = answer === "g" ? "good" : "bad";
  const body = {
    objectiveId,
    stepIndex: step.stepIndex,
    value,
    ...(step.canCorrect && step.ratingId ? { supersedes: step.ratingId } : {}),
  };
  const payload = JSON.stringify(body);
  const fetcher = deps.fetcher ?? fetch;
  deps.database
    .prepare(
      `INSERT INTO audit_local (at,kind,payload_hash,bytes,destination,summary_counts_json)
     VALUES (?,?,?,?,?,?)`,
    )
    .run(
      Date.now(),
      "rating",
      createHash("sha256").update(payload).digest(),
      Buffer.byteLength(payload),
      "server",
      JSON.stringify({ ratings: 1 }),
    );
  let response: Response;
  try {
    response = await fetcher(new URL("/v1/ratings", deps.serverOrigin), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.deviceToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: payload,
    });
  } catch {
    throw new Error(`Could not reach Czar at ${deps.serverOrigin.origin} to submit a rating.`);
  }
  const result = await safeJson(response, "rating");
  const contract = validateRecordedExchange("submitRating", {
    requestBody: body,
    responseStatus: response.status,
    responseBody: result,
  });
  if (response.status !== 202 || !contract.valid || !matchesRating(result, body)) {
    throw new Error(`Submitting the rating failed (HTTP ${response.status}).`);
  }
  deps.print(
    `Thanks. Czar will rank ${label} ${value === "good" ? "higher" : "lower"} for tasks like this.`,
  );
}

async function fetchRatingPrompt(
  objectiveId: string,
  deps: RatingPromptDeps,
): Promise<RatingPrompt> {
  const fetcher = deps.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(
      new URL(`/v1/objectives/${encodeURIComponent(objectiveId)}/rating-prompt`, deps.serverOrigin),
      { method: "GET", headers: { Authorization: `Bearer ${deps.deviceToken}` } },
    );
  } catch {
    throw new Error(`Could not reach Czar at ${deps.serverOrigin.origin} for the rating prompt.`);
  }
  const body = await safeJson(response, "rating prompt");
  const contract = validateRecordedExchange("getRatingPrompt", {
    responseStatus: response.status,
    responseBody: body,
  });
  if (response.status !== 200 || !contract.valid || !isPrompt(body, objectiveId)) {
    throw new Error(`Reading the rating prompt failed (HTTP ${response.status}).`);
  }
  return body;
}

async function safeJson(response: Response, name: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`Czar returned an unreadable ${name} response (HTTP ${response.status}).`);
  }
}

function isPrompt(value: unknown, objectiveId: string): value is RatingPrompt {
  return (
    typeof value === "object" &&
    value !== null &&
    "objectiveId" in value &&
    value.objectiveId === objectiveId &&
    "steps" in value &&
    Array.isArray(value.steps)
  );
}

function matchesRating(
  value: unknown,
  request: {
    readonly objectiveId: string;
    readonly stepIndex: number;
    readonly value: string;
  },
): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "objectiveId" in value &&
    value.objectiveId === request.objectiveId &&
    "stepIndex" in value &&
    value.stepIndex === request.stepIndex &&
    "value" in value &&
    value.value === request.value
  );
}

function printableLabel(label: string): string {
  let printable = "";
  for (const character of label) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 32 && (code < 127 || code > 159)) printable += character;
  }
  return printable;
}
