// Test doubles for the OS: an in-memory keychain, a scripted launchctl and a scripted
// systemctl/loginctl (no real launchd, systemd or keyring is touched).
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KeychainUnavailableError,
  linuxPaths,
  Launchctl,
  Loginctl,
  Systemctl,
  type InstallDeps,
  type InstallFs,
  type Keychain,
  type KeychainAccount,
  type LinuxDaemonPaths,
} from "@czar/daemon";
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

/**
 * Records every `systemctl --user` and `loginctl` call and models whether czar-daemon.service is
 * active. `linger: false` makes `loginctl enable-linger` fail the way a locked-down host does.
 */
export function fakeSystemctl(options: { readonly linger?: boolean } = {}) {
  const calls: string[][] = [];
  let active = false;
  const run: CommandRunner = async (program, args) => {
    calls.push([program, ...args]);
    const verb = args[0] === "--user" ? args[1] : args[0];
    if (verb === "enable") active = true;
    if (verb === "disable") active = false;
    if (verb === "is-active")
      return { code: active ? 0 : 3, stdout: active ? "active" : "inactive" };
    if (verb === "restart" && !active) return { code: 1, stdout: "" };
    if (verb === "enable-linger" && options.linger === false) return { code: 1, stdout: "" };
    return { code: 0, stdout: "" };
  };
  return { run, calls, isActive: () => active };
}

/** The real file system, as `czar install` uses it (the CLI passes the same functions). */
export function nodeInstallFs(): InstallFs {
  return {
    mkdir: (path: string, mode: number) => mkdirSync(path, { recursive: true, mode }),
    writeFile: (path: string, contents: string, mode: number) =>
      writeFileSync(path, contents, { mode }),
    removeFile: (path: string) => rmSync(path, { force: true }),
    removeDir: (path: string) => rmSync(path, { recursive: true, force: true }),
    exists: existsSync,
  };
}

export const LINUX_PROGRAM_ARGUMENTS = ["/usr/local/bin/node", "/opt/czar/cli.ts", "daemon"];

/** A Linux `InstallDeps` with every OS call scripted: XDG paths under a temp home. */
export function linuxInstallDeps(
  options: { readonly linger?: boolean; readonly keychain?: Keychain } = {},
) {
  const home = tempDir("czar-home-");
  const runtimeDir = tempDir("czar-run-");
  const paths: LinuxDaemonPaths = linuxPaths(home, { XDG_RUNTIME_DIR: runtimeDir });
  const systemd = fakeSystemctl(options.linger === undefined ? {} : { linger: options.linger });
  const launchd = fakeLaunchctl();
  // Cast as daemon.test.ts does: a denied keychain stands in for the in-memory one.
  const keychain = (options.keychain ?? memoryKeychain()) as ReturnType<typeof memoryKeychain>;
  const lines: string[] = [];
  const deps: InstallDeps = {
    platform: "linux",
    paths,
    launchctl: new Launchctl(launchd.run, 501),
    systemctl: new Systemctl(systemd.run),
    loginctl: new Loginctl(systemd.run, "czaruser"),
    keychain,
    fs: nodeInstallFs(),
    programArguments: LINUX_PROGRAM_ARGUMENTS,
    print: (line: string) => void lines.push(line),
  };
  return { home, runtimeDir, paths, systemd, launchd, keychain, lines, deps };
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
