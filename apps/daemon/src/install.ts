// `czar install | update | uninstall` on macOS (CZ-02 §3; D67). Uses the injected file system,
// launchctl and keychain so every step is testable without touching the machine.
import { KEYCHAIN_ACCOUNTS, rotateHookToken, type Keychain } from "./keychain.ts";
import { Launchctl, renderLaunchAgentPlist } from "./launchd.ts";
import type { DaemonPaths } from "./paths.ts";

export class UnsupportedPlatformError extends Error {
  constructor(platform: string) {
    super(`the Czar daemon runs on macOS only in Phase 1 (D67); this machine is ${platform}`);
    this.name = "UnsupportedPlatformError";
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
  readonly keychain: Keychain;
  readonly fs: InstallFs;
  /** `[node, cliPath, "daemon"]`: what launchd runs. */
  readonly programArguments: readonly string[];
}

const DIR_MODE = 0o700;
const PLIST_MODE = 0o644;
const LAUNCH_AGENTS_DIR_MODE = 0o755;

function requireMacos(platform: NodeJS.Platform) {
  if (platform !== "darwin") throw new UnsupportedPlatformError(platform);
}

/** Writes the plist, creates the hook token (K16) and bootstraps the agent into gui/$UID. */
export async function install(deps: InstallDeps): Promise<void> {
  requireMacos(deps.platform);
  const { fs, paths } = deps;
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

/** After the binary is replaced: restart the running agent (`kickstart -k`). */
export async function update(deps: InstallDeps): Promise<void> {
  requireMacos(deps.platform);
  if (!(await deps.launchctl.isLoaded())) throw new Error("Czar is not installed");
  await deps.launchctl.kickstart();
}

export interface UninstallOptions {
  /** Delete ~/Library/Application Support/Czar (memory and soul). Off unless the person chooses it. */
  readonly deleteMemory: boolean;
}

/** `bootout`, remove the plist and the keychain items; the memory folder only on request. */
export async function uninstall(deps: InstallDeps, options: UninstallOptions): Promise<void> {
  requireMacos(deps.platform);
  if (await deps.launchctl.isLoaded()) await deps.launchctl.bootout();
  if (deps.fs.exists(deps.paths.launchAgentPlist)) deps.fs.removeFile(deps.paths.launchAgentPlist);
  for (const account of Object.values(KEYCHAIN_ACCOUNTS)) deps.keychain.delete(account);
  if (options.deleteMemory && deps.fs.exists(deps.paths.supportDir))
    deps.fs.removeDir(deps.paths.supportDir);
}
