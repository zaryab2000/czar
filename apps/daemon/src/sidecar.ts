// Supervises the `czar-redact` helper (CZ-26 §3, §10, §13; CZ-02 §10): started lazily on the first
// layer-2 call, restarted with backoff at most `RESTARTS_PER_MINUTE` times a minute, stopped after
// `redaction.sidecarIdleS` without calls. The helper has no network and no keys; its socket is 0600.
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

/** CZ-02 §10: "restart with backoff, max 5/min". */
export const RESTARTS_PER_MINUTE = 5;
const MINUTE_MS = 60_000;
const READY_POLL_MS = 50;
const RESTART_BACKOFF_BASE_MS = 500;

export type Spawner = (command: string, args: readonly string[]) => ChildProcess;

export interface SidecarOptions {
  /** Bundled launcher, e.g. `<bundle>/bin/czar-redact` (T-064 installer bundling). */
  readonly command: string;
  readonly args?: readonly string[];
  readonly socketPath: string;
  readonly spawn: Spawner;
  readonly idleMs: number;
  readonly startTimeoutMs: number;
  readonly now?: () => number;
}

export class SidecarUnavailableError extends Error {
  constructor(reason: string) {
    super(`redaction service unavailable: ${reason}`);
    this.name = "SidecarUnavailableError";
  }
}

export class SidecarSupervisor {
  #child: ChildProcess | null = null;
  #starting: Promise<void> | null = null;
  #idleTimer: NodeJS.Timeout | null = null;
  #restarts: number[] = [];
  readonly #options: SidecarOptions;
  readonly #now: () => number;

  constructor(options: SidecarOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  get running(): boolean {
    return this.#child !== null && this.#child.exitCode === null;
  }

  get restartsInLastMinute(): number {
    const cutoff = this.#now() - MINUTE_MS;
    this.#restarts = this.#restarts.filter((at) => at > cutoff);
    return this.#restarts.length;
  }

  /** The layer-2 client calls this before every request. */
  async ensureRunning(): Promise<void> {
    this.#touch();
    if (this.running) return;
    this.#starting ??= this.#start().finally(() => {
      this.#starting = null;
    });
    await this.#starting;
  }

  async stop(): Promise<void> {
    if (this.#idleTimer !== null) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
    const child = this.#child;
    this.#child = null;
    if (child !== null && child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
      if (child.kill("SIGTERM")) await exited;
    }
  }

  async #start(): Promise<void> {
    const hadChild = this.#child !== null;
    if (hadChild) {
      if (this.restartsInLastMinute >= RESTARTS_PER_MINUTE)
        throw new SidecarUnavailableError("restart limit");
      const backoff = RESTART_BACKOFF_BASE_MS * 2 ** this.restartsInLastMinute;
      this.#restarts.push(this.#now());
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
    const child = this.#options.spawn(this.#options.command, [
      ...(this.#options.args ?? []),
      "--socket",
      this.#options.socketPath,
    ]);
    let startError = false;
    child.once("error", () => {
      startError = true;
      if (this.#child === child) this.#child = null;
    });
    this.#child = child;
    const deadline = this.#now() + this.#options.startTimeoutMs;
    while (!existsSync(this.#options.socketPath)) {
      if (startError || child.exitCode !== null) {
        throw new SidecarUnavailableError("exited during start");
      }
      if (this.#now() > deadline) {
        child.kill("SIGKILL");
        throw new SidecarUnavailableError("start timeout");
      }
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
  }

  #touch(): void {
    if (this.#idleTimer !== null) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => void this.stop(), this.#options.idleMs);
    this.#idleTimer.unref();
  }
}
