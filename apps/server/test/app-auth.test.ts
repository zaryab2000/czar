import { createHash } from "node:crypto";
import cbor from "cbor";
import { p256 } from "@noble/curves/p256.js";
import { describe, expect, it } from "vitest";
import { toCircleSmartAccount } from "@circle-fin/modular-wallets-core";
import { createPublicClient, defineChain, http } from "viem";
import { toWebAuthnAccount } from "viem/account-abstraction";
import { validateRecordedExchange } from "@czar/api-contract";
import { setupDatabase } from "#test/db";
import { createTestContext, testAppConfig } from "#test/fixtures";

const getPool = setupDatabase();

describe("passkey registration origin (SCR-156)", () => {
  async function register(
    context: ReturnType<typeof createTestContext>,
    origin: string,
    seed: number,
  ): Promise<Response> {
    const privateKey = Buffer.alloc(32);
    privateKey[31] = seed;
    const publicKey = p256.getPublicKey(privateKey, false);
    const credentialId = Buffer.from(`origin-credential-${seed}`).toString("base64url");
    const challenge = await createChallenge(context.app, "register");
    const authData = createAuthenticatorData(publicKey, credentialId, 0, true);
    return context.app.request("/v1/auth/passkey", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `7${seed}c52b16-41b0-4c35-88cb-2a88d8799b91`,
      },
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        credentialId,
        clientDataJSON: createClientData("webauthn.create", challenge.challenge, origin),
        attestationObject: cbor
          .encode({ fmt: "none", authData, attStmt: {} })
          .toString("base64url"),
        msca: await counterfactualMsca(credentialId, publicKey),
      }),
    });
  }

  it("accepts the origin set in app.origin and rejects another port with 422", async () => {
    const context = createTestContext(getPool(), {
      config: testAppConfig({ "app.origin": "http://localhost:3001" }),
    });
    expect((await register(context, "http://localhost:3001", 2)).status).toBe(201);
    expect((await register(context, "http://localhost:3002", 3)).status).toBe(422);
  });

  it("checks against the http://localhost default when app.origin is not set", async () => {
    const context = createTestContext(getPool());
    expect((await register(context, "http://localhost", 4)).status).toBe(201);
    expect((await register(context, "http://localhost:3001", 5)).status).toBe(422);
  });
});

