// macOS locations for the daemon (CZ-02 §3, §4, §5.3; D67: macOS only in Phase 1).
import { join } from "node:path";

export const LAUNCH_AGENT_LABEL = "dev.czar.daemon";

export interface DaemonPaths {
  readonly supportDir: string;
  readonly socketPath: string;
  readonly databasePath: string;
  readonly logsDir: string;
  readonly launchAgentPlist: string;
}

/** Expands a leading `~/` against `home` (config defaults are written with `~`). */
export function expandHome(path: string, home: string): string {
  return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

export function macosPaths(home: string, socketPathSetting: string): DaemonPaths {
  const supportDir = join(home, "Library", "Application Support", "Czar");
  return {
    supportDir,
    socketPath: expandHome(socketPathSetting, home),
    databasePath: join(supportDir, "memory.db"),
    logsDir: join(home, "Library", "Logs", "Czar"),
    launchAgentPlist: join(home, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`),
  };
}
