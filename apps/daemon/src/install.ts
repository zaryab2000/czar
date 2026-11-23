// `czar install | update | uninstall` on macOS (CZ-02 §3; D67) and on Linux (CZ-02 §3 Linux row,
// B6-07, B6-08). Uses the injected file system, launchctl, systemctl, loginctl and keychain so
// every step is testable without touching the machine. Dispatch is by platform: the macOS steps,
// the plist and the keychain calls are exactly what they were before Linux was added.
import {
  KEYCHAIN_ACCOUNTS,
  KeychainUnavailableError,
  rotateHookToken,
  type Keychain,
  type KeychainAccount,
} from "./keychain.ts";
import { Launchctl, renderLaunchAgentPlist } from "./launchd.ts";
import { Loginctl, Systemctl, renderUserUnit } from "./systemd.ts";
import type {
  DaemonPaths,
  DaemonPathsCommon,
  LinuxDaemonPaths,
  MacosDaemonPaths,
} from "./paths.ts";

export class UnsupportedPlatformError extends Error {
  constructor(platform: string) {
    super(`the Czar daemon runs on macOS and Linux; this machine is ${platform}`);
    this.name = "UnsupportedPlatformError";
  }
}

/**
 * Linux keeps K14, K15 and K16 in the Secret Service, so a headless machine without GNOME Keyring
 * or KWallet cannot be installed. Nothing is written and no key is ever put in a file instead
 * (B6-17, B6-19, D78); the daemon stays Locked exactly as it does when macOS denies the keychain.
 */
export class KeyringServiceMissingError extends Error {
  constructor() {
    super("Czar needs a keyring service (GNOME Keyring or KWallet) on Linux");
    this.name = "KeyringServiceMissingError";
  }
}

export interface InstallFs {
  mkdir(path: string, mode: number): void;
  writeFile(path: string, contents: string, mode: number): void;
  removeFile(path: string): void;
  removeDir(path: string): void;
  exists(path: string): boolean;
}

export interface InstallDeps {
  readonly platform: NodeJS.Platform;
  readonly paths: DaemonPaths;
  readonly launchctl: Launchctl;
  readonly systemctl: Systemctl;
  readonly loginctl: Loginctl;
  readonly keychain: Keychain;
  readonly fs: InstallFs;
  /** `[node, cliPath, "daemon"]`: what launchd or systemd runs. */
  readonly programArguments: readonly string[];
  /** One plain line to the person running the CLI. Never a log sink, never a secret. */
  readonly print: (line: string) => void;
}

const DIR_MODE = 0o700;
const PLIST_MODE = 0o644;
const LAUNCH_AGENTS_DIR_MODE = 0o755;
const UNIT_MODE = 0o644;
const SYSTEMD_USER_DIR_MODE = 0o755;

const NOT_INSTALLED = "Czar is not installed";

/** Said once, after the install has otherwise succeeded (CZ-02 B6-07). */
export const LINGER_REFUSED_LINE =
  "Czar is installed, but it will stop when you log out: enabling user lingering was refused.";

const parentDir = (path: string) => path.slice(0, path.lastIndexOf("/"));

function macosPathsOf(paths: DaemonPaths): MacosDaemonPaths {
  if (!("launchAgentPlist" in paths)) throw new Error("macOS needs the macOS paths");
  return paths;
}

function linuxPathsOf(paths: DaemonPaths): LinuxDaemonPaths {
  if (!("systemdUnit" in paths)) throw new Error("Linux needs the Linux paths");
  return paths;
}

/** Writes the plist, creates the hook token (K16) and bootstraps the agent into gui/$UID. */
async function installMacos(deps: InstallDeps, paths: MacosDaemonPaths): Promise<void> {
  const { fs } = deps;
  fs.mkdir(paths.supportDir, DIR_MODE);
  fs.mkdir(paths.logsDir, DIR_MODE);
  fs.mkdir(
    paths.launchAgentPlist.slice(0, paths.launchAgentPlist.lastIndexOf("/")),
    LAUNCH_AGENTS_DIR_MODE,
  );
  if (deps.keychain.get(KEYCHAIN_ACCOUNTS.hookToken) === null) rotateHookToken(deps.keychain);
  fs.writeFile(
    paths.launchAgentPlist,
    renderLaunchAgentPlist({
      programArguments: deps.programArguments,
      workingDirectory: paths.supportDir,
      logsDir: paths.logsDir,
    }),
    PLIST_MODE,
  );
  if (await deps.launchctl.isLoaded()) await deps.launchctl.bootout();
  await deps.launchctl.bootstrap(paths.launchAgentPlist);
}

/**
 * The keyring is read before anything is written, so a machine without a Secret Service is left
 * exactly as it was.
 */
function ensureHookToken(keychain: Keychain): void {
  try {
    if (keychain.get(KEYCHAIN_ACCOUNTS.hookToken) === null) rotateHookToken(keychain);
  } catch (error) {
    if (error instanceof KeychainUnavailableError) throw new KeyringServiceMissingError();
    throw error;
  }
}

