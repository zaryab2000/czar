// `local-keystore` backend (D70, D78): one encrypted file per key under `signer.keystorePath`, outside any
// git working tree, directory 0700 and files 0600. Keys are decrypted once at unlock and kept in memory.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { execFile } from "node:child_process";
import * as nodeFs from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Hex, TransactionSerializableEIP1559 } from "viem";
import { generatePrivateKey, privateKeyToAccount, sign } from "viem/accounts";
import type { Address, Hash32 } from "@czar/hashing";
import type { SignerBackend } from "./backend.ts";
import type { PassphraseSource } from "./passphrase.ts";

export class KeystoreError extends Error {
  readonly rule: string;
  constructor(rule: string, message: string) {
    super(message);
    this.rule = rule;
    this.name = "KeystoreError";
  }
}

export const KEYSTORE_VERSION = 1;
/** scrypt cost for real keystores: N = 2^17, r = 8, p = 1 (about 128 MiB, under a second). */
export const DEFAULT_KDF = { N: 131072, r: 8, p: 1 } as const;
export type KdfParams = { readonly N: number; readonly r: number; readonly p: number };

/** The on-disk record. Holds ciphertext and the public address only. */
export interface KeystoreFile {
  readonly version: number;
  readonly keyRef: string;
  readonly address: Address;
  readonly kdf: { readonly name: "scrypt"; readonly salt: string } & KdfParams;
  readonly cipher: {
    readonly name: "aes-256-gcm";
    readonly iv: string;
    readonly tag: string;
    readonly ciphertext: string;
  };
}

const KEY_REF =
  /^(K3|K5|K6|K7|K8|K20|K21a|K21b|relayer|K4:0x[0-9a-f]{40}|K10:[a-z0-9]+(?:-[a-z0-9]+)*)$/;

const deriveKey = (passphrase: string, salt: Buffer, kdf: KdfParams) =>
  scryptSync(passphrase.normalize("NFKC"), salt, 32, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: 256 * 1024 * 1024,
  });

const aad = (keyRef: string, address: string) =>
  Buffer.from(`czar-keystore-v1|${keyRef}|${address}`);

export function encryptKey(
  keyRef: string,
  privateKey: Hex,
  passphrase: string,
  kdf: KdfParams = DEFAULT_KDF,
): KeystoreFile {
  if (!KEY_REF.test(keyRef)) throw new KeystoreError("bad-key-ref", `bad key reference ${keyRef}`);
  const address = privateKeyToAccount(privateKey).address.toLowerCase() as Address;
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(passphrase, salt, kdf), iv);
  cipher.setAAD(aad(keyRef, address));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(privateKey.slice(2), "hex")),
    cipher.final(),
  ]);
  return {
    version: KEYSTORE_VERSION,
    keyRef,
    address,
    kdf: { name: "scrypt", salt: salt.toString("hex"), ...kdf },
    cipher: {
      name: "aes-256-gcm",
      iv: iv.toString("hex"),
      tag: cipher.getAuthTag().toString("hex"),
      ciphertext: ciphertext.toString("hex"),
    },
  };
}

export function decryptKey(file: KeystoreFile, passphrase: string): Hex {
  if (
    file.version !== KEYSTORE_VERSION ||
    file.kdf.name !== "scrypt" ||
    file.cipher.name !== "aes-256-gcm"
  )
    throw new KeystoreError("bad-keystore-file", `unsupported keystore file for ${file.keyRef}`);
  const key = deriveKey(passphrase, Buffer.from(file.kdf.salt, "hex"), file.kdf);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(file.cipher.iv, "hex"));
  decipher.setAAD(aad(file.keyRef, file.address));
  decipher.setAuthTag(Buffer.from(file.cipher.tag, "hex"));
  let plain: Buffer;
  try {
    plain = Buffer.concat([
      decipher.update(Buffer.from(file.cipher.ciphertext, "hex")),
      decipher.final(),
    ]);
  } catch {
    throw new KeystoreError("keystore-locked", "keystore passphrase does not open the keystore");
  }
  const privateKey = `0x${plain.toString("hex")}` as Hex;
  plain.fill(0);
  if (privateKeyToAccount(privateKey).address.toLowerCase() !== file.address)
    throw new KeystoreError("bad-keystore-file", `address mismatch for ${file.keyRef}`);
  return privateKey;
}

/** File access the backend needs; the node implementation, or an in-memory one in tests. */
export interface KeystoreFs {
  stat(path: string): Promise<{ mode: number; isDirectory: boolean } | undefined>;
  mkdir(path: string, mode: number): Promise<void>;
  list(path: string): Promise<string[]>;
  read(path: string): Promise<string>;
  /** Creates the file exclusively with the given mode; fails if it exists. */
  create(path: string, data: string, mode: number): Promise<void>;
  remove(path: string): Promise<void>;
}

