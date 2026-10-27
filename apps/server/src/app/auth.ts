import { createHash, timingSafeEqual } from "node:crypto";
import cbor from "cbor";
import { p256 } from "@noble/curves/p256.js";
import type {
  AuthChallenge,
  AuthChallengeRequest,
  PasskeyRegistration,
  SessionRequest,
} from "@czar/schemas";
import { validateRecordedExchange } from "@czar/api-contract";
import type { Config } from "@czar/config";
import type { Pool } from "pg";
import type { Context } from "hono";
import { toCircleSmartAccount } from "@circle-fin/modular-wallets-core";
import { createPublicClient, defineChain, http } from "viem";
import { toWebAuthnAccount } from "viem/account-abstraction";
import type { RandomSource } from "#src/http/ids";
import { bearerToken, ulid } from "#src/http/ids";
import { digest } from "#src/http/auth";
import { problem } from "#src/http/problem";
import { parseIdempotencyKey } from "#src/http/validate";

const RP_ID = "localhost";
const { decodeFirstSync } = cbor;
const MAX_CHALLENGE_BYTES = 32;
const ATTESTED_DATA_FLAG = 0x40;
const USER_PRESENT_FLAG = 0x01;

export interface AuthRouteDependencies {
  readonly pool: Pool;
  readonly config: Config;
  readonly clock: { now(): Date };
  readonly random: RandomSource;
  readonly origin: string;
  readonly rpcUrl: string;
}

export async function createAuthChallengeRoute(
  context: Context,
  dependencies: AuthRouteDependencies,
): Promise<Response> {
  const request = await readJson<AuthChallengeRequest>(context);
  if (!request || (request.purpose !== "register" && request.purpose !== "session")) {
    return problemResponse(context, 400, "validation");
  }
  const challenge = dependencies.random.bytes(MAX_CHALLENGE_BYTES);
  const challengeId = ulid("ach_", dependencies.clock.now(), dependencies.random);
  const expiresAt = new Date(
    dependencies.clock.now().getTime() +
      Number(dependencies.config.get("app.challengeTtlSeconds")) * 1000,
  );
  await dependencies.pool.query(
    `INSERT INTO auth_challenges (challenge_id,challenge_hash,purpose,expires_at)
     VALUES ($1,$2,$3,$4)`,
    [challengeId, sha256(challenge), request.purpose, expiresAt],
  );
  const response: AuthChallenge = {
    challengeId,
    challenge: challenge.toString("base64url"),
    expiresAt: expiresAt.toISOString(),
  };
  assertExchange("createAuthChallenge", request, 201, response);
  return jsonResponse(context, 201, response);
}

