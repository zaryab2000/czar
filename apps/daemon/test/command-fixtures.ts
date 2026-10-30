import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@czar/config";
import { KEYCHAIN_ACCOUNTS, type Keychain, type KeychainAccount } from "#src/keychain";

/** A 43-character device token in the K15 format; test-only. */
export const TEST_DEVICE_TOKEN = "T".repeat(43);

export function memoryKeychain(token: string = TEST_DEVICE_TOKEN): Keychain {
  const values = new Map<KeychainAccount, string>([[KEYCHAIN_ACCOUNTS.deviceToken, token]]);
  return {
    get: (account) => values.get(account) ?? null,
    set: (account, value) => void values.set(account, value),
    delete: (account) => void values.delete(account),
  };
}

/** Shared dependencies for objective and result command tests (no network, temp project dir). */
export function baseCommandDeps() {
  return {
    keychain: memoryKeychain(),
    config: loadConfig({ envFile: {} }),
    serverOrigin: new URL("http://127.0.0.1:3000"),
    cwd: mkdtempSync(join(tmpdir(), "czar-project-")),
  };
}