describe("app passkey challenge", () => {
  it("issues a single-use purpose-bound challenge and stores only its hash", async () => {
    const pool = getPool();
    const context = createTestContext(pool);
    const requestBody = { purpose: "register" as const };
    const response = await context.app.request("/v1/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    const body = (await response.json()) as {
      challengeId: string;
      challenge: string;
      expiresAt: string;
    };
    expect(response.status).toBe(201);
    expect(Buffer.from(body.challenge, "base64url")).toHaveLength(32);
    expect(Date.parse(body.expiresAt)).toBe(context.clock.now().getTime() + 300_000);
    expect(
      validateRecordedExchange("createAuthChallenge", {
        requestBody,
        responseStatus: response.status,
        responseBody: body,
      }).valid,
    ).toBe(true);
    const saved = await pool.query<{ challenge_hash: Buffer }>(
      "SELECT challenge_hash FROM auth_challenges WHERE challenge_id=$1",
      [body.challengeId],
    );
    expect(saved.rows[0]?.challenge_hash).toEqual(
      createHash("sha256").update(Buffer.from(body.challenge, "base64url")).digest(),
    );
    expect(saved.rows[0]?.challenge_hash.toString("base64url")).not.toBe(body.challenge);
  });

  it("rejects malformed purpose values", async () => {
    const context = createTestContext(getPool());
    const response = await context.app.request("/v1/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ purpose: "login" }),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Type")).toContain("application/problem+json");
  });

  it("registers the attested P-256 key and issues a session after a signed assertion", async () => {
    const pool = getPool();
    const context = createTestContext(pool);
    const privateKey = Buffer.alloc(32);
    privateKey[31] = 1;
    const publicKey = p256.getPublicKey(privateKey, false);
    const credentialId = Buffer.from("virtual-passkey-credential").toString("base64url");
    const registerChallenge = await createChallenge(context.app, "register");
    const authData = createAuthenticatorData(publicKey, credentialId, 0, true);
    const attestationObject = cbor
      .encode({ fmt: "none", authData, attStmt: {} })
      .toString("base64url");
    const registrationBody = {
      challengeId: registerChallenge.challengeId,
      credentialId,
      clientDataJSON: createClientData("webauthn.create", registerChallenge.challenge),
      attestationObject,
      msca: await counterfactualMsca(credentialId, publicKey),
    };
    const mismatch = await context.app.request("/v1/auth/passkey", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "42c52b16-41b0-4c35-88cb-2a88d8799b91",
      },
      body: JSON.stringify({
        ...registrationBody,
        msca: "0x0000000000000000000000000000000000000001",
      }),
    });
    expect(mismatch.status).toBe(422);
    const missingRegistration = await pool.query(
      "SELECT 1 FROM passkey_credentials WHERE credential_id=$1",
      [credentialId],
    );
    expect(missingRegistration.rowCount).toBe(0);
    const registered = await context.app.request("/v1/auth/passkey", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "52c52b16-41b0-4c35-88cb-2a88d8799b91",
      },
      body: JSON.stringify(registrationBody),
    });
    expect(registered.status).toBe(201);
    const session = (await registered.json()) as { sessionToken: string; expiresAt: string };
    expect(Buffer.from(session.sessionToken, "base64url")).toHaveLength(32);
    expect(Date.parse(session.expiresAt)).toBe(context.clock.now().getTime() + 86_400_000);

    const sessionChallenge = await createChallenge(context.app, "session");
    const challengeRecord = await pool.query<{ challenge_hash: Buffer }>(
      "SELECT challenge_hash FROM auth_challenges WHERE challenge_id=$1",
      [sessionChallenge.challengeId],
    );
    expect(challengeRecord.rows[0]?.challenge_hash).toEqual(
      createHash("sha256").update(Buffer.from(sessionChallenge.challenge, "base64url")).digest(),
    );
    const assertionData = createAuthenticatorData(publicKey, credentialId, 1, false);
    const clientDataJSON = createClientData("webauthn.get", sessionChallenge.challenge);
    const clientData = Buffer.from(clientDataJSON, "base64url");
    const signedData = Buffer.concat([
      assertionData,
      createHash("sha256").update(clientData).digest(),
    ]);
    const digest = createHash("sha256").update(signedData).digest();
    const derSignature = p256.sign(digest, privateKey).toDERRawBytes();
    const compactSignature = p256.Signature.fromDER(derSignature).toCompactRawBytes();
    expect(
      p256.verify(compactSignature, signedData, publicKey, { prehash: true, lowS: false }),
    ).toBe(true);
    const savedKey = await pool.query<{ qx: Buffer; qy: Buffer }>(
      "SELECT qx,qy FROM passkey_credentials WHERE credential_id=$1",
      [credentialId],
    );
    expect(
      p256.verify(
        compactSignature,
        signedData,
        Buffer.concat([Buffer.from([4]), savedKey.rows[0]!.qx, savedKey.rows[0]!.qy]),
        { prehash: true, lowS: false },
      ),
    ).toBe(true);
    const signature = Buffer.from(derSignature).toString("base64url");
    const login = await context.app.request("/v1/auth/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "72c52b16-41b0-4c35-88cb-2a88d8799b91",
      },
      body: JSON.stringify({
        challengeId: sessionChallenge.challengeId,
        credentialId,
        authenticatorData: assertionData.toString("base64url"),
        clientDataJSON,
        signature,
      }),
    });
    expect(login.status, await login.clone().text()).toBe(201);
    const saved = await pool.query<{ sign_count: string }>(
      "SELECT sign_count FROM passkey_credentials WHERE credential_id=$1",
      [credentialId],
    );
    expect(saved.rows[0]?.sign_count).toBe("1");
  });
});

async function createChallenge(
  app: ReturnType<typeof createTestContext>["app"],
  purpose: "register" | "session",
) {
  const response = await app.request("/v1/auth/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ purpose }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { challengeId: string; challenge: string };
}

function createAuthenticatorData(
  publicKey: Uint8Array,
  credentialId: string,
  signCount: number,
  registration: boolean,
): Buffer {
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(signCount);
  const prefix = Buffer.concat([
    createHash("sha256").update("localhost").digest(),
    Buffer.from([registration ? 0x41 : 0x01]),
    counter,
  ]);
  if (!registration) return prefix;
  const credential = Buffer.from(credentialId, "base64url");
  const length = Buffer.alloc(2);
  length.writeUInt16BE(credential.length);
  const coseKey = cbor.encode(
    new Map<unknown, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(publicKey.slice(1, 33))],
      [-3, Buffer.from(publicKey.slice(33))],
    ]),
  );
  return Buffer.concat([prefix, Buffer.alloc(16), length, credential, coseKey]);
}

function createClientData(type: string, challenge: string, origin = "http://localhost"): string {
  return Buffer.from(JSON.stringify({ type, challenge, origin })).toString("base64url");
}

async function counterfactualMsca(credentialId: string, publicKey: Uint8Array): Promise<string> {
  const chain = defineChain({
    id: 5042002,
    name: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
    rpcUrls: { default: { http: ["http://127.0.0.1:8549"] } },
  });
  const client = createPublicClient({ chain, transport: http("http://127.0.0.1:8549") });
  const owner = toWebAuthnAccount({
    credential: { id: credentialId, publicKey: `0x${Buffer.from(publicKey).toString("hex")}` },
    rpId: "localhost",
  });
  const account = await toCircleSmartAccount({
    client: client as unknown as Parameters<typeof toCircleSmartAccount>[0]["client"],
    owner: owner as unknown as Parameters<typeof toCircleSmartAccount>[0]["owner"],
  });
  return account.getAddress();
}