export async function registerPasskeyRoute(
  context: Context,
  dependencies: AuthRouteDependencies,
): Promise<Response> {
  parseIdempotencyKey(context.req.header("Idempotency-Key"));
  const request = await readJson<PasskeyRegistration>(context);
  if (!request || !validRegistrationShape(request))
    return problemResponse(context, 400, "validation");
  const key = await registrationKey(request, dependencies.origin);
  if (!key) return problemResponse(context, 422, "validation");
  const client = await dependencies.pool.connect();
  try {
    await client.query("BEGIN");
    const challenge = await lockChallenge(
      client,
      request.challengeId,
      "register",
      dependencies.clock.now(),
    );
    if (!challenge || !safeEqual(challenge.challenge_hash, key.challengeHash)) {
      await client.query("ROLLBACK");
      return problemResponse(context, 401, "validation");
    }
    const actualMsca = await circleMscaAddress(
      request.credentialId,
      key.qx,
      key.qy,
      dependencies.rpcUrl,
    );
    if (actualMsca.toLowerCase() !== request.msca.toLowerCase()) {
      await client.query("ROLLBACK");
      return problemResponse(context, 422, "validation");
    }
    const prior = await client.query<{ credential_id: string }>(
      "SELECT credential_id FROM passkey_credentials WHERE credential_id=$1 FOR UPDATE",
      [request.credentialId],
    );
    if (prior.rowCount) {
      await client.query("ROLLBACK");
      return problemResponse(context, 409, "validation");
    }
    const userId = ulid("usr_", dependencies.clock.now(), dependencies.random);
    const token = bearerToken(dependencies.random);
    const expiresAt = new Date(
      dependencies.clock.now().getTime() +
        Number(dependencies.config.get("app.sessionHours")) * 3_600_000,
    );
    await client.query("INSERT INTO users (user_id,msca) VALUES ($1,$2)", [userId, request.msca]);
    await client.query(
      `INSERT INTO passkey_credentials (credential_id,user_id,qx,qy,sign_count,rp_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [request.credentialId, userId, key.qx, key.qy, key.signCount, RP_ID],
    );
    await client.query("UPDATE auth_challenges SET used_at=$2 WHERE challenge_id=$1", [
      request.challengeId,
      dependencies.clock.now(),
    ]);
    await client.query("INSERT INTO sessions (token_hash,user_id,expires_at) VALUES ($1,$2,$3)", [
      digest(token),
      userId,
      expiresAt,
    ]);
    await client.query("COMMIT");
    const response = { sessionToken: token, expiresAt: expiresAt.toISOString() };
    assertExchange("registerPasskey", request, 201, response);
    return jsonResponse(context, 201, response);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createSessionRoute(
  context: Context,
  dependencies: AuthRouteDependencies,
): Promise<Response> {
  parseIdempotencyKey(context.req.header("Idempotency-Key"));
  const request = await readJson<SessionRequest>(context);
  if (!request || !validSessionShape(request)) return problemResponse(context, 400, "validation");
  const assertion = await sessionAssertion(request, dependencies.origin);
  if (!assertion) return problemResponse(context, 401, "validation");
  const client = await dependencies.pool.connect();
  try {
    await client.query("BEGIN");
    const challenge = await lockChallenge(
      client,
      request.challengeId,
      "session",
      dependencies.clock.now(),
    );
    if (!challenge || !safeEqual(challenge.challenge_hash, assertion.challengeHash)) {
      await client.query("ROLLBACK");
      return problemResponse(context, 401, "validation");
    }
    const found = await client.query<{
      user_id: string;
      qx: Buffer;
      qy: Buffer;
      sign_count: string;
    }>(
      "SELECT user_id,qx,qy,sign_count FROM passkey_credentials WHERE credential_id=$1 FOR UPDATE",
      [request.credentialId],
    );
    const credential = found.rows[0];
    if (!credential || !verifyAssertion(assertion, credential.qx, credential.qy)) {
      await client.query("ROLLBACK");
      return problemResponse(context, 401, "validation");
    }
    const oldCounter = Number(credential.sign_count);
    if (oldCounter > 0 && assertion.signCount <= oldCounter) {
      await client.query("ROLLBACK");
      return problemResponse(context, 401, "validation");
    }
    const token = bearerToken(dependencies.random);
    const expiresAt = new Date(
      dependencies.clock.now().getTime() +
        Number(dependencies.config.get("app.sessionHours")) * 3_600_000,
    );
    await client.query("UPDATE auth_challenges SET used_at=$2 WHERE challenge_id=$1", [
      request.challengeId,
      dependencies.clock.now(),
    ]);
    await client.query("UPDATE passkey_credentials SET sign_count=$2 WHERE credential_id=$1", [
      request.credentialId,
      assertion.signCount,
    ]);
    await client.query("INSERT INTO sessions (token_hash,user_id,expires_at) VALUES ($1,$2,$3)", [
      digest(token),
      credential.user_id,
      expiresAt,
    ]);
    await client.query("COMMIT");
    const response = { sessionToken: token, expiresAt: expiresAt.toISOString() };
    assertExchange("createSession", request, 201, response);
    return jsonResponse(context, 201, response);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

interface VerifiedClientData {
  readonly challengeHash: Buffer;
  readonly clientDataHash: Buffer;
}

interface RegistrationKey extends VerifiedClientData {
  readonly qx: Buffer;
  readonly qy: Buffer;
  readonly signCount: number;
}

interface SessionAssertion extends VerifiedClientData {
  readonly authenticatorData: Buffer;
  readonly signature: Buffer;
  readonly signCount: number;
}

async function registrationKey(
  request: PasskeyRegistration,
  origin: string,
): Promise<RegistrationKey | null> {
  const clientData = verifyClientData(request.clientDataJSON, "webauthn.create", origin);
  const attestation = decodeBytes(request.attestationObject, 8192);
  if (!clientData || !attestation) return null;
  try {
    const decoded = decodeFirstSync(attestation) as Record<string, unknown>;
    const authData = asBuffer(decoded["authData"]);
    if (!authData || authData.length < 55) return null;
    const parsed = parseAuthenticatorData(authData);
    if (!parsed || (parsed.flags & ATTESTED_DATA_FLAG) === 0) return null;
    const credentialLength = authData.readUInt16BE(53);
    const credentialStart = 55;
    const credentialEnd = credentialStart + credentialLength;
    if (credentialLength === 0 || credentialEnd >= authData.length) return null;
    const credentialId = authData.subarray(credentialStart, credentialEnd).toString("base64url");
    if (credentialId !== request.credentialId) return null;
    const cose = decodeFirstSync(authData.subarray(credentialEnd)) as Map<unknown, unknown>;
    if (cose.get(1) !== 2 || cose.get(3) !== -7 || cose.get(-1) !== 1) return null;
    const qx = as32ByteBuffer(cose.get(-2));
    const qy = as32ByteBuffer(cose.get(-3));
    if (!qx || !qy) return null;
    return { ...clientData, qx, qy, signCount: parsed.signCount };
  } catch {
    return null;
  }
}

async function sessionAssertion(
  request: SessionRequest,
  origin: string,
): Promise<SessionAssertion | null> {
  const clientData = verifyClientData(request.clientDataJSON, "webauthn.get", origin);
  const authenticatorData = decodeBytes(request.authenticatorData, 4096);
  const signature = decodeBytes(request.signature, 1024);
  if (!clientData || !authenticatorData || !signature) return null;
  const parsed = parseAuthenticatorData(authenticatorData);
  if (!parsed) return null;
  return { ...clientData, authenticatorData, signature, signCount: parsed.signCount };
}

function verifyClientData(
  encoded: string,
  expectedType: string,
  expectedOrigin: string,
): VerifiedClientData | null {
  const bytes = decodeBytes(encoded, 4096);
  if (!bytes) return null;
  try {
    const data = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    if (
      data["type"] !== expectedType ||
      data["origin"] !== expectedOrigin ||
      typeof data["challenge"] !== "string"
    ) {
      return null;
    }
    const challenge = decodeBytes(data["challenge"], 64);
    if (!challenge || challenge.length !== 32) return null;
    return { challengeHash: sha256(challenge), clientDataHash: sha256(bytes) };
  } catch {
    return null;
  }
}

function parseAuthenticatorData(bytes: Buffer): { flags: number; signCount: number } | null {
  if (bytes.length < 37) return null;
  if (!safeEqual(bytes.subarray(0, 32), sha256(Buffer.from(RP_ID, "utf8")))) return null;
  const flags = bytes[32] ?? 0;
  if ((flags & USER_PRESENT_FLAG) === 0) return null;
  return { flags, signCount: bytes.readUInt32BE(33) };
}

function verifyAssertion(assertion: SessionAssertion, qx: Buffer, qy: Buffer): boolean {
  try {
    const compact = p256.Signature.fromDER(assertion.signature).toCompactRawBytes();
    const publicKey = Buffer.concat([Buffer.from([4]), qx, qy]);
    return p256.verify(
      compact,
      Buffer.concat([assertion.authenticatorData, assertion.clientDataHash]),
      publicKey,
      { prehash: true, lowS: false },
    );
  } catch {
    return false;
  }
}

async function circleMscaAddress(
  credentialId: string,
  qx: Buffer,
  qy: Buffer,
  rpcUrl: string,
): Promise<string> {
  const chain = defineChain({
    id: 5042002,
    name: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const client = createPublicClient({ chain, transport: http(rpcUrl) });
  const owner = toWebAuthnAccount({
    credential: {
      id: credentialId,
      publicKey: `0x04${qx.toString("hex")}${qy.toString("hex")}`,
    },
    rpId: RP_ID,
  });
  const account = await toCircleSmartAccount({
    client: client as unknown as Parameters<typeof toCircleSmartAccount>[0]["client"],
    owner: owner as unknown as Parameters<typeof toCircleSmartAccount>[0]["owner"],
  });
  return account.getAddress();
}

async function lockChallenge(
  client: import("pg").PoolClient,
  challengeId: string,
  purpose: "register" | "session",
  now: Date,
): Promise<{ challenge_hash: Buffer } | null> {
  const result = await client.query<{ challenge_hash: Buffer }>(
    `SELECT challenge_hash FROM auth_challenges
     WHERE challenge_id=$1 AND purpose=$2 AND used_at IS NULL AND expires_at>$3 FOR UPDATE`,
    [challengeId, purpose, now],
  );
  return result.rows[0] ?? null;
}

function validRegistrationShape(value: PasskeyRegistration): boolean {
  return (
    typeof value.challengeId === "string" &&
    value.challengeId.length <= 64 &&
    typeof value.credentialId === "string" &&
    value.credentialId.length <= 1024 &&
    typeof value.clientDataJSON === "string" &&
    value.clientDataJSON.length <= 4096 &&
    typeof value.attestationObject === "string" &&
    value.attestationObject.length <= 8192 &&
    /^0x[\da-fA-F]{40}$/.test(value.msca)
  );
}

function validSessionShape(value: SessionRequest): boolean {
  return (
    typeof value.challengeId === "string" &&
    value.challengeId.length <= 64 &&
    typeof value.credentialId === "string" &&
    value.credentialId.length <= 1024 &&
    typeof value.authenticatorData === "string" &&
    value.authenticatorData.length <= 4096 &&
    typeof value.clientDataJSON === "string" &&
    value.clientDataJSON.length <= 4096 &&
    typeof value.signature === "string" &&
    value.signature.length <= 1024
  );
}

async function readJson<T>(context: Context): Promise<T | null> {
  if (!context.req.header("Content-Type")?.toLowerCase().startsWith("application/json"))
    return null;
  try {
    return (await context.req.json()) as T;
  } catch {
    return null;
  }
}

function decodeBytes(value: string, maxLength: number): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > maxLength * 2) return null;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length <= maxLength && bytes.toString("base64url") === value ? bytes : null;
}

function asBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return null;
}

function as32ByteBuffer(value: unknown): Buffer | null {
  const bytes = asBuffer(value);
  return bytes?.length === 32 ? bytes : null;
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function sha256(value: Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

function assertExchange(
  operationId: string,
  requestBody: unknown,
  status: number,
  body: unknown,
): void {
  const result = validateRecordedExchange(operationId, {
    requestBody,
    responseStatus: status,
    responseBody: body,
  });
  if (!result.valid) throw new Error(`Server response failed ${operationId} contract validation.`);
}

function problemResponse(
  context: Context,
  status: number,
  code: "validation" | "session-expired" | "rate-limited",
): Response {
  return context.json(problem(status, code, status === 429), status as 400 | 401 | 429 | 422, {
    "Content-Type": "application/problem+json",
  });
}

function jsonResponse<T>(context: Context, status: 201, body: T): Response {
  return context.json(body, status, { "Content-Type": "application/json" });
}
