// Linux user service (CZ-02 §3 Linux row; B6-07, B6-08): the CLI writes
// ~/.config/systemd/user/czar-daemon.service and drives it with `systemctl --user` — never the
// system manager, never root — plus `loginctl enable-linger` so the daemon survives logout.
// The macOS login agent is the sibling module launchd.ts and is untouched by this one.
import type { CommandRunner } from "./launchd.ts";
import { SYSTEMD_UNIT_NAME } from "./paths.ts";

/** Crash loops are throttled to one respawn per 10 s (B6-02), the ceiling the plist also states. */
export const RESTART_INTERVAL_SECONDS = 10;

export interface UserUnitInput {
  readonly programArguments: readonly string[];
  /** `WorkingDirectory=`, written as the unit should contain it (`%h`-relative under the home). */
  readonly workingDirectory: string;
  /** The log directory, written the same way; the two log files sit directly inside it. */
  readonly logsDir: string;
}

const SYSTEMCTL = "/usr/bin/systemctl";
const LOGINCTL = "/usr/bin/loginctl";

/**
 * systemd reads a command line with C-style quoting and treats `%` as a specifier, so a literal
 * one is `%%` (systemd.service(5), systemd.unit(5)). The path directives are not escaped: they
 * carry the `%h` specifier on purpose.
 */
const quote = (value: string) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;

/**
 * The user unit for `czard`: `Restart=on-failure` with the same 10 s throttle as the plist, the two
 * log files the plist writes, `%h` paths, and no `User=` or `Group=` — a user unit runs as the
 * person who installed it and never as root.
 */
export function renderUserUnit(input: UserUnitInput): string {
  return [
    "[Unit]",
    "Description=Czar daemon (CZ-02)",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${input.programArguments.map(quote).join(" ")}`,
    `WorkingDirectory=${input.workingDirectory}`,
    "Restart=on-failure",
    `RestartSec=${RESTART_INTERVAL_SECONDS}`,
    `StandardOutput=append:${input.logsDir}/daemon.out.log`,
    `StandardError=append:${input.logsDir}/daemon.err.log`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** `systemctl --user` for czar-daemon.service, behind an injectable runner like `Launchctl`. */
export class Systemctl {
  readonly #run: CommandRunner;

  constructor(run: CommandRunner) {
    this.#run = run;
  }

  get unitName(): string {
    return SYSTEMD_UNIT_NAME;
  }

  async daemonReload(): Promise<void> {
    await this.#checked(["daemon-reload"]);
  }

  async enableNow(): Promise<void> {
    await this.#checked(["enable", "--now", SYSTEMD_UNIT_NAME]);
  }

  async restart(): Promise<void> {
    await this.#checked(["restart", SYSTEMD_UNIT_NAME]);
  }

  async disableNow(): Promise<void> {
    await this.#checked(["disable", "--now", SYSTEMD_UNIT_NAME]);
  }

  /**
   * `systemctl --user is-active` exits 0 only while the unit is running. It is the one query verb
   * this module has, so `czar status` reads "installed" from it.
   */
  async isLoaded(): Promise<boolean> {
    return (await this.#run(SYSTEMCTL, ["--user", "is-active", SYSTEMD_UNIT_NAME])).code === 0;
  }

  async #checked(args: readonly string[]): Promise<void> {
    const result = await this.#run(SYSTEMCTL, ["--user", ...args]);
    if (result.code !== 0)
      throw new Error(`systemctl ${args[0]} failed with exit code ${result.code}`);
  }
}

/**
 * `loginctl enable-linger <user>` (CZ-02 B6-07): without it the user manager stops at logout and
 * takes the daemon with it. A host can refuse it, which is not fatal to an install.
 */
export class Loginctl {
  readonly #run: CommandRunner;
  readonly #user: string;

  constructor(run: CommandRunner, user: string) {
    this.#run = run;
    this.#user = user;
  }

  /** True when lingering is on, false when the host refused it. */
  async enableLinger(): Promise<boolean> {
    return (await this.#run(LOGINCTL, ["enable-linger", this.#user])).code === 0;
  }
}
