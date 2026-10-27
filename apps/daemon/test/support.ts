// Test doubles for the OS: an in-memory keychain and a scripted launchctl (no real launchd is touched).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeychainUnavailableError, type Keychain, type KeychainAccount } from "@czar/daemon";
import type { CommandRunner } from "@czar/daemon/launchd";

export function memoryKeychain(): Keychain & { readonly items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    get: (account: KeychainAccount) => items.get(account) ?? null,
    set: (account: KeychainAccount, value: string) => void items.set(account, value),
    delete: (account: KeychainAccount) => void items.delete(account),
  };
}

const deny = () => {
  throw new KeychainUnavailableError();
};

export function deniedKeychain(): Keychain {
  return { get: deny, set: deny, delete: deny };
}

/** Records every launchctl call and models whether dev.czar.daemon is loaded. */
export function fakeLaunchctl() {
  const calls: string[][] = [];
  let loaded = false;
  const run: CommandRunner = async (program, args) => {
    calls.push([program, ...args]);
    const [verb] = args;
    if (verb === "bootstrap") loaded = true;
    if (verb === "bootout") loaded = false;
    if (verb === "print") return { code: loaded ? 0 : 113, stdout: "" };
    if (verb === "kickstart" && !loaded) return { code: 113, stdout: "" };
    return { code: 0, stdout: "" };
  };
  return { run, calls, isLoaded: () => loaded };
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
