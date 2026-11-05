// `gcp-kms` backend (D70, SCR-170 §4): the signer's keys live in Google Cloud KMS as secp256k1
// `EC_SIGN_SECP256K1_SHA256` versions and no key material is ever on the machine. The policy layer,
// the audit rows and every refusal are unchanged: this file only holds key references and signs what
// the service hands it. Every HTTP call is bounded by `kms.signTimeoutMs`; a non-2xx reply, a timeout
// or a malformed body throws an ordinary `Error`, so `service.ts` records `backend-error` with nothing
// signed. Only the key id and the HTTP status are ever logged.
import { createPublicKey, randomBytes, type JsonWebKey } from "node:crypto";
import {
  keccak256,
  recoverAddress,
  serializeTransaction,
  type Hex,
  type TransactionSerializableEIP1559,
} from "viem";
import type { Config } from "@czar/config";
import type { Address, Hash32 } from "@czar/hashing";
import { createLogger, type Logger } from "@czar/logging";
import type { MerchantServiceId, SignerBackend } from "./backend.ts";
import type { AccessTokenSource } from "./gcp-auth.ts";
import type { KeyId } from "./kinds.ts";

/** The only key algorithm this backend accepts (SCR-170 §4). */
export const KMS_ALGORITHM = "EC_SIGN_SECP256K1_SHA256";
/** `cryptoKeys.create` ids must match this (Cloud KMS). */
const CRYPTO_KEY_ID = /^[a-zA-Z0-9_-]{1,63}$/;
/** A full key version resource name. Nothing else may be signed with. */
const VERSION_NAME =
  /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+\/cryptoKeyVersions\/[0-9]+$/;
/** The same key references the local keystore accepts (`local-backend.ts:42`). */
const KEY_REF = /^(K3|K5|K6|K7|K8|K20|relayer|K4:0x[0-9a-f]{40}|K10:[a-z0-9]+(?:-[a-z0-9]+)*)$/;
const MERCHANT_SERVICE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/**
 * A new version is read at most this many times before the creation fails. The task spec fixes the
 * budget at ten; SCR-170 names no parameter for it and PM-061 added no key, so it is a named constant.
 */
export const MAX_VERSION_POLLS = 10;
/** secp256k1 group order; `s` above half of it is normalised to `n − s` (EIP-2). */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1)
      value = (value & 1) === 1 ? 0x82f63b78 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

/** CRC32C (Castagnoli), the checksum Cloud KMS uses for request and response integrity. */
export function crc32c(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC32C_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export class KmsError extends Error {
  readonly rule: string;
  constructor(rule: string, message: string) {
    super(message);
    this.rule = rule;
    this.name = "KmsError";
  }
}

const badSignature = () =>
  new KmsError("kms-bad-signature", "Cloud KMS returned a malformed signature");

/** DER `SEQUENCE { INTEGER r, INTEGER s }` → `{r, s}`; anything else throws. */
export function decodeDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  const bad = badSignature;
  if (der.length < 8 || der[0] !== 0x30) throw bad();
  const total = der[1] ?? 0;
  if (total > 0x80 || total + 2 !== der.length) throw bad();
  let offset = 2;
  const readInteger = (): bigint => {
    if (der[offset] !== 0x02) throw bad();
    const length = der[offset + 1] ?? 0;
    if (length === 0 || length > 33 || offset + 2 + length > der.length) throw bad();
    const body = der.subarray(offset + 2, offset + 2 + length);
    // Minimal, non-negative DER INTEGER: no redundant leading zero, no negative high bit.
    if ((body[0] ?? 0) >= 0x80) throw bad();
    if (body.length > 1 && body[0] === 0 && (body[1] ?? 0) < 0x80) throw bad();
    offset += 2 + length;
    let value = 0n;
    for (const byte of body) value = (value << 8n) | BigInt(byte);
    return value;
  };
  const r = readInteger();
  const s = readInteger();
  if (offset !== der.length) throw bad();
  if (r <= 0n || s <= 0n || r >= SECP256K1_N || s >= SECP256K1_N) throw bad();
  return { r, s };
}

const hex32 = (value: bigint) => value.toString(16).padStart(64, "0");

/**
 * The Ethereum address of a Cloud KMS `PublicKey` PEM: the uncompressed point's `keccak256`, last 20
 * bytes. Refuses anything that is not a secp256k1 EC public key, so a key on another curve can never
 * be signed with.
 */
