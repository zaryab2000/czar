import { randomUUID } from "node:crypto";
import { validateRecordedExchange } from "@czar/api-contract";
import type { ObjectiveSubmission } from "@czar/schemas";

const SERVER_ORIGIN = "http://localhost";
const TERMINAL = new Set(["no-supplier", "delivered", "failed", "expired", "dismissed"]);

export type ObjectiveFetch = (input: URL, init: RequestInit) => Promise<Response>;
export interface ObjectiveStatus {
  readonly objectiveId: string;
  readonly status: string;
  readonly planSummary?: { readonly planId?: string };
}

/** Submits one validated objective with the paired device's bearer token. */
export async function submitManualObjective(
  body: ObjectiveSubmission,
  token: string,
  fetcher: ObjectiveFetch = fetch,
): Promise<void> {
  let response: Response;
  try {
    response = await fetcher(new URL("/v1/objectives", SERVER_ORIGIN), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Could not reach Czar at localhost; objective submission was not confirmed.");
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

/** Prints each state change and stops at approval or a terminal status. */
export async function pollManualObjective(input: {
  readonly objectiveId: string;
  readonly token: string;
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
    const status = await getStatus(input.objectiveId, input.token, fetcher);
    if (status.status !== previous) input.print(`${status.objectiveId}: ${status.status}`);
    previous = status.status;
    if (status.status === "awaiting-approval") {
      const planId = status.planSummary?.planId;
      if (planId) input.print(`${SERVER_ORIGIN}/approve/${planId}`);
      else input.print("Approval link unavailable: objective status has no plan ID.");
      return status;
    }
    if (TERMINAL.has(status.status)) return status;
    await sleep(input.intervalSeconds * 1000);
  }
}

async function getStatus(
  objectiveId: string,
  token: string,
  fetcher: ObjectiveFetch,
): Promise<ObjectiveStatus> {
  let response: Response;
  try {
    response = await fetcher(new URL(`/v1/objectives/${objectiveId}`, SERVER_ORIGIN), {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new Error("Could not reach Czar at localhost while checking objective status.");
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
