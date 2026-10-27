import type { Config } from "@czar/config";
import { validateRecordedExchange } from "@czar/api-contract";
import type { ResultAck } from "@czar/schemas";
import { KEYCHAIN_ACCOUNTS, type Keychain } from "#src/keychain";

const OBJECTIVE_ID = /^obj_[0-9A-HJKMNP-TV-Z]{26}$/;
const DEVICE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MILLISECONDS_PER_SECOND = 1000;

export type ResultAckFetch = (input: URL, init: RequestInit) => Promise<Response>;
export type ResultAckSleep = (milliseconds: number) => Promise<void>;

interface RetryPolicy {
  readonly retryCount: number;
  readonly baseDelayMs: number;
  readonly maximumDelayMs: number;
}

export interface AckResultInput {
  readonly objectiveId: string;
  readonly resultAck: ResultAck;
  readonly keychain: Keychain;
  readonly config: Config;
  readonly serverOrigin: URL;
  readonly idempotencyKey: string;
  readonly fetcher?: ResultAckFetch;
  readonly sleep?: ResultAckSleep;
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
  const serverOrigin = validateServerOrigin(input.serverOrigin);
  if (!UUID_V4.test(input.idempotencyKey)) throw new Error("Invalid result acknowledgement key.");
  await sendWithRetries({ input, token, serverOrigin, idempotencyKey: input.idempotencyKey });
}

async function sendWithRetries(context: {
  readonly input: AckResultInput;
  readonly token: string;
  readonly serverOrigin: URL;
  readonly idempotencyKey: string;
}): Promise<void> {
  const policy = readRetryPolicy(context.input.config);
  const fetcher = context.input.fetcher ?? defaultFetch;
  const sleep = context.input.sleep ?? defaultSleep;
  const request = createRequest(context);
  for (let retry = 0; retry <= policy.retryCount; retry += 1) {
    let response: Response;
    try {
      response = await fetcher(request.url, request.init);
    } catch {
      if (retry === policy.retryCount) {
        throw new Error(
          `Could not send the result acknowledgement to Czar at ${context.serverOrigin.origin} ` +
            `after ${policy.retryCount} retries.`,
        );
      }
      await sleep(retryDelayMs(policy, retry));
      continue;
    }
    if (response.status === 204) return;
    if (response.status < 500 || response.status > 599 || retry === policy.retryCount) {
      throw new Error(`Czar did not accept the result acknowledgement (HTTP ${response.status}).`);
    }
    await sleep(retryDelayMs(policy, retry));
  }
}

function createRequest(context: {
  readonly input: AckResultInput;
  readonly token: string;
  readonly serverOrigin: URL;
  readonly idempotencyKey: string;
}): { readonly url: URL; readonly init: RequestInit } {
  return {
    url: new URL(
      `/v1/objectives/${encodeURIComponent(context.input.objectiveId)}/results/ack`,
      context.serverOrigin,
    ),
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${context.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": context.idempotencyKey,
      },
      body: JSON.stringify(context.input.resultAck),
    },
  };
}

function readRetryPolicy(config: Config): RetryPolicy {
  const retryCount = Number(config.get("writeback.ackRetryCount"));
  const baseDelayMs = Number(config.get("daemon.outboxRetryBaseS")) * MILLISECONDS_PER_SECOND;
  const maximumDelayMs = Number(config.get("writeback.ackRetryMaxS")) * MILLISECONDS_PER_SECOND;
  if (
    !Number.isSafeInteger(retryCount) ||
    retryCount < 0 ||
    !Number.isSafeInteger(baseDelayMs) ||
    baseDelayMs < MILLISECONDS_PER_SECOND ||
    !Number.isSafeInteger(maximumDelayMs) ||
    maximumDelayMs < baseDelayMs
  ) {
    throw new Error("Result acknowledgement retry settings are invalid; check the Czar config.");
  }
  return { retryCount, baseDelayMs, maximumDelayMs };
}

function retryDelayMs(policy: RetryPolicy, retry: number): number {
  return Math.min(policy.maximumDelayMs, policy.baseDelayMs * 2 ** retry);
}

function validateServerOrigin(serverOrigin: URL): URL {
  if (
    (serverOrigin.protocol !== "http:" && serverOrigin.protocol !== "https:") ||
    serverOrigin.username ||
    serverOrigin.password ||
    serverOrigin.pathname !== "/" ||
    serverOrigin.search ||
    serverOrigin.hash
  ) {
    throw new Error("The Czar server origin must be an HTTP(S) origin without a path.");
  }
  return serverOrigin;
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

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
