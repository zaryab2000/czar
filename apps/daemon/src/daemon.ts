// Daemon lifecycle (CZ-02 §5.1): Starting → Unlocked (K14 read) → Observing (hook server and socket up),
// or Locked when the keychain refuses; Paused; Stopping closes the servers and the database.
import { createLogger, type Logger } from "@czar/logging";
import type { Config } from "@czar/config";
import { DatabaseLockedError, openMemoryDatabase, type MemoryDatabase } from "./database.ts";
import { startControlSocket, type ControlSocket, type MethodHandler } from "./control-socket.ts";
import { startHookServer, type HookServer, type IntakeState } from "./hook-server.ts";
import { KEYCHAIN_ACCOUNTS, loadOrCreateDbKey, type Keychain } from "./keychain.ts";
import type { DaemonPaths } from "./paths.ts";

export type DaemonState = "starting" | "locked" | "observing" | "paused" | "stopping" | "stopped";

export interface DaemonDeps {
  readonly config: Config;
  readonly paths: DaemonPaths;
  readonly keychain: Keychain;
  readonly logger?: Logger;
}

export interface StatusSnapshot {
  readonly state: DaemonState;
  readonly paired: boolean;
  readonly hookPort: number | null;
  readonly eventsReceived: number;
  readonly eventsDiscarded: number;
}

export class Daemon {
  #state: DaemonState = "starting";
  #db: MemoryDatabase | null = null;
  #hooks: HookServer | null = null;
  #socket: ControlSocket | null = null;
  #received = 0;
  #discarded = 0;
  readonly #deps: DaemonDeps;
  readonly #log: Logger;
  readonly #methods = new Map<string, MethodHandler>();

  constructor(deps: DaemonDeps) {
    this.#deps = deps;
    this.#log = deps.logger ?? createLogger({ service: "czard", component: "CZ-02" });
    this.#methods.set("status.get", () => this.status());
  }

  get state(): DaemonState {
    return this.#state;
  }

  /** The open database; only available while unlocked. */
  get database(): MemoryDatabase | null {
    return this.#db;
  }

  status(): StatusSnapshot {
    let paired = false;
    try {
      paired = this.#deps.keychain.get(KEYCHAIN_ACCOUNTS.deviceToken) !== null;
    } catch {
      paired = false;
    }
    return {
      state: this.#state,
      paired,
      hookPort: this.#hooks?.port ?? null,
      eventsReceived: this.#received,
      eventsDiscarded: this.#discarded,
    };
  }

  async start(): Promise<void> {
    this.#unlock();
    const { config, paths, keychain } = this.#deps;
    this.#hooks = await startHookServer({
      port: config.get("daemon.hookPort") as number,
      maxBodyBytes: config.get("daemon.maxHookBodyBytes") as number,
      hookToken: () => {
        try {
          return keychain.get(KEYCHAIN_ACCOUNTS.hookToken);
        } catch {
          return null;
        }
      },
      state: () => this.#intakeState(),
      onEvent: () => {
        this.#received += 1;
      },
      onDiscard: () => {
        this.#discarded += 1;
      },
    });
    this.#socket = await startControlSocket(paths.socketPath, this.#methods);
    this.#log.info("daemon_started", { state: this.#state });
  }

  /** Retries the keychain read (the app's "Unlock Czar" button, CZ-02 §6). */
  unlock(): DaemonState {
    if (this.#state === "locked") this.#unlock();
    return this.#state;
  }

  pause(paused: boolean): void {
    if (this.#state === "observing" && paused) this.#state = "paused";
    else if (this.#state === "paused" && !paused) this.#state = "observing";
  }

  async stop(): Promise<void> {
    if (this.#state === "stopped") return;
    this.#state = "stopping";
    await this.#hooks?.close();
    await this.#socket?.close();
    this.#hooks = null;
    this.#socket = null;
    this.#db?.close();
    this.#db = null;
    this.#state = "stopped";
  }

  #intakeState(): IntakeState {
    return this.#state === "observing"
      ? "observing"
      : this.#state === "paused"
        ? "paused"
        : "locked";
  }

  #unlock(): void {
    try {
      const key = loadOrCreateDbKey(this.#deps.keychain);
      this.#db = openMemoryDatabase(this.#deps.paths.databasePath, key);
      this.#state = "observing";
    } catch (error) {
      this.#state = "locked";
      this.#log.warn("daemon_locked", {
        kind: error instanceof DatabaseLockedError ? "database" : "keychain",
      });
    }
  }
}
