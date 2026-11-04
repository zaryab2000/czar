// `czar status` (CZ-02 §12): installed state from the OS service manager plus the running daemon's
// state over the socket.
import { connect } from "node:net";
import type { StatusSnapshot } from "./daemon.ts";

/**
 * What `czar status` needs from the OS service manager: `Launchctl` on macOS (`launchctl print`),
 * `Systemctl` on Linux (`systemctl --user is-active`).
 */
export interface ServiceManager {
  isLoaded(): Promise<boolean>;
}

/** Wording from CZ-02 §12. The not-installed and not-running lines are not in the spec table (see task notes). */
export const STATUS_TEXT = {
  notInstalled: "Czar is not installed.",
  notRunning: "Czar is installed but not running.",
  installedNotPaired: "Czar is installed. Pair this computer from the Czar app to start.",
  observing: (tools: number) => `Observing ${tools} tools`,
  paused: "Observation paused. Nothing is being recorded.",
  locked: "Czar is locked. Unlock to resume observing.",
} as const;

export interface CliStatus {
  readonly installed: boolean;
  readonly daemon: StatusSnapshot | null;
  readonly text: string;
}

const SOCKET_TIMEOUT_MS = 2000;

/** One JSON-RPC call over the control socket. */
export function callSocket(path: string, method: string, params?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("control socket timeout"));
    }, SOCKET_TIMEOUT_MS);
    socket.setEncoding("utf8");
    socket.on("connect", () =>
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`),
    );
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      socket.end();
      const response = JSON.parse(buffer.slice(0, newline)) as {
        result?: unknown;
        error?: { message: string };
      };
      if (response.error !== undefined) reject(new Error(response.error.message));
      else resolve(response.result);
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function describe(installed: boolean, daemon: StatusSnapshot | null): string {
  if (!installed) return STATUS_TEXT.notInstalled;
  if (daemon === null) return STATUS_TEXT.notRunning;
  if (daemon.state === "locked") return STATUS_TEXT.locked;
  if (daemon.state === "paused") return STATUS_TEXT.paused;
  if (!daemon.paired) return STATUS_TEXT.installedNotPaired;
  return STATUS_TEXT.observing(0);
}

export async function readStatus(service: ServiceManager, socketPath: string): Promise<CliStatus> {
  const installed = await service.isLoaded();
  let daemon: StatusSnapshot | null = null;
  if (installed) {
    try {
      daemon = (await callSocket(socketPath, "status.get")) as StatusSnapshot;
    } catch {
      daemon = null;
    }
  }
  return { installed, daemon, text: describe(installed, daemon) };
}
