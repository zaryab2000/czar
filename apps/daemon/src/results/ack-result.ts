import { randomUUID } from "node:crypto";
import { validateRecordedExchange } from "@czar/api-contract";
import type { ResultAck } from "@czar/schemas";
import { KEYCHAIN_ACCOUNTS, type Keychain } from "#src/keychain";

const SERVER_ORIGIN = "http://localhost";
const OBJECTIVE_ID = /^obj_[0-9A-HJKMNP-TV-Z]{26}$/;
const DEVICE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ResultAckFetch = (input: URL, init: RequestInit) => Promise<Response>;

export interface AckResultInput {
  readonly objectiveId: string;
  readonly resultAck: ResultAck;
  readonly keychain: Keychain;
  readonly idempotencyKey?: string;
  readonly fetcher?: ResultAckFetch;
}

/** Sends write-back counts to the server without exposing the device token to the caller. */
export async function ackResult(input: AckResultInput): Promise<void> {
  if (!OBJECTIVE_ID.test(input.objectiveId)) throw new Error("Invalid objective identifier.");
  const contract = validateRecordedExchange("ackResult", {
    requestBody: input.resultAck,
    responseStatus: 204,
  });
  if (!contract.valid) throw new Error("Result acknowledgement does not match the API contract.");
  const token = readDeviceToken(input.keychain);
  const idempotencyKey = input.idempotencyKey ?? randomUUID();
  if (!UUID_V4.test(idempotencyKey)) throw new Error("Invalid result acknowledgement key.");
  let response: Response;
  try {
    response = await (input.fetcher ?? defaultFetch)(
      new URL(`/v1/objectives/${encodeURIComponent(input.objectiveId)}/results/ack`, SERVER_ORIGIN),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(input.resultAck),
      },
    );
  } catch {
    throw new Error("Could not send the result acknowledgement to Czar at localhost.");
  }
  if (response.status !== 204) {
    throw new Error(`Czar did not accept the result acknowledgement (HTTP ${response.status}).`);
  }
}

function readDeviceToken(keychain: Keychain): string {
  let token: string | null;
  try {
    token = keychain.get(KEYCHAIN_ACCOUNTS.deviceToken);
  } catch {
    throw new Error("Czar could not read the device token from the system keychain.");
  }
  if (!token || !DEVICE_TOKEN.test(token)) {
    throw new Error("Pair this computer with Czar before acknowledging a result.");
  }
  return token;
}

async function defaultFetch(input: URL, init: RequestInit): Promise<Response> {
  return fetch(input, init);
}
