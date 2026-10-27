// Machine secrets K14, K15, K16 in the OS keychain through @napi-rs/keyring (CZ-02 §5.4, B6-17).
// Values never go to argv, environment variables, logs or files (B6-19, D78).
import { randomBytes } from "node:crypto";

export const KEYCHAIN_SERVICE = "dev.czar.daemon";

export const KEYCHAIN_ACCOUNTS = {
  /** K14: raw 64-hex SQLCipher key for memory.db. */
  memoryDbKey: "memory-db-key",
  /** K15: device token from pairDevice (T-061). */
  deviceToken: "device-token",
  /** K16: bearer on POST /v1/hooks. */
  hookToken: "hook-token",
} as const;

export type KeychainAccount = (typeof KEYCHAIN_ACCOUNTS)[keyof typeof KEYCHAIN_ACCOUNTS];

/** Thrown when the keychain cannot be reached or refuses access; the daemon then stays Locked. */
export class KeychainUnavailableError extends Error {
  constructor() {
    super("Czar can't reach your system keychain");
    this.name = "KeychainUnavailableError";
  }
}

export interface Keychain {
  get(account: KeychainAccount): string | null;
  set(account: KeychainAccount, value: string): void;
  delete(account: KeychainAccount): void;
}

interface KeyringEntry {
  getPassword(): string | null | undefined;
  setPassword(value: string): void;
  deletePassword(): boolean;
}

const guarded = <T>(run: () => T): T => {
  try {
    return run();
  } catch {
    throw new KeychainUnavailableError();
  }
};

/** The real keychain. `entryFactory` is `(service, account) => new Entry(service, account)` from @napi-rs/keyring. */
export function osKeychain(
  entryFactory: (service: string, account: string) => KeyringEntry,
): Keychain {
  return {
    get: (account) => guarded(() => entryFactory(KEYCHAIN_SERVICE, account).getPassword() ?? null),
    set: (account, value) =>
      guarded(() => entryFactory(KEYCHAIN_SERVICE, account).setPassword(value)),
    delete: (account) => {
      guarded(() => entryFactory(KEYCHAIN_SERVICE, account).deletePassword());
    },
  };
}

const DB_KEY_BYTES = 32;
const HOOK_TOKEN_BYTES = 32;

/** K14: read, or create 32 random bytes on first run (CZ-02 §5.4). */
export function loadOrCreateDbKey(keychain: Keychain): string {
  const existing = keychain.get(KEYCHAIN_ACCOUNTS.memoryDbKey);
  if (existing !== null) return existing;
  const created = randomBytes(DB_KEY_BYTES).toString("hex");
  keychain.set(KEYCHAIN_ACCOUNTS.memoryDbKey, created);
  return created;
}

/** K16: random at install, regenerated on plugin update (CZ-02 §5.4). */
export function rotateHookToken(keychain: Keychain): string {
  const token = randomBytes(HOOK_TOKEN_BYTES).toString("base64url");
  keychain.set(KEYCHAIN_ACCOUNTS.hookToken, token);
  return token;
}
