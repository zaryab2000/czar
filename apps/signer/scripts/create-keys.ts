#!/usr/bin/env node
// T-105: create the Phase 1 server keys in the local keystore (CZ-27 §3, D78, D80) and record their
// addresses in deployments/arc-testnet-keys.json. Prints addresses only.
//
//   node apps/signer/scripts/create-keys.ts --dry-run   # checks everything, keeps keys in memory only
//   node apps/signer/scripts/create-keys.ts             # creates the keystore files and the addresses file
//
// The passphrase is read from the macOS keychain item `signer.keychainService` by this process; it is
// never accepted on the command line, from the environment or from a file.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hasSecretLikeName, loadConfig } from "@czar/config";
import {
  assertNoSecretInProcess,
  gitProbe,
  guardKeystorePath,
  keychainPassphrase,
  nodeKeystoreFs,
  openLocalKeystore,
  type KeyId,
} from "../src/index.ts";

/** The seven Phase 1 keys (T-105; K9 is Phase 2, K4 per plan, K10 by the merchants task). */
export const PHASE1_KEYS: readonly { keyId: KeyId; role: string }[] = [
  { keyId: "K3", role: "agentSigner" },
  { keyId: "K5", role: "autonomySigner" },
  { keyId: "K6", role: "guardian" },
  { keyId: "K7", role: "evaluator" },
  { keyId: "K8", role: "evidencePublisher" },
  { keyId: "relayer", role: "relayerGas" },
  { keyId: "K20", role: "factoryAdmin" },
];

export interface KeysFile {
  readonly network: "arc-testnet";
  readonly chainId: 5042002;
  readonly backend: "local-keystore";
  readonly createdAt: string;
  readonly addresses: Readonly<Record<string, { readonly role: string; readonly address: string }>>;
}

const FORBIDDEN_FIELDS = ["key", "secret", "private", "mnemonic", "passphrase", "seed"];

/** `deployments/arc-testnet-keys.json` rules: seven distinct checksummed addresses, no secret-named field. */
export function validateKeysFile(value: unknown): string[] {
  const problems: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (typeof node !== "object" || node === null) return;
    for (const [name, child] of Object.entries(node)) {
      const lower = name.toLowerCase();
      if (FORBIDDEN_FIELDS.includes(lower) || hasSecretLikeName(name))
        problems.push(`forbidden field ${path}${name}`);
      walk(child, `${path}${name}.`);
    }
  };
  walk(value, "");
  const file = value as Partial<KeysFile>;
  if (file.network !== "arc-testnet" || file.chainId !== 5042002) problems.push("wrong network");
  const entries = Object.entries(file.addresses ?? {});
  const expected = PHASE1_KEYS.map((k) => k.keyId).toSorted();
  if (JSON.stringify(entries.map(([id]) => id).toSorted()) !== JSON.stringify(expected))
    problems.push("addresses must hold exactly K3, K5, K6, K7, K8, relayer, K20");
  const seen = new Set<string>();
  for (const [id, entry] of entries) {
    if (!isAddress(entry.address, { strict: true }) || entry.address !== getAddress(entry.address))
      problems.push(`${id} address is not checksummed`);
    if (seen.has(entry.address.toLowerCase())) problems.push(`${id} address repeats`);
    seen.add(entry.address.toLowerCase());
  }
  return problems;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const KEYS_FILE = resolve(REPO_ROOT, "deployments/arc-testnet-keys.json");

export async function createKeys(options: {
  dryRun: boolean;
  argv?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  out?: (line: string) => void;
}): Promise<KeysFile> {
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const env = options.env ?? process.env;
  assertNoSecretInProcess(options.argv ?? process.argv, env);
  const config = loadConfig({ env });
  if (config.get("signer.backend") !== "local-keystore")
    throw new Error("signer.backend must be local-keystore for T-105");
  const keystorePath = String(config.get("signer.keystorePath"));
  const addresses: Record<string, { role: string; address: string }> = {};

  if (options.dryRun) {
    // Same guards as a real run; keys exist only in this process and are dropped on exit.
    await guardKeystorePath(keystorePath, { fs: nodeKeystoreFs, git: gitProbe });
    for (const { keyId, role } of PHASE1_KEYS) {
      addresses[keyId] = { role, address: privateKeyToAccount(generatePrivateKey()).address };
    }
  } else {
    if (existsSync(KEYS_FILE))
      throw new Error(`${KEYS_FILE} already exists; refusing to create a second key set`);
    const backend = await openLocalKeystore({
      path: keystorePath,
      passphrase: keychainPassphrase(String(config.get("signer.keychainService"))),
    });
    const existing = PHASE1_KEYS.filter(({ keyId }) => backend.address(keyId) !== undefined);
    if (existing.length > 0)
      throw new Error(
        `keystore already holds ${existing.map((k) => k.keyId).join(", ")}; refusing to overwrite`,
      );
    for (const { keyId, role } of PHASE1_KEYS) {
      addresses[keyId] = { role, address: getAddress((await backend.createKey(keyId)).address) };
    }
  }

  const file: KeysFile = {
    network: "arc-testnet",
    chainId: 5042002,
    backend: "local-keystore",
    createdAt: new Date().toISOString(),
    addresses,
  };
  const problems = validateKeysFile(file);
  if (problems.length > 0) throw new Error(`keys file invalid: ${problems.join("; ")}`);
  if (!options.dryRun) {
    mkdirSync(dirname(KEYS_FILE), { recursive: true });
    writeFileSync(KEYS_FILE, `${JSON.stringify(file, null, 2)}\n`, { flag: "wx" });
  }
  out(options.dryRun ? "DRY RUN: throwaway addresses, nothing written" : `wrote ${KEYS_FILE}`);
  for (const { keyId, role } of PHASE1_KEYS)
    out(`${keyId.padEnd(8)}${role.padEnd(20)}${addresses[keyId]?.address}`);
  return file;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== "--dry-run");
  if (unknown.length > 0) {
    process.stderr.write("usage: create-keys.ts [--dry-run]\n");
    process.exit(2);
  }
  createKeys({ dryRun: args.includes("--dry-run") }).catch((error: unknown) => {
    process.stderr.write(`create-keys: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
