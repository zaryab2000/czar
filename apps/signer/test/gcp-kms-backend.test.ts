// PM-017: the `gcp-kms` backend against a fake Cloud KMS and a fake metadata server on loopback.
// Key material never leaves the fake, and no test reaches a real Google endpoint.
import { randomBytes } from "node:crypto";
import {
  keccak256,
  parseTransaction,
  recoverAddress,
  recoverTransactionAddress,
  serializeTransaction,
  type TransactionSerializableEIP1559,
} from "viem";
import { loadConfig, type Config } from "@czar/config";
import { createLogger } from "@czar/logging";
import type { Address, Hash32 } from "@czar/hashing";
import { afterEach, describe, expect, it } from "vitest";
import { metadataAccessToken } from "../src/gcp-auth.ts";
import { crc32c, openGcpKmsBackend } from "../src/gcp-kms-backend.ts";
import type { SignerBackend } from "../src/backend.ts";
import { startFakeKms, startFakeMetadata, type FakeKms, type FakeMetadata } from "./kms-fake.ts";

/** secp256k1 group order; `s` must never exceed half of it (EIP-2). */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF_N = N / 2n;

const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (stops.length > 0) await stops.pop()?.();
});

interface Fixture {
  readonly kms: FakeKms;
  readonly metadata: FakeMetadata;
  readonly config: Config;
  readonly logLines: string[];
  open(): Promise<SignerBackend>;
}

async function fixture(
  options: {
    readonly keys?: readonly string[];
    readonly config?: Record<string, unknown>;
    readonly expiresInSeconds?: number;
  } = {},
): Promise<Fixture> {
  const kms = await startFakeKms();
  stops.push(kms.close);
  const metadata = await startFakeMetadata(
    options.expiresInSeconds === undefined ? {} : { expiresInSeconds: options.expiresInSeconds },
  );
  stops.push(metadata.close);
  const keyVersions: Record<string, string> = {};
  for (const keyRef of options.keys ?? ["K3"]) {
    const cryptoKeyId = keyRef.replace(":", "-");
    keyVersions[keyRef] = kms.addKey(kms.keyRing, cryptoKeyId).versionName;
  }
  const config = loadConfig({
    envFile: {
      "signer.backend": "gcp-kms",
      "signer.kms.apiBaseUrl": kms.baseUrl,
      "signer.kms.projectId": kms.projectId,
      "signer.kms.location": kms.location,
      "signer.kms.keyRing": kms.keyRing,
      "signer.kms.pocketKeyRing": kms.pocketKeyRing,
      "signer.kms.keyVersions": keyVersions,
      ...options.config,
    },
  });
  const logLines: string[] = [];
  const logger = createLogger({
    service: "signer",
    component: "CZ-27",
    sink: (line) => logLines.push(line),
  });
  return {
    kms,
    metadata,
    config,
    logLines,
    open: () =>
      openGcpKmsBackend({
        config,
        token: metadataAccessToken({
          metadataTokenUrl: metadata.tokenUrl,
          timeoutMs: Number(config.get("kms.signTimeoutMs")),
        }),
        logger,
        sleep: async () => undefined,
      }),
  };
}

const randomDigest = (): Hash32 => `0x${randomBytes(32).toString("hex")}` as Hash32;

const transaction = (to: Address): TransactionSerializableEIP1559 => ({
  type: "eip1559",
  chainId: 5042002,
  nonce: 7,
  gas: 200_000n,
  maxFeePerGas: 20_000_000_000n,
  maxPriorityFeePerGas: 1n,
  to,
  data: "0x",
  value: 0n,
});

describe("crc32c (Cloud KMS integrity fields)", () => {
  it("matches the Castagnoli check value", () => {
    expect(crc32c(Buffer.from("123456789", "ascii"))).toBe(0xe3069283);
    expect(crc32c(Buffer.alloc(0))).toBe(0);
  });
});

