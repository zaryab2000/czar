// A fake Google Cloud KMS and a fake metadata server, both on loopback. No test ever reaches a real
// Google endpoint (PM-017). The fake holds real secp256k1 keys generated per run, signs with viem and
// returns DER signatures, so every signature the backend handles is a real one. Faults are switchable
// so the backend's refusals can be checked: 4xx, 5xx, a hang, bad DER, a high `s`, a wrong-curve public
// key, a wrong `signatureCrc32c` and `verifiedDigestCrc32c = false`.
import { generateKeyPairSync, randomBytes, type JsonWebKey } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Hex } from "viem";
import { sign } from "viem/accounts";
import { crc32c } from "../src/gcp-kms-backend.ts";

export const SECP256K1_ALGORITHM = "EC_SIGN_SECP256K1_SHA256";
/** secp256k1 group order, for forcing a high `s` (n − s). */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export interface FakeKmsFaults {
  /** Reply to `asymmetricSign` with this status instead of signing. */
  signStatus?: number;
  /** Hold the `asymmetricSign` reply this long, so the backend's timeout fires. */
  signDelayMs?: number;
  /** Return bytes that are not a DER ECDSA signature. */
  badDer?: boolean;
  /** Return n − s, so the backend must normalise. */
  highS?: boolean;
  /** Return a `signatureCrc32c` that does not match the signature. */
  wrongSignatureCrc32c?: boolean;
  /** Return `verifiedDigestCrc32c: false`. */
  unverifiedDigestCrc32c?: boolean;
  /** Reply to `publicKey` with a P-256 key instead of a secp256k1 one. */
  wrongCurvePublicKey?: boolean;
  /** Reply to `publicKey` with this status. */
  publicKeyStatus?: number;
  /** Reply to `cryptoKeys.create` with this status. */
  createStatus?: number;
  /** How many version reads report `PENDING_GENERATION` before `ENABLED`. */
  pendingGenerationReads?: number;
}

export interface FakeKmsKeyVersion {
  readonly versionName: string;
  readonly privateKey: Hex;
  readonly pem: string;
  state: "PENDING_GENERATION" | "ENABLED" | "DESTROY_SCHEDULED";
  pendingReadsLeft: number;
}

export interface FakeKmsRequest {
  readonly method: string;
  readonly path: string;
  readonly authorized: boolean;
}

export interface FakeKms {
  readonly baseUrl: string;
  readonly projectId: string;
  readonly location: string;
  readonly keyRing: string;
  readonly pocketKeyRing: string;
  readonly faults: FakeKmsFaults;
  readonly requests: FakeKmsRequest[];
  /** The resource name of a key ring in this fake. */
  ringName(ring: string): string;
  /** Creates an enabled key with one version and returns it. */
  addKey(ring: string, cryptoKeyId: string): FakeKmsKeyVersion;
  version(versionName: string): FakeKmsKeyVersion | undefined;
  /** Every version created through the REST API, in creation order. */
  created(): readonly { readonly ring: string; readonly cryptoKeyId: string }[];
  close(): Promise<void>;
}

export interface FakeMetadata {
  readonly tokenUrl: string;
  /** Tokens handed out, newest last. */
  readonly issued: string[];
  /** Requests that arrived without the `Metadata-Flavor: Google` header. */
  readonly unflavoured: number;
  expiresInSeconds: number;
  status: number;
  close(): Promise<void>;
}

interface StoredKey {
  readonly ring: string;
  readonly cryptoKeyId: string;
  readonly versions: FakeKmsKeyVersion[];
}