/**
 * Writes the user unit, creates the hook token (K16), enables it in the user manager and asks for
 * lingering. The step order mirrors macOS: a running unit is stopped before the new one is enabled.
 */
async function installLinux(deps: InstallDeps, paths: LinuxDaemonPaths): Promise<void> {
  const { fs } = deps;
  ensureHookToken(deps.keychain);
  fs.mkdir(paths.supportDir, DIR_MODE);
  fs.mkdir(paths.logsDir, DIR_MODE);
  fs.mkdir(parentDir(paths.systemdUnit), SYSTEMD_USER_DIR_MODE);
  fs.writeFile(
    paths.systemdUnit,
    renderUserUnit({
      programArguments: deps.programArguments,
      workingDirectory: paths.unitWorkingDirectory,
      logsDir: paths.unitLogsDir,
    }),
    UNIT_MODE,
  );
  if (await deps.systemctl.isLoaded()) await deps.systemctl.disableNow();
  await deps.systemctl.daemonReload();
  await deps.systemctl.enableNow();
  if (!(await deps.loginctl.enableLinger())) deps.print(LINGER_REFUSED_LINE);
}

export async function install(deps: InstallDeps): Promise<void> {
  switch (deps.platform) {
    case "darwin":
      return installMacos(deps, macosPathsOf(deps.paths));
    case "linux":
      return installLinux(deps, linuxPathsOf(deps.paths));
    default:
      throw new UnsupportedPlatformError(deps.platform);
  }
}

/** After the binary is replaced: restart the running service (`kickstart -k`, or `restart`). */
export async function update(deps: InstallDeps): Promise<void> {
  switch (deps.platform) {
    case "darwin": {
      if (!(await deps.launchctl.isLoaded())) throw new Error(NOT_INSTALLED);
      await deps.launchctl.kickstart();
      return;
    }
    case "linux": {
      if (!(await deps.systemctl.isLoaded())) throw new Error(NOT_INSTALLED);
      await deps.systemctl.restart();
      return;
    }
    default:
      throw new UnsupportedPlatformError(deps.platform);
  }
}

export interface UninstallOptions {
  /**
   * Delete the Czar data directory (memory and soul) and the memory key K14 with it.
   * Off unless the person chooses it.
   */
  readonly deleteMemory: boolean;
}

/**
 * The keychain items an uninstall always removes: the device token K15 and the hook token K16.
 * Both are re-made on the next install and pairing. The memory key K14 is not here: it is the only
 * way to open kept memory, so it goes only with the memory itself (PM-037).
 */
const UNINSTALL_KEYCHAIN_ACCOUNTS: readonly KeychainAccount[] = [
  KEYCHAIN_ACCOUNTS.deviceToken,
  KEYCHAIN_ACCOUNTS.hookToken,
];

/**
 * PM-037's rule, one code path for every platform: K15 and K16 always go, and the memory folder and
 * its key K14 go together and only on request, so memory kept through an uninstall still opens
 * after a reinstall.
 */
function forgetSecrets(
  deps: InstallDeps,
  paths: DaemonPathsCommon,
  options: UninstallOptions,
): void {
  for (const account of UNINSTALL_KEYCHAIN_ACCOUNTS) deps.keychain.delete(account);
  if (options.deleteMemory) {
    deps.keychain.delete(KEYCHAIN_ACCOUNTS.memoryDbKey);
    if (deps.fs.exists(paths.supportDir)) deps.fs.removeDir(paths.supportDir);
  }
}

/** `bootout`, remove the plist, then the keychain items PM-037 allows. */
async function uninstallMacos(
  deps: InstallDeps,
  paths: MacosDaemonPaths,
  options: UninstallOptions,
): Promise<void> {
  if (await deps.launchctl.isLoaded()) await deps.launchctl.bootout();
  if (deps.fs.exists(paths.launchAgentPlist)) deps.fs.removeFile(paths.launchAgentPlist);
  forgetSecrets(deps, paths, options);
}

/** `disable --now`, remove the unit, reload so systemd forgets it, then the same keychain rule. */
async function uninstallLinux(
  deps: InstallDeps,
  paths: LinuxDaemonPaths,
  options: UninstallOptions,
): Promise<void> {
  if (await deps.systemctl.isLoaded()) await deps.systemctl.disableNow();
  if (deps.fs.exists(paths.systemdUnit)) deps.fs.removeFile(paths.systemdUnit);
  await deps.systemctl.daemonReload();
  forgetSecrets(deps, paths, options);
}

export async function uninstall(deps: InstallDeps, options: UninstallOptions): Promise<void> {
  switch (deps.platform) {
    case "darwin":
      return uninstallMacos(deps, macosPathsOf(deps.paths), options);
    case "linux":
      return uninstallLinux(deps, linuxPathsOf(deps.paths), options);
    default:
      throw new UnsupportedPlatformError(deps.platform);
  }
}