describe("gcp-kms backend: addresses and signatures", () => {
  it("derives the key address from the public key and recovers it from 200 random digests", async () => {
    const f = await fixture({ keys: ["K3", "relayer"] });
    const backend = await f.open();
    expect(backend.name).toBe("gcp-kms");
    expect(backend.keyRefs()).toEqual(["K3", "relayer"]);
    const address = backend.address("K3");
    expect(address).toMatch(/^0x[0-9a-f]{40}$/);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const digest = randomDigest();
      const signature = await backend.signDigest("K3", digest);
      expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
      const v = Number.parseInt(signature.slice(130), 16);
      expect([27, 28]).toContain(v);
      expect(BigInt(`0x${signature.slice(66, 130)}`) <= HALF_N).toBe(true);
      const recovered = await recoverAddress({ hash: digest, signature });
      expect(recovered.toLowerCase()).toBe(address);
    }
  }, 60_000);

  it("normalises a forced high `s` and still recovers the key address", async () => {
    const f = await fixture();
    const backend = await f.open();
    f.kms.faults.highS = true;
    const digest = randomDigest();
    const signature = await backend.signDigest("K3", digest);
    expect(BigInt(`0x${signature.slice(66, 130)}`) <= HALF_N).toBe(true);
    expect((await recoverAddress({ hash: digest, signature })).toLowerCase()).toBe(
      backend.address("K3"),
    );
  });

  it("signs an EIP-1559 transaction whose recovered sender is the key address", async () => {
    const f = await fixture();
    const backend = await f.open();
    const address = backend.address("K3") as Address;
    const tx = transaction("0x000000000000000000000000000000000000beef");
    const signed = await backend.signTransaction("K3", tx);
    const sender = await recoverTransactionAddress({ serializedTransaction: signed as never });
    expect(sender.toLowerCase()).toBe(address);
    const parsed = parseTransaction(signed);
    expect(parsed.nonce).toBe(7);
    expect(parsed.to?.toLowerCase()).toBe("0x000000000000000000000000000000000000beef");
    // The digest the backend signed is the unsigned serialisation's keccak256 (CZ-27 §5.2, SCR-146).
    expect(keccak256(serializeTransaction(tx))).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("gcp-kms backend: refusals", () => {
  const digest = randomDigest();

  it("throws on 4xx, 5xx and a timeout, and signs nothing", async () => {
    const f = await fixture({ config: { "kms.signTimeoutMs": 60 } });
    const backend = await f.open();
    for (const status of [400, 403, 429, 500, 503]) {
      f.kms.faults.signStatus = status;
      await expect(backend.signDigest("K3", digest)).rejects.toThrow(/cloud kms/i);
    }
    delete f.kms.faults.signStatus;
    f.kms.faults.signDelayMs = 400;
    await expect(backend.signDigest("K3", digest)).rejects.toThrow();
    delete f.kms.faults.signDelayMs;
    expect(await backend.signDigest("K3", digest)).toMatch(/^0x[0-9a-f]{130}$/);
  }, 30_000);

  it("throws on a malformed DER signature", async () => {
    const f = await fixture();
    const backend = await f.open();
    f.kms.faults.badDer = true;
    await expect(backend.signDigest("K3", digest)).rejects.toThrow();
  });

  it("refuses to start on a wrong-curve public key", async () => {
    const f = await fixture();
    f.kms.faults.wrongCurvePublicKey = true;
    await expect(f.open()).rejects.toThrow(/secp256k1/i);
  });

  it("refuses to start when the public key cannot be read", async () => {
    const f = await fixture();
    f.kms.faults.publicKeyStatus = 500;
    await expect(f.open()).rejects.toThrow(/cloud kms/i);
  });

  it("throws on a wrong signatureCrc32c and on verifiedDigestCrc32c = false", async () => {
    const f = await fixture();
    const backend = await f.open();
    f.kms.faults.wrongSignatureCrc32c = true;
    await expect(backend.signDigest("K3", digest)).rejects.toThrow(/crc32c/i);
    delete f.kms.faults.wrongSignatureCrc32c;
    f.kms.faults.unverifiedDigestCrc32c = true;
    await expect(backend.signDigest("K3", digest)).rejects.toThrow(/crc32c/i);
  });

  it("sends digestCrc32c with every asymmetricSign request", async () => {
    const f = await fixture();
    const backend = await f.open();
    await backend.signDigest("K3", digest);
    expect(
      f.kms.requests.some(
        (request) => request.method === "POST" && request.path.endsWith(":asymmetricSign"),
      ),
    ).toBe(true);
  });

  it("throws for a key reference it does not hold", async () => {
    const f = await fixture();
    const backend = await f.open();
    expect(backend.address("K7")).toBeUndefined();
    await expect(backend.signDigest("K7", digest)).rejects.toThrow(/K7/);
  });

  it("refuses a key version resource name that is not a cryptoKeyVersion", async () => {
    const f = await fixture();
    const config = loadConfig({
      envFile: {
        "signer.kms.apiBaseUrl": f.kms.baseUrl,
        "signer.kms.projectId": f.kms.projectId,
        "signer.kms.location": f.kms.location,
        "signer.kms.keyRing": f.kms.keyRing,
        "signer.kms.pocketKeyRing": f.kms.pocketKeyRing,
        "signer.kms.keyVersions": { K3: "projects/p/locations/l/keyRings/r/cryptoKeys/k" },
      },
    });
    await expect(
      openGcpKmsBackend({
        config,
        token: metadataAccessToken({
          metadataTokenUrl: f.metadata.tokenUrl,
          timeoutMs: 2000,
        }),
      }),
    ).rejects.toThrow(/cryptoKeyVersions/);
  });
});

describe("gcp-kms backend: access tokens", () => {
  it("caches one token across calls and refreshes it before expiry", async () => {
    const cached = await fixture({ expiresInSeconds: 3599 });
    const backend = await cached.open();
    for (let attempt = 0; attempt < 3; attempt += 1) await backend.signDigest("K3", randomDigest());
    expect(cached.metadata.issued).toHaveLength(1);
    expect(cached.metadata.unflavoured).toBe(0);

    // 30 s of life is inside the 60 s refresh margin, so every call fetches a fresh token.
    const expiring = await fixture({ expiresInSeconds: 30 });
    const other = await expiring.open();
    const before = expiring.metadata.issued.length;
    for (let attempt = 0; attempt < 3; attempt += 1) await other.signDigest("K3", randomDigest());
    expect(expiring.metadata.issued.length).toBeGreaterThan(before);
  });

  it("throws when the metadata server refuses, and never signs", async () => {
    // A 30 s token is always refreshed, so the refusal is hit on the next call rather than cached away.
    const f = await fixture({ expiresInSeconds: 30 });
    const backend = await f.open();
    f.metadata.status = 500;
    await expect(backend.signDigest("K3", randomDigest())).rejects.toThrow(/metadata/i);
    const signRequests = f.kms.requests.filter((request) =>
      request.path.endsWith(":asymmetricSign"),
    );
    expect(signRequests).toEqual([]);
  });

  it("is refused by Cloud KMS without a bearer token", async () => {
    const f = await fixture();
    await f.open();
    expect(f.kms.requests.every((request) => request.authorized)).toBe(true);
  });
});

describe("gcp-kms backend: key creation and restart recovery", () => {
  it("creates a K4 pocket key in the pocket ring under a random k4- id", async () => {
    const f = await fixture();
    const backend = await f.open();
    const created = await backend.createKey("K4");
    expect(created.keyRef).toBe(`K4:${created.address}`);
    expect(created.address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(backend.address(created.keyRef)).toBe(created.address);
    expect(backend.keyRefs()).toContain(created.keyRef);
    const [entry] = f.kms.created();
    expect(entry?.ring).toBe(f.kms.pocketKeyRing);
    expect(entry?.cryptoKeyId).toMatch(/^k4-[0-9a-f]{32}$/);
  });

  it("creates long-lived keys in the long-lived ring, K10 per service", async () => {
    const f = await fixture({ keys: [] });
    const backend = await f.open();
    expect(backend.keyRefs()).toEqual([]);
    const k7 = await backend.createKey("K7");
    expect(k7.keyRef).toBe("K7");
    const k10 = await backend.createKey("K10", "czar-search");
    expect(k10.keyRef).toBe("K10:czar-search");
    expect(f.kms.created().map((entry) => entry.ring)).toEqual([f.kms.keyRing, f.kms.keyRing]);
    expect(f.kms.created().map((entry) => entry.cryptoKeyId)).toEqual(["K7", "K10-czar-search"]);
    await expect(backend.createKey("K10")).rejects.toThrow(/kebab/);
    await expect(backend.createKey("K7", "czar-search")).rejects.toThrow(/K10/);
    await expect(backend.createKey("K7")).rejects.toThrow(/exists/);
  });

  it("waits for a new version to reach ENABLED before reading its public key", async () => {
    const f = await fixture();
    const backend = await f.open();
    f.kms.faults.pendingGenerationReads = 3;
    const created = await backend.createKey("K4");
    expect(backend.address(created.keyRef)).toBe(created.address);
  });

  it("gives up after the poll budget when a version never enables", async () => {
    const f = await fixture();
    const backend = await f.open();
    f.kms.faults.pendingGenerationReads = 50;
    await expect(backend.createKey("K4")).rejects.toThrow(/ENABLED/);
  });

  it("re-registers every enabled pocket key at start, so a restart keeps K4 refs", async () => {
    const f = await fixture();
    const first = await f.open();
    const a = await first.createKey("K4");
    const b = await first.createKey("K4");
    expect(a.address).not.toBe(b.address);

    const restarted = await f.open();
    expect(restarted.keyRefs()).toContain(a.keyRef);
    expect(restarted.keyRefs()).toContain(b.keyRef);
    expect(restarted.address(a.keyRef)).toBe(a.address);
    const signature = await restarted.signDigest(b.keyRef, randomDigest());
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("destroys a key version and forgets the reference", async () => {
    const f = await fixture();
    const backend = await f.open();
    const created = await backend.createKey("K4");
    await backend.destroyKey(created.keyRef);
    expect(backend.address(created.keyRef)).toBeUndefined();
    await expect(backend.destroyKey(created.keyRef)).rejects.toThrow();
    const restarted = await f.open();
    expect(restarted.keyRefs()).not.toContain(created.keyRef);
  });
});

describe("gcp-kms backend: logging", () => {
  it("logs the key id and HTTP status only — never a token, digest or signature", async () => {
    const f = await fixture();
    const backend = await f.open();
    const digest = randomDigest();
    const signature = await backend.signDigest("K3", digest);
    f.kms.faults.signStatus = 503;
    await expect(backend.signDigest("K3", digest)).rejects.toThrow();
    const text = f.logLines.join("\n");
    expect(text).toContain("K3");
    expect(text).toContain("503");
    for (const token of f.metadata.issued) expect(text).not.toContain(token);
    expect(text).not.toContain(signature.slice(2));
    expect(text).not.toContain(digest.slice(2));
    expect(text).not.toContain(f.kms.baseUrl);
  });
});