export function addressFromPublicKeyPem(pem: string): Address {
  let x: string | undefined;
  let y: string | undefined;
  try {
    const key = createPublicKey({ key: pem, format: "pem" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "secp256k1")
      throw new KmsError("kms-wrong-curve", "Cloud KMS public key is not on secp256k1");
    const jwk = key.export({ format: "jwk" }) as JsonWebKey;
    if (jwk.crv !== "secp256k1")
      throw new KmsError("kms-wrong-curve", "Cloud KMS public key is not on secp256k1");
    x = jwk.x;
    y = jwk.y;
  } catch (error) {
    if (error instanceof KmsError) throw error;
    throw new KmsError("kms-bad-public-key", "Cloud KMS public key could not be read");
  }
  const point = Buffer.concat([
    Buffer.from(x ?? "", "base64url"),
    Buffer.from(y ?? "", "base64url"),
  ]);
  if (point.length !== 64)
    throw new KmsError("kms-bad-public-key", "Cloud KMS public key is not a 64-byte point");
  return `0x${keccak256(point).slice(-40)}` as Address;
}

interface KmsKey {
  readonly versionName: string;
  readonly address: Address;
}

export interface GcpKmsBackendOptions {
  readonly config: Config;
  readonly token: AccessTokenSource;
  readonly fetch?: typeof fetch;
  readonly logger?: Pick<Logger, "error">;
  /** The random part of a K4 `cryptoKeyId`; 16 random bytes in production. */
  readonly randomKeySuffix?: () => string;
  /** Waits between version reads; replaced in tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The key-id part of a reference, the only form the logging allowlist accepts for `keyId`. */
function keyIdOf(keyRef: string): string {
  const [head] = keyRef.split(":");
  return head ?? keyRef;
}

/**
 * Opens the Cloud KMS backend: reads the public key of every version in `signer.kms.keyVersions`,
 * then re-registers every enabled pocket key in `signer.kms.pocketKeyRing`, so pocket keys created
 * before a restart are still known and their funds can still be swept.
 */
export async function openGcpKmsBackend(options: GcpKmsBackendOptions): Promise<SignerBackend> {
  const { config } = options;
  const doFetch = options.fetch ?? fetch;
  const logger = options.logger ?? createLogger({ service: "signer", component: "CZ-27" });
  const randomKeySuffix = options.randomKeySuffix ?? (() => randomBytes(16).toString("hex"));
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const baseUrl = String(config.get("signer.kms.apiBaseUrl")).replace(/\/+$/, "");
  const projectId = String(config.get("signer.kms.projectId"));
  const location = String(config.get("signer.kms.location"));
  const keyRing = String(config.get("signer.kms.keyRing"));
  const pocketKeyRing = String(config.get("signer.kms.pocketKeyRing"));
  const timeoutMs = Number(config.get("kms.signTimeoutMs"));
  const ringName = (ring: string) => `projects/${projectId}/locations/${location}/keyRings/${ring}`;

  const keys = new Map<string, KmsKey>();

  async function call(
    method: "GET" | "POST",
    path: string,
    input: { readonly keyRef: string; readonly body?: unknown },
  ): Promise<Record<string, unknown>> {
    const token = await options.token.token();
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}/v1/${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(input.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      logger.error("signer_kms_call_failed", { keyId: keyIdOf(input.keyRef) });
      throw new KmsError("kms-unreachable", `Cloud KMS call failed for ${input.keyRef}`);
    }
    if (!response.ok) {
      logger.error("signer_kms_call_failed", {
        keyId: keyIdOf(input.keyRef),
        httpStatus: response.status,
      });
      throw new KmsError(
        "kms-http-error",
        `Cloud KMS returned ${response.status} for ${input.keyRef}`,
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new KmsError("kms-bad-body", `Cloud KMS reply for ${input.keyRef} was not JSON`);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body))
      throw new KmsError("kms-bad-body", `Cloud KMS reply for ${input.keyRef} was not an object`);
    return body as Record<string, unknown>;
  }

  async function readAddress(versionName: string, keyRef: string): Promise<Address> {
    const body = await call("GET", `${versionName}/publicKey`, { keyRef });
    const algorithm = body["algorithm"];
    if (algorithm !== KMS_ALGORITHM)
      throw new KmsError(
        "kms-wrong-algorithm",
        `key ${keyRef} is not ${KMS_ALGORITHM} on secp256k1`,
      );
    const pem = body["pem"];
    if (typeof pem !== "string" || pem.length === 0)
      throw new KmsError("kms-bad-public-key", `Cloud KMS returned no public key for ${keyRef}`);
    return addressFromPublicKeyPem(pem);
  }

  function register(keyRef: string, versionName: string, address: Address): void {
    keys.set(keyRef, { versionName, address });
  }

  const get = (keyRef: string): KmsKey => {
    const key = keys.get(keyRef);
    if (key === undefined) throw new KmsError("unknown-key", `no key ${keyRef}`);
    return key;
  };

  async function listNames(
    path: string,
    field: "cryptoKeys" | "cryptoKeyVersions",
    keyRef: string,
  ): Promise<readonly Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let pageToken: string | undefined;
    do {
      const query = pageToken === undefined ? "" : `?pageToken=${encodeURIComponent(pageToken)}`;
      const body = await call("GET", `${path}${query}`, { keyRef });
      const page = body[field];
      if (page !== undefined && !Array.isArray(page))
        throw new KmsError("kms-bad-body", `Cloud KMS returned a malformed ${field} page`);
      for (const item of (page ?? []) as unknown[])
        if (typeof item === "object" && item !== null) items.push(item as Record<string, unknown>);
      const next = body["nextPageToken"];
      pageToken = typeof next === "string" && next.length > 0 ? next : undefined;
    } while (pageToken !== undefined);
    return items;
  }

  /** Every enabled version in the pocket ring, registered as `K4:<address>` (restart recovery). */
  async function recoverPocketKeys(): Promise<void> {
    const ring = ringName(pocketKeyRing);
    const cryptoKeys = await listNames(`${ring}/cryptoKeys`, "cryptoKeys", "K4");
    for (const cryptoKey of cryptoKeys) {
      const name = cryptoKey["name"];
      if (typeof name !== "string" || !name.startsWith(`${ring}/cryptoKeys/`)) continue;
      const versions = await listNames(`${name}/cryptoKeyVersions`, "cryptoKeyVersions", "K4");
      for (const version of versions) {
        const versionName = version["name"];
        if (version["state"] !== "ENABLED") continue;
        if (typeof versionName !== "string" || !VERSION_NAME.test(versionName)) continue;
        const address = await readAddress(versionName, "K4");
        register(`K4:${address}`, versionName, address);
      }
    }
  }

  for (const [keyRef, versionName] of Object.entries(
    config.get("signer.kms.keyVersions") as Readonly<Record<string, unknown>>,
  ).toSorted(([left], [right]) => left.localeCompare(right))) {
    if (!KEY_REF.test(keyRef))
      throw new KmsError("bad-key-ref", `signer.kms.keyVersions has a bad key reference ${keyRef}`);
    if (typeof versionName !== "string" || !VERSION_NAME.test(versionName))
      throw new KmsError(
        "bad-key-version",
        `signer.kms.keyVersions[${keyRef}] must be a full cryptoKeyVersions resource name`,
      );
    register(keyRef, versionName, await readAddress(versionName, keyRef));
  }
  await recoverPocketKeys();

  async function signDigest(keyRef: string, digest: Hash32): Promise<Hex> {
    const key = get(keyRef);
    const digestBytes = Buffer.from(digest.slice(2), "hex");
    if (digestBytes.length !== 32)
      throw new KmsError("kms-bad-digest", `digest for ${keyRef} is not 32 bytes`);
    const body = await call("POST", `${key.versionName}:asymmetricSign`, {
      keyRef,
      body: {
        digest: { sha256: digestBytes.toString("base64") },
        digestCrc32c: String(crc32c(digestBytes)),
      },
    });
    if (body["verifiedDigestCrc32c"] !== true)
      throw new KmsError("kms-crc32c", `Cloud KMS did not verify the digest crc32c for ${keyRef}`);
    const signature = body["signature"];
    if (typeof signature !== "string")
      throw new KmsError("kms-bad-signature", `Cloud KMS returned no signature for ${keyRef}`);
    const der = Buffer.from(signature, "base64");
    const checksum = body["signatureCrc32c"];
    if (typeof checksum !== "string" && typeof checksum !== "number")
      throw new KmsError("kms-crc32c", `Cloud KMS returned no signature crc32c for ${keyRef}`);
    if (Number(checksum) !== crc32c(der))
      throw new KmsError("kms-crc32c", `signature crc32c mismatch for ${keyRef}`);
    const { r, s } = decodeDerSignature(der);
    const low = s > SECP256K1_N / 2n ? SECP256K1_N - s : s;
    for (const v of [27, 28] as const) {
      const candidate = `0x${hex32(r)}${hex32(low)}${v.toString(16)}` as Hex;
      const recovered = await recoverAddress({ hash: digest, signature: candidate });
      if (recovered.toLowerCase() === key.address) return candidate;
    }
    throw new KmsError(
      "kms-unrecoverable-signature",
      `no recovery id of the Cloud KMS signature for ${keyRef} gives its address`,
    );
  }

  return {
    name: "gcp-kms",
    keyRefs: () => [...keys.keys()].toSorted(),
    address: (keyRef) => keys.get(keyRef)?.address,
    signDigest,
    async signTransaction(keyRef, tx: TransactionSerializableEIP1559) {
      const digest = keccak256(serializeTransaction(tx)) as Hash32;
      const signature = await signDigest(keyRef, digest);
      return serializeTransaction(tx, {
        r: `0x${signature.slice(2, 66)}` as Hex,
        s: `0x${signature.slice(66, 130)}` as Hex,
        yParity: Number.parseInt(signature.slice(130), 16) - 27,
      });
    },
    async createKey(keyId: KeyId, merchantService?: MerchantServiceId) {
      if (
        keyId === "K10" &&
        (merchantService === undefined || !MERCHANT_SERVICE.test(merchantService))
      )
        throw new KmsError("bad-merchant-service", "K10 creation requires a kebab-case service id");
      if (keyId !== "K10" && merchantService !== undefined)
        throw new KmsError("unexpected-merchant-service", "service scope is only valid for K10");
      const ring = keyId === "K4" ? pocketKeyRing : keyRing;
      const plannedRef = keyId === "K10" ? `K10:${merchantService ?? ""}` : keyId;
      if (keyId !== "K4" && keys.has(plannedRef))
        throw new KmsError("key-exists", `key ${plannedRef} already exists`);
      const cryptoKeyId = keyId === "K4" ? `k4-${randomKeySuffix()}` : plannedRef.replace(":", "-");
      if (!CRYPTO_KEY_ID.test(cryptoKeyId))
        throw new KmsError("bad-key-ref", `${plannedRef} is not a usable Cloud KMS key id`);
      const created = await call(
        "POST",
        `${ringName(ring)}/cryptoKeys?cryptoKeyId=${encodeURIComponent(cryptoKeyId)}`,
        {
          keyRef: plannedRef,
          body: {
            purpose: "ASYMMETRIC_SIGN",
            versionTemplate: { algorithm: KMS_ALGORITHM, protectionLevel: "SOFTWARE" },
          },
        },
      );
      const cryptoKeyName = created["name"];
      if (typeof cryptoKeyName !== "string" || cryptoKeyName.length === 0)
        throw new KmsError("kms-bad-body", `Cloud KMS returned no name for ${plannedRef}`);
      // `cryptoKeys.create` makes version 1; it is not usable until the state is ENABLED.
      const versionName = `${cryptoKeyName}/cryptoKeyVersions/1`;
      if (!VERSION_NAME.test(versionName))
        throw new KmsError(
          "bad-key-version",
          `Cloud KMS returned a bad key name for ${plannedRef}`,
        );
      let enabled = false;
      for (let poll = 0; poll < MAX_VERSION_POLLS && !enabled; poll += 1) {
        if (poll > 0) await sleep(timeoutMs);
        const version = await call("GET", versionName, { keyRef: plannedRef });
        enabled = version["state"] === "ENABLED";
      }
      if (!enabled)
        throw new KmsError(
          "kms-version-not-enabled",
          `key version for ${plannedRef} did not reach ENABLED`,
        );
      const address = await readAddress(versionName, plannedRef);
      const keyRef = keyId === "K4" ? `K4:${address}` : plannedRef;
      if (!KEY_REF.test(keyRef)) throw new KmsError("bad-key-ref", `bad key reference ${keyRef}`);
      if (keys.has(keyRef)) throw new KmsError("key-exists", `key ${keyRef} already exists`);
      register(keyRef, versionName, address);
      return { keyRef, address };
    },
    async destroyKey(keyRef) {
      const key = get(keyRef);
      await call("POST", `${key.versionName}:destroy`, { keyRef, body: {} });
      keys.delete(keyRef);
    },
  };
}