export const nodeKeystoreFs: KeystoreFs = {
  async stat(path) {
    try {
      const s = await nodeFs.stat(path);
      return { mode: s.mode & 0o777, isDirectory: s.isDirectory() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  },
  mkdir: async (path, mode) => {
    await nodeFs.mkdir(path, { recursive: true, mode });
    await nodeFs.chmod(path, mode);
  },
  list: (path) => nodeFs.readdir(path),
  read: (path) => nodeFs.readFile(path, "utf8"),
  create: (path, data, mode) => nodeFs.writeFile(path, data, { mode, flag: "wx" }),
  remove: (path) => nodeFs.rm(path),
};

/** `git rev-parse --show-toplevel` from a directory: the work tree root, or undefined outside one. */
export type GitProbe = (directory: string) => Promise<string | undefined>;

export const gitProbe: GitProbe = (directory) =>
  new Promise((done, fail) => {
    execFile("git", ["-C", directory, "rev-parse", "--show-toplevel"], (error, stdout) => {
      if (error === null) return done(stdout.trim());
      // Exit status 128 is "not a git repository"; anything else (no git binary) fails closed.
      if ((error as { code?: unknown }).code === 128) return done(undefined);
      fail(new KeystoreError("keystore-git-check", "cannot verify the keystore is outside git"));
    });
  });

export function expandHome(path: string, home = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

/**
 * Refuses a keystore path inside a git working tree or readable by group or others (D78,
 * `signer_keystoreInsideRepo_refusesStart`). Checks the nearest existing ancestor when the path is new.
 */
export async function guardKeystorePath(
  configured: string,
  deps: { fs: KeystoreFs; git: GitProbe; home?: string },
): Promise<string> {
  const path = resolve(expandHome(configured, deps.home));
  if (!isAbsolute(path)) throw new KeystoreError("keystore-path", "keystore path must be absolute");
  let probe = path;
  while ((await deps.fs.stat(probe)) === undefined && dirname(probe) !== probe)
    probe = dirname(probe);
  if ((await deps.git(probe)) !== undefined)
    throw new KeystoreError(
      "keystore-inside-git",
      "refusing to start: the keystore path is inside a git working tree",
    );
  const stat = await deps.fs.stat(path);
  if (stat !== undefined) {
    if (!stat.isDirectory)
      throw new KeystoreError("keystore-path", "keystore path is not a directory");
    if ((stat.mode & 0o077) !== 0)
      throw new KeystoreError(
        "keystore-permissions",
        "refusing to start: keystore directory is group- or world-accessible",
      );
  }
  return path;
}

export interface LocalKeystoreOptions {
  readonly path: string;
  readonly passphrase: PassphraseSource;
  readonly fs?: KeystoreFs;
  readonly git?: GitProbe;
  readonly home?: string;
  readonly kdf?: KdfParams;
}

const fileName = (keyRef: string) => `${keyRef.replace(":", "-")}.json`;

/** Opens (or, with `create`, prepares) the keystore and decrypts every key into memory. */
export async function openLocalKeystore(options: LocalKeystoreOptions): Promise<SignerBackend> {
  const fs = options.fs ?? nodeKeystoreFs;
  const path = await guardKeystorePath(options.path, {
    fs,
    git: options.git ?? gitProbe,
    ...(options.home === undefined ? {} : { home: options.home }),
  });
  const passphrase = await options.passphrase.read();
  if (passphrase.length < 12)
    throw new KeystoreError("keystore-locked", "keystore passphrase is too short");
  const keys = new Map<string, { privateKey: Hex; address: Address }>();

  if ((await fs.stat(path)) === undefined) await fs.mkdir(path, 0o700);
  for (const name of (await fs.list(path)).toSorted()) {
    if (!name.endsWith(".json")) continue;
    const file = JSON.parse(await fs.read(join(path, name))) as KeystoreFile;
    const stat = await fs.stat(join(path, name));
    if (stat !== undefined && (stat.mode & 0o077) !== 0)
      throw new KeystoreError(
        "keystore-permissions",
        `keystore file ${name} is group- or world-accessible`,
      );
    keys.set(file.keyRef, { privateKey: decryptKey(file, passphrase), address: file.address });
  }

  const get = (keyRef: string) => {
    const key = keys.get(keyRef);
    if (key === undefined) throw new KeystoreError("unknown-key", `no key ${keyRef}`);
    return key;
  };

  return {
    name: "local-keystore",
    keyRefs: () => [...keys.keys()].toSorted(),
    address: (keyRef) => keys.get(keyRef)?.address,
    async signDigest(keyRef, digest: Hash32) {
      return sign({ hash: digest, privateKey: get(keyRef).privateKey, to: "hex" });
    },
    async signTransaction(keyRef, tx: TransactionSerializableEIP1559) {
      return privateKeyToAccount(get(keyRef).privateKey).signTransaction(tx);
    },
    async createKey(keyId, merchantService) {
      if (
        keyId === "K10" &&
        (merchantService === undefined || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(merchantService))
      )
        throw new KeystoreError(
          "bad-merchant-service",
          "K10 creation requires a kebab-case service id",
        );
      if (keyId !== "K10" && merchantService !== undefined)
        throw new KeystoreError(
          "unexpected-merchant-service",
          "service scope is only valid for K10",
        );
      const privateKey = generatePrivateKey();
      const address = privateKeyToAccount(privateKey).address.toLowerCase() as Address;
      const keyRef =
        keyId === "K4" ? `K4:${address}` : keyId === "K10" ? `K10:${merchantService}` : keyId;
      if (keys.has(keyRef)) throw new KeystoreError("key-exists", `key ${keyRef} already exists`);
      const file = encryptKey(keyRef, privateKey, passphrase, options.kdf ?? DEFAULT_KDF);
      await fs.create(join(path, fileName(keyRef)), `${JSON.stringify(file, null, 2)}\n`, 0o600);
      keys.set(keyRef, { privateKey, address });
      return { keyRef, address };
    },
    async destroyKey(keyRef) {
      get(keyRef);
      await fs.remove(join(path, fileName(keyRef)));
      keys.delete(keyRef);
    },
  };
}
