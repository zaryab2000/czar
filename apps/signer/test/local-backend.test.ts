// Local keystore (D70, D78). Keys are generated in memory per run; the only real directories touched are
// an empty temp directory (permission checks) and the repository itself (inside-git refusal).
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  getAddress,
  keccak256,
  parseTransaction,
  recoverAddress,
  recoverTransactionAddress,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  decryptKey,
  encryptKey,
  expandHome,
  gitProbe,
  guardKeystorePath,
  nodeKeystoreFs,
  openLocalKeystore,
} from "../src/index.ts";
import { FAST_KDF, memoryFs, testPassphrase } from "./helpers.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const temps: string[] = [];
afterAll(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

describe("keystore file format", () => {
  it("round-trips a key and stores only ciphertext and the address", () => {
    const key = generatePrivateKey();
    const file = encryptKey("K3", key, "correct horse battery", FAST_KDF);
    expect(JSON.stringify(file)).not.toContain(key.slice(2));
    expect(file.address).toBe(privateKeyToAccount(key).address.toLowerCase());
    expect(decryptKey(file, "correct horse battery")).toBe(key);
  });

  it("refuses a wrong passphrase and a file whose key reference was swapped", () => {
    const file = encryptKey("K3", generatePrivateKey(), "correct horse battery", FAST_KDF);
    expect(() => decryptKey(file, "wrong horse battery")).toThrow(/does not open/);
    expect(() => decryptKey({ ...file, keyRef: "K7" }, "correct horse battery")).toThrow(
      /does not open/,
    );
  });
});

describe("keystore location (D78)", () => {
  it("signer_keystoreInsideRepo_refusesStart", async () => {
    await expect(
      openLocalKeystore({
        path: join(REPO_ROOT, "apps/signer/.keystore-test"),
        passphrase: testPassphrase(),
        kdf: FAST_KDF,
      }),
    ).rejects.toMatchObject({ rule: "keystore-inside-git" });
  });

  it("accepts a 0700 directory outside any git tree and refuses a group-readable one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "czar-signer-guard-"));
    temps.push(dir);
    if ((await gitProbe(dir)) !== undefined) return; // the temp dir sits inside a work tree on this host
    await chmod(dir, 0o700);
    await expect(guardKeystorePath(dir, { fs: nodeKeystoreFs, git: gitProbe })).resolves.toBe(dir);
    await chmod(dir, 0o750);
    await expect(
      guardKeystorePath(dir, { fs: nodeKeystoreFs, git: gitProbe }),
    ).rejects.toMatchObject({ rule: "keystore-permissions" });
  });

  it("expands ~ against the home directory", () => {
    expect(expandHome("~/Library/Application Support/Czar/signer/keystore/", "/Users/z")).toBe(
      "/Users/z/Library/Application Support/Czar/signer/keystore/",
    );
  });

  it("refuses a keystore file readable by others", async () => {
    const fs = memoryFs();
    const pass = testPassphrase();
    const store = await openLocalKeystore({
      path: "/ks",
      passphrase: pass,
      fs,
      git: async () => undefined,
      kdf: FAST_KDF,
    });
    await store.createKey("K8");
    const entry = fs.files.get("/ks/K8.json");
    if (entry !== undefined) entry.mode = 0o644;
    await expect(
      openLocalKeystore({
        path: "/ks",
        passphrase: pass,
        fs,
        git: async () => undefined,
        kdf: FAST_KDF,
      }),
    ).rejects.toMatchObject({
      rule: "keystore-permissions",
    });
  });
});

describe("local-keystore backend", () => {
  it("creates a distinct scoped K10 key for each merchant service", async () => {
    const fs = memoryFs();
    const store = await openLocalKeystore({
      path: "/ks",
      passphrase: testPassphrase(),
      fs,
      git: async () => undefined,
      kdf: FAST_KDF,
    });
    const search = await store.createKey("K10", "czar-search");
    const research = await store.createKey("K10", "czar-research");

    expect(search.keyRef).toBe("K10:czar-search");
    expect(research.keyRef).toBe("K10:czar-research");
    expect(search.address).not.toBe(research.address);
    expect(fs.files.get("/ks/K10-czar-search.json")?.mode).toBe(0o600);
    await expect(store.createKey("K10")).rejects.toMatchObject({ rule: "bad-merchant-service" });
  });

  it("creates keys 0600, reopens them, and signs a known digest that recovers to the key's address", async () => {
    const fs = memoryFs();
    const pass = testPassphrase();
    const store = await openLocalKeystore({
      path: "/ks",
      passphrase: pass,
      fs,
      git: async () => undefined,
      kdf: FAST_KDF,
    });
    const { address } = await store.createKey("K3");
    expect(fs.files.get("/ks/K3.json")?.mode).toBe(0o600);
    await expect(store.createKey("K3")).rejects.toMatchObject({ rule: "key-exists" });

    const reopened = await openLocalKeystore({
      path: "/ks",
      passphrase: pass,
      fs,
      git: async () => undefined,
      kdf: FAST_KDF,
    });
    expect(reopened.keyRefs()).toEqual(["K3"]);
    const digest = keccak256(toHex("czar signer known digest"));
    const signature = await reopened.signDigest("K3", digest);
    expect((signature.length - 2) / 2).toBe(65);
    expect(await recoverAddress({ hash: digest, signature })).toBe(getAddress(address));
    const v = Number.parseInt(signature.slice(-2), 16);
    expect([27, 28]).toContain(v);
    // low s: s ≤ n/2
    const s = BigInt(`0x${signature.slice(66, 130)}`);
    expect(s <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n).toBe(true);
  });

  it("signs transactions as the key and keeps pocket keys per address", async () => {
    const store = await openLocalKeystore({
      path: "/ks",
      passphrase: testPassphrase(),
      fs: memoryFs(),
      git: async () => undefined,
      kdf: FAST_KDF,
    });
    const { keyRef, address } = await store.createKey("K4");
    expect(keyRef).toBe(`K4:${address}`);
    const signed = await store.signTransaction(keyRef, {
      type: "eip1559",
      chainId: 5042002,
      nonce: 0,
      gas: 21_000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      to: address,
      value: 1n,
    });
    expect(await recoverTransactionAddress({ serializedTransaction: signed as never })).toBe(
      getAddress(address),
    );
    expect(parseTransaction(signed).chainId).toBe(5042002);
    await store.destroyKey(keyRef);
    expect(store.address(keyRef)).toBeUndefined();
  });

  it("refuses to open with a wrong passphrase", async () => {
    const fs = memoryFs();
    const store = await openLocalKeystore({
      path: "/ks",
      passphrase: testPassphrase(),
      fs,
      git: async () => undefined,
      kdf: FAST_KDF,
    });
    await store.createKey("K5");
    await expect(
      openLocalKeystore({
        path: "/ks",
        passphrase: testPassphrase(),
        fs,
        git: async () => undefined,
        kdf: FAST_KDF,
      }),
    ).rejects.toMatchObject({
      rule: "keystore-locked",
    });
  });
});
