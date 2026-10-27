import { randomUUID } from "node:crypto";
import { validateRecordedExchange } from "@czar/api-contract";
import type { ObjectiveSubmission } from "@czar/schemas";

/** Terminal values of OpenAPI `ObjectiveStatusValue`; polling continues until one is reached. */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "no-supplier",
  "delivered",
  "failed",
  "expired",
  "dismissed",
]);

export type ObjectiveFetch = (input: URL, init: RequestInit) => Promise<Response>;
export interface ObjectiveStatus {
  readonly objectiveId: string;
  readonly status: string;
  readonly planSummary?: { readonly planId?: string; readonly spent?: string };
  readonly resultId?: string;
}

/** Submits one validated objective with the paired device's bearer token. */
export async function submitManualObjective(
  body: ObjectiveSubmission,
  token: string,
  serverOrigin: URL,
  fetcher: ObjectiveFetch = fetch,
): Promise<void> {
  let response: Response;
  try {
    response = await fetcher(new URL("/v1/objectives", serverOrigin), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(
      `Could not reach Czar at ${serverOrigin.origin}; objective submission was not confirmed.`,
    );
  }
  const result = await safeJson(response);
  if (response.status !== 202)
    throw new Error(`Objective submission failed (HTTP ${response.status}).`);
  const contract = validateRecordedExchange("submitObjective", {
    requestBody: body,
    responseStatus: response.status,
    responseBody: result,
  });
  if (!contract.valid || !isStatus(result) || result.objectiveId !== body.objectiveId) {
    throw new Error("Czar returned an invalid objective submission response.");
  }
}

/**
 * Prints each state change, prints the approval path once at `awaiting-approval`, and returns at a
 * terminal status (SCR-149 §2).
 */
export async function pollManualObjective(input: {
  readonly objectiveId: string;
  readonly token: string;
  readonly serverOrigin: URL;
  readonly intervalSeconds: number;
  readonly print: (line: string) => void;
  readonly fetcher?: ObjectiveFetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}): Promise<ObjectiveStatus> {
  const fetcher = input.fetcher ?? fetch;
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (!Number.isSafeInteger(input.intervalSeconds) || input.intervalSeconds < 1) {
    throw new Error("daemon.objectivePollSeconds must be a positive integer.");
  }
  let previous = "";
  for (;;) {
    const status = await getStatus(input.objectiveId, input.token, input.serverOrigin, fetcher);
    const changed = status.status !== previous;
    if (changed) input.print(`${status.objectiveId}: ${status.status}`);
    previous = status.status;
    if (status.status === "awaiting-approval" && changed) {
      const planId = status.planSummary?.planId;
      if (planId) {
        input.print(`Plan: ${planId}`);
        input.print(`/approve/${planId}`);
      } else input.print("Approval link unavailable: objective status has no plan ID.");
    }
    if (TERMINAL_STATUSES.has(status.status)) return status;
    await sleep(input.intervalSeconds * 1000);
  }
}

/** Reads one objective status, validated against the getObjective contract. */
export async function getStatus(
  objectiveId: string,
  token: string,
  serverOrigin: URL,
  fetcher: ObjectiveFetch,
): Promise<ObjectiveStatus> {
  let response: Response;
  try {
    response = await fetcher(new URL(`/v1/objectives/${objectiveId}`, serverOrigin), {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new Error(
      `Could not reach Czar at ${serverOrigin.origin} while checking objective status.`,
    );
  }
  const body = await safeJson(response);
  if (response.status !== 200)
    throw new Error(`Objective status failed (HTTP ${response.status}).`);
  const contract = validateRecordedExchange("getObjective", {
    responseStatus: response.status,
    responseBody: body,
  });
  if (!contract.valid || !isStatus(body) || body.objectiveId !== objectiveId) {
    throw new Error("Czar returned an invalid objective status response.");
  }
  return body;
}

function isStatus(value: unknown): value is ObjectiveStatus {
  return (
    typeof value === "object" &&
    value !== null &&
    "objectiveId" in value &&
    typeof value.objectiveId === "string" &&
    "status" in value &&
    typeof value.status === "string"
  );
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`Czar returned unreadable JSON (HTTP ${response.status}).`);
  }
}
