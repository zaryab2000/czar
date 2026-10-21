import { randomUUID } from "node:crypto";
import { validateRecordedExchange } from "@czar/api-contract";
import { KEYCHAIN_ACCOUNTS, type Keychain } from "#src/keychain";

const SERVER_ORIGIN = "http://localhost";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PairingFetch = (input: URL, init: RequestInit) => Promise<Response>;

export interface PairDeviceInput {
  readonly code: string;
  readonly deviceName: string;
  readonly platform: "macos";
  readonly keychain: Keychain;
  readonly fetcher?: PairingFetch;
  readonly idempotencyKey?: string;
}

export interface PairDeviceResult {
  readonly deviceId: string;
}

export class PairingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PairingError";
  }
}

/** Exchanges the one-time code and writes the one-time token directly to K15. */
export async function pairDevice(input: PairDeviceInput): Promise<PairDeviceResult> {
  validateInput(input);
  checkKeychain(input.keychain);
  const idempotencyKey = input.idempotencyKey ?? randomUUID();
  const requestBody = {
    pairingCode: input.code,
    deviceName: input.deviceName.trim(),
    platform: input.platform,
  };
  const response = await sendPairRequest(
    input.fetcher ?? defaultFetch,
    idempotencyKey,
    requestBody,
  );
  const responseBody = await readJson(response);
  if (response.status !== 201) throw pairingFailure(response.status, responseBody);
  const contract = validateRecordedExchange("pairDevice", {
    requestBody,
    responseStatus: response.status,
    responseBody,
  });
  if (!contract.valid) throw new PairingError("The server returned an invalid pairing response.");
  const deviceId = readString(responseBody, "deviceId");
  const deviceToken = readString(responseBody, "deviceToken");
  storeToken(input.keychain, deviceToken);
  return { deviceId };
}

function validateInput(input: PairDeviceInput): void {
  if (!/^\d{8}$/.test(input.code)) {
    throw new PairingError("Enter the 8-digit code shown in the Czar app.");
  }
  const name = input.deviceName.trim();
  if (name.length === 0 || name.length > 64) {
    throw new PairingError("Device name must be between 1 and 64 characters.");
  }
  if (input.idempotencyKey !== undefined && !UUID_V4.test(input.idempotencyKey)) {
    throw new PairingError("Pairing request could not be created. Try again.");
  }
}

function checkKeychain(keychain: Keychain): void {
  try {
    keychain.get(KEYCHAIN_ACCOUNTS.deviceToken);
  } catch {
    throw new PairingError("Czar cannot access the system keychain; pairing was not sent.");
  }
}

async function sendPairRequest(
  fetcher: PairingFetch,
  idempotencyKey: string,
  requestBody: { pairingCode: string; deviceName: string; platform: "macos" },
): Promise<Response> {
  try {
    return await fetcher(new URL("/v1/devices/pair", SERVER_ORIGIN), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(requestBody),
    });
  } catch {
    throw new PairingError(
      "Could not reach Czar at localhost. Check that Czar is running; if pairing may have completed, request a new code.",
    );
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new PairingError("The Czar server returned an unreadable pairing response.");
  }
}

function pairingFailure(status: number, body: unknown): PairingError {
  const code = readProblemCode(body);
  if (status === 409 && code === "replay-not-stored") {
    return new PairingError(
      "The pairing response cannot be sent again. Request a new pairing code in the Czar app.",
    );
  }
  if (status === 400) {
    return new PairingError("Pairing code is invalid, used, or expired. Request a new code.");
  }
  if (status === 429)
    return new PairingError("Too many pairing attempts. Wait before trying again.");
  if (status === 503) return new PairingError("Czar is temporarily unavailable. Try again later.");
  return new PairingError("Device pairing failed. Check the code and try again.");
}

function readProblemCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("czarCode" in value)) return undefined;
  return typeof value.czarCode === "string" ? value.czarCode : undefined;
}

function readString(value: unknown, property: string): string {
  if (typeof value !== "object" || value === null || !(property in value)) {
    throw new PairingError("The Czar server returned an invalid pairing response.");
  }
  const result = (value as Record<string, unknown>)[property];
  if (typeof result !== "string") {
    throw new PairingError("The Czar server returned an invalid pairing response.");
  }
  return result;
}

function storeToken(keychain: Keychain, token: string): void {
  try {
    keychain.set(KEYCHAIN_ACCOUNTS.deviceToken, token);
  } catch {
    throw new PairingError(
      "Czar paired this device but could not save its token to the system keychain. Request a new pairing code after fixing keychain access.",
    );
  }
}

async function defaultFetch(input: URL, init: RequestInit): Promise<Response> {
  return fetch(input, init);
}
