// Locations for the daemon: macOS (CZ-02 §3, §4, §5.3) and Linux (CZ-02 §3 Linux row, B6-07, B6-08,
// §4 line 221 for the socket), where every directory follows the XDG base directory default.
import { join } from "node:path";

export const LAUNCH_AGENT_LABEL = "dev.czar.daemon";
export const SYSTEMD_UNIT_NAME = "czar-daemon.service";

/** What every platform has: where memory, logs and the control socket live. */
export interface DaemonPathsCommon {
  readonly supportDir: string;
  readonly socketPath: string;
  readonly databasePath: string;
  readonly logsDir: string;
}

export interface MacosDaemonPaths extends DaemonPathsCommon {
  readonly launchAgentPlist: string;
}

export interface LinuxDaemonPaths extends DaemonPathsCommon {
  /** `$XDG_CONFIG_HOME/systemd/user/czar-daemon.service`, where systemd reads user units. */
  readonly systemdUnit: string;
  /** `WorkingDirectory=` as the unit must contain it: `%h`-relative so the unit survives a move. */
  readonly unitWorkingDirectory: string;
  /** The log directory as the unit must contain it, `%h`-relative for the same reason. */
  readonly unitLogsDir: string;
}

export type DaemonPaths = MacosDaemonPaths | LinuxDaemonPaths;

/** Expands a leading `~/` against `home` (config defaults are written with `~`). */
export function expandHome(path: string, home: string): string {
  return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

/**
 * Rewrites a path under `home` to systemd's `%h` specifier, which systemd expands to the user's
 * home directory (systemd.unit(5)). A path outside the home — an XDG variable pointing elsewhere —
 * stays absolute.
 */
export function homeRelative(path: string, home: string): string {
  if (path === home) return "%h";
  return path.startsWith(`${home}/`) ? `%h/${path.slice(home.length + 1)}` : path;
}

export function macosPaths(home: string, socketPathSetting: string): MacosDaemonPaths {
  const supportDir = join(home, "Library", "Application Support", "Czar");
  return {
    supportDir,
    socketPath: expandHome(socketPathSetting, home),
    databasePath: join(supportDir, "memory.db"),
    logsDir: join(home, "Library", "Logs", "Czar"),
    launchAgentPlist: join(home, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`),
  };
}

/** An unset XDG variable and an empty one mean the same thing: use the default. */
const orDefault = (value: string | undefined, fallback: string): string =>
  value === undefined || value === "" ? fallback : value;

/**
 * Linux locations. Data under `${XDG_DATA_HOME:-~/.local/share}/czar`, logs beneath it, the user
 * unit under `${XDG_CONFIG_HOME:-~/.config}/systemd/user`, and the socket in `$XDG_RUNTIME_DIR`
 * (CZ-02 §4 line 221). With no runtime directory the socket falls back into the 0700 data
 * directory, so it is never world-reachable.
 */
export function linuxPaths(
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): LinuxDaemonPaths {
  const supportDir = join(orDefault(env["XDG_DATA_HOME"], join(home, ".local", "share")), "czar");
  const logsDir = join(supportDir, "logs");
  const configHome = orDefault(env["XDG_CONFIG_HOME"], join(home, ".config"));
  return {
    supportDir,
    socketPath: join(orDefault(env["XDG_RUNTIME_DIR"], supportDir), "czar.sock"),
    databasePath: join(supportDir, "memory.db"),
    logsDir,
    systemdUnit: join(configHome, "systemd", "user", SYSTEMD_UNIT_NAME),
    unitWorkingDirectory: homeRelative(supportDir, home),
    unitLogsDir: homeRelative(logsDir, home),
  };
}
