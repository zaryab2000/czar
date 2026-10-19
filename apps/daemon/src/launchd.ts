// macOS login agent (CZ-02 §3; B6-01 to B6-03): the CLI writes ~/Library/LaunchAgents/dev.czar.daemon.plist
// and uses `launchctl bootstrap` (never `load`), `kickstart -k` for updates and `bootout` to remove it.
// Registering from Czar.app with SMAppService (B6-04 to B6-06) is the app's job and is not in this module.
import { LAUNCH_AGENT_LABEL } from "./paths.ts";

/** launchd throttles respawns to one per 10 s (B6-02); set explicitly so the plist states it. */
export const THROTTLE_INTERVAL_SECONDS = 10;

export interface PlistInput {
  readonly programArguments: readonly string[];
  readonly workingDirectory: string;
  readonly logsDir: string;
}

const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const string = (value: string) => `<string>${escapeXml(value)}</string>`;

/** Keys from CZ-02 §3: Label, ProgramArguments, KeepAlive, ProcessType, log paths, WorkingDirectory; no RunAtLoad. */
export function renderLaunchAgentPlist(input: PlistInput): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key>${string(LAUNCH_AGENT_LABEL)}`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...input.programArguments.map((argument) => `    ${string(argument)}`),
    "  </array>",
    "  <key>KeepAlive</key><true/>",
    `  <key>ProcessType</key>${string("Background")}`,
    `  <key>ThrottleInterval</key><integer>${THROTTLE_INTERVAL_SECONDS}</integer>`,
    `  <key>StandardOutPath</key>${string(`${input.logsDir}/daemon.out.log`)}`,
    `  <key>StandardErrorPath</key>${string(`${input.logsDir}/daemon.err.log`)}`,
    `  <key>WorkingDirectory</key>${string(input.workingDirectory)}`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
}

/** Runs a program with arguments (no shell). Injected so tests never touch the real launchd. */
export type CommandRunner = (program: string, args: readonly string[]) => Promise<CommandResult>;

const LAUNCHCTL = "/bin/launchctl";

export class Launchctl {
  readonly #run: CommandRunner;
  readonly #domain: string;

  constructor(run: CommandRunner, uid: number) {
    this.#run = run;
    this.#domain = `gui/${uid}`;
  }

  get serviceTarget(): string {
    return `${this.#domain}/${LAUNCH_AGENT_LABEL}`;
  }

  async bootstrap(plistPath: string): Promise<void> {
    await this.#checked(["bootstrap", this.#domain, plistPath]);
  }

  async bootout(): Promise<void> {
    await this.#checked(["bootout", this.serviceTarget]);
  }

  async kickstart(): Promise<void> {
    await this.#checked(["kickstart", "-k", this.serviceTarget]);
  }

  /** `launchctl print` exits 0 only when the service is loaded in the user's GUI domain. */
  async isLoaded(): Promise<boolean> {
    return (await this.#run(LAUNCHCTL, ["print", this.serviceTarget])).code === 0;
  }

  async #checked(args: readonly string[]): Promise<void> {
    const result = await this.#run(LAUNCHCTL, args);
    if (result.code !== 0)
      throw new Error(`launchctl ${args[0]} failed with exit code ${result.code}`);
  }
}