/** A fresh secp256k1 key: the raw scalar viem signs with, and the SPKI PEM Cloud KMS publishes. */
export function freshSecp256k1(): { privateKey: Hex; pem: string } {
  const pair = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  const jwk = pair.privateKey.export({ format: "jwk" }) as JsonWebKey;
  const d = jwk.d;
  if (typeof d !== "string") throw new Error("fake KMS key has no scalar");
  const scalar = Buffer.from(d, "base64url");
  if (scalar.length !== 32) throw new Error("fake KMS key scalar is not 32 bytes");
  return {
    privateKey: `0x${scalar.toString("hex")}` as Hex,
    pem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function freshP256Pem(): string {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return pair.publicKey.export({ type: "spki", format: "pem" }).toString();
}

function derInteger(value: bigint): Buffer {
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  let body = Buffer.from(hex, "hex");
  let start = 0;
  while (start < body.length - 1 && body[start] === 0 && (body[start + 1] ?? 0) < 0x80) start += 1;
  body = body.subarray(start);
  if ((body[0] ?? 0) >= 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return Buffer.concat([Buffer.from([0x02, body.length]), body]);
}

/** DER `SEQUENCE { INTEGER r, INTEGER s }`, written independently of the backend's decoder. */
export function encodeDer(r: bigint, s: bigint): Buffer {
  const content = Buffer.concat([derInteger(r), derInteger(s)]);
  return Buffer.concat([Buffer.from([0x30, content.length]), content]);
}

const json = (body: unknown) => Buffer.from(JSON.stringify(body));

type Reply = (status: number, payload: unknown) => void;

const replyTo =
  (response: ServerResponse): Reply =>
  (status, payload) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(json(payload));
  };

async function readBody(stream: AsyncIterable<Buffer>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function listen(server: Server): Promise<number> {
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => done((server.address() as AddressInfo).port));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((done, fail) => {
    server.closeAllConnections();
    server.close((error) => (error ? fail(error) : done()));
  });
}

export interface FakeMetadataOptions {
  readonly expiresInSeconds?: number;
}

export async function startFakeMetadata(options: FakeMetadataOptions = {}): Promise<FakeMetadata> {
  let issuedCount = 0;
  const issued: string[] = [];
  const state = {
    expiresInSeconds: options.expiresInSeconds ?? 3599,
    status: 200,
    unflavoured: 0,
  };
  const server = createServer((request, response) => {
    if (request.headers["metadata-flavor"] !== "Google") {
      state.unflavoured += 1;
      response.writeHead(403, { "content-type": "application/json" });
      response.end(json({ error: "missing Metadata-Flavor" }));
      return;
    }
    if (state.status !== 200) {
      response.writeHead(state.status, { "content-type": "application/json" });
      response.end(json({ error: "metadata refused" }));
      return;
    }
    issuedCount += 1;
    const token = `fake-access-token-${issuedCount}`;
    issued.push(token);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      json({
        access_token: token,
        expires_in: state.expiresInSeconds,
        token_type: "Bearer",
      }),
    );
  });
  const port = await listen(server);
  return {
    tokenUrl: `http://127.0.0.1:${port}/computeMetadata/v1/instance/service-accounts/default/token`,
    issued,
    get unflavoured() {
      return state.unflavoured;
    },
    get expiresInSeconds() {
      return state.expiresInSeconds;
    },
    set expiresInSeconds(value: number) {
      state.expiresInSeconds = value;
    },
    get status() {
      return state.status;
    },
    set status(value: number) {
      state.status = value;
    },
    close: () => closeServer(server),
  };
}

export interface FakeKmsOptions {
  /** Tokens the fake accepts; anything else is 401. A function is read on every request. */
  readonly acceptToken?: () => readonly string[];
  readonly projectId?: string;
  readonly location?: string;
  readonly keyRing?: string;
  readonly pocketKeyRing?: string;
}

export async function startFakeKms(options: FakeKmsOptions = {}): Promise<FakeKms> {
  const projectId = options.projectId ?? "czar-alpha-test";
  const location = options.location ?? "asia-south1";
  const keyRing = options.keyRing ?? "czar-alpha";
  const pocketKeyRing = options.pocketKeyRing ?? "czar-alpha-pockets";
  const faults: FakeKmsFaults = {};
  const requests: FakeKmsRequest[] = [];
  const keys: StoredKey[] = [];
  const createdOrder: { ring: string; cryptoKeyId: string }[] = [];

  const ringName = (ring: string) => `projects/${projectId}/locations/${location}/keyRings/${ring}`;

  const addKey = (ring: string, cryptoKeyId: string): FakeKmsKeyVersion => {
    const material = freshSecp256k1();
    const version: FakeKmsKeyVersion = {
      versionName: `${ringName(ring)}/cryptoKeys/${cryptoKeyId}/cryptoKeyVersions/1`,
      privateKey: material.privateKey,
      pem: material.pem,
      state: "ENABLED",
      pendingReadsLeft: 0,
    };
    keys.push({ ring, cryptoKeyId, versions: [version] });
    return version;
  };

  const version = (versionName: string) =>
    keys.flatMap((key) => key.versions).find((candidate) => candidate.versionName === versionName);

  function createKey(parent: string, url: URL, reply: Reply) {
    if (faults.createStatus !== undefined)
      return reply(faults.createStatus, { error: { code: faults.createStatus } });
    const cryptoKeyId = url.searchParams.get("cryptoKeyId");
    if (cryptoKeyId === null || !/^[a-zA-Z0-9_-]{1,63}$/.test(cryptoKeyId))
      return reply(400, { error: { code: 400, message: "bad cryptoKeyId" } });
    // Any key ring under this project and location exists in the fake, so one server can serve
    // many backends with rings of their own.
    const prefix = `projects/${projectId}/locations/${location}/keyRings/`;
    if (!parent.startsWith(prefix)) return reply(404, { error: { code: 404 } });
    const ring = parent.slice(prefix.length);
    if (!/^[a-zA-Z0-9_-]{1,63}$/.test(ring)) return reply(404, { error: { code: 404 } });
    if (keys.some((key) => key.ring === ring && key.cryptoKeyId === cryptoKeyId))
      return reply(409, { error: { code: 409, status: "ALREADY_EXISTS" } });
    const created = addKey(ring, cryptoKeyId);
    created.pendingReadsLeft = faults.pendingGenerationReads ?? 0;
    createdOrder.push({ ring, cryptoKeyId });
    return reply(200, {
      name: `${parent}/cryptoKeys/${cryptoKeyId}`,
      purpose: "ASYMMETRIC_SIGN",
      versionTemplate: { algorithm: SECP256K1_ALGORITHM, protectionLevel: "SOFTWARE" },
    });
  }

  async function signVersion(versionName: string, body: string, reply: Reply) {
    if (faults.signStatus !== undefined)
      return reply(faults.signStatus, { error: { code: faults.signStatus } });
    if (faults.signDelayMs !== undefined)
      await new Promise((done) => setTimeout(done, faults.signDelayMs));
    const target = version(versionName);
    if (target === undefined) return reply(404, { error: { code: 404 } });
    let digest: Buffer;
    try {
      const parsed = JSON.parse(body) as { digest?: { sha256?: string } };
      digest = Buffer.from(parsed.digest?.sha256 ?? "", "base64");
    } catch {
      return reply(400, { error: { code: 400 } });
    }
    if (digest.length !== 32) return reply(400, { error: { code: 400 } });
    const raw = await sign({
      hash: `0x${digest.toString("hex")}` as Hex,
      privateKey: target.privateKey,
      to: "hex",
    });
    const r = BigInt(`0x${raw.slice(2, 66)}`);
    const lowS = BigInt(`0x${raw.slice(66, 130)}`);
    const s = faults.highS === true ? N - lowS : lowS;
    const der = faults.badDer === true ? randomBytes(70) : encodeDer(r, s);
    const checksum = faults.wrongSignatureCrc32c === true ? crc32c(der) + 1 : crc32c(der);
    return reply(200, {
      signature: der.toString("base64"),
      signatureCrc32c: String(checksum),
      verifiedDigestCrc32c: faults.unverifiedDigestCrc32c !== true,
      name: versionName,
      protectionLevel: "SOFTWARE",
    });
  }

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const accepted = options.acceptToken?.() ?? undefined;
      const header = request.headers.authorization ?? "";
      const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
      const authorized =
        token !== undefined &&
        token.length > 0 &&
        (accepted === undefined || accepted.includes(token));
      requests.push({ method: request.method ?? "GET", path: url.pathname, authorized });
      const body = await readBody(request);
      const reply = replyTo(response);
      if (!authorized) return reply(401, { error: { code: 401, status: "UNAUTHENTICATED" } });
      if (!url.pathname.startsWith("/v1/")) return reply(404, { error: { code: 404 } });
      const resource = url.pathname.slice("/v1/".length);

      if (resource.endsWith(":asymmetricSign"))
        return signVersion(resource.slice(0, -":asymmetricSign".length), body, reply);
      if (resource.endsWith(":destroy")) {
        const target = version(resource.slice(0, -":destroy".length));
        if (target === undefined) return reply(404, { error: { code: 404 } });
        target.state = "DESTROY_SCHEDULED";
        return reply(200, { name: target.versionName, state: target.state });
      }
      if (resource.endsWith("/publicKey")) {
        const target = version(resource.slice(0, -"/publicKey".length));
        if (faults.publicKeyStatus !== undefined)
          return reply(faults.publicKeyStatus, { error: { code: faults.publicKeyStatus } });
        if (target === undefined) return reply(404, { error: { code: 404 } });
        const pem = faults.wrongCurvePublicKey === true ? freshP256Pem() : target.pem;
        return reply(200, {
          pem,
          algorithm: SECP256K1_ALGORITHM,
          name: target.versionName,
          protectionLevel: "SOFTWARE",
        });
      }
      if (resource.endsWith("/cryptoKeys")) {
        const parent = resource.slice(0, -"/cryptoKeys".length);
        if (request.method === "POST") return createKey(parent, url, reply);
        const ring = keys.filter((key) => ringName(key.ring) === parent);
        return reply(200, {
          cryptoKeys: ring.map((key) => ({
            name: `${parent}/cryptoKeys/${key.cryptoKeyId}`,
            purpose: "ASYMMETRIC_SIGN",
          })),
        });
      }
      if (resource.endsWith("/cryptoKeyVersions")) {
        const parent = resource.slice(0, -"/cryptoKeyVersions".length);
        const key = keys.find(
          (candidate) =>
            `${ringName(candidate.ring)}/cryptoKeys/${candidate.cryptoKeyId}` === parent,
        );
        if (key === undefined) return reply(404, { error: { code: 404 } });
        return reply(200, {
          cryptoKeyVersions: key.versions.map((item) => ({
            name: item.versionName,
            state: item.state,
            algorithm: SECP256K1_ALGORITHM,
            protectionLevel: "SOFTWARE",
          })),
        });
      }
      const target = version(resource);
      if (target === undefined) return reply(404, { error: { code: 404 } });
      if (target.pendingReadsLeft > 0) {
        target.pendingReadsLeft -= 1;
        return reply(200, {
          name: target.versionName,
          state: "PENDING_GENERATION",
          algorithm: SECP256K1_ALGORITHM,
        });
      }
      return reply(200, {
        name: target.versionName,
        state: target.state,
        algorithm: SECP256K1_ALGORITHM,
        protectionLevel: "SOFTWARE",
      });
    })().catch(() => {
      response.destroy();
    });
  });

  const port = await listen(server);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    projectId,
    location,
    keyRing,
    pocketKeyRing,
    faults,
    requests,
    ringName,
    addKey,
    version,
    created: () => createdOrder,
    close: () => closeServer(server),
  };
}
