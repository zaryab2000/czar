// Loopback hook intake `POST /v1/hooks` (CZ-02 §4, §5.2, §9): binds 127.0.0.1 only, requires the K16
// bearer, refuses any browser `Origin` (absent or `null` only) and any non-loopback `Host`, caps the body.
// The mapping and redaction pipeline behind it is T-063; this server hands accepted bodies to `onEvent`.
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const HOOK_PATH = "/v1/hooks";

export type IntakeState = "locked" | "observing" | "paused";

export interface HookServerOptions {
  readonly port: number;
  readonly maxBodyBytes: number;
  readonly hookToken: () => string | null;
  readonly state: () => IntakeState;
  /** Called with the raw body of an accepted hook; must return quickly (ingest ack ≤ daemon.ingestAckMs). */
  readonly onEvent: (body: Buffer) => void;
  /** Called when paused intake discards an event, so the daemon can count it (CZ-02 §5.1). */
  readonly onDiscard?: () => void;
}

export interface HookServer {
  readonly port: number;
  close(): Promise<void>;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function hostIsLoopback(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(host.toLowerCase());
  if (match === null) return false;
  const [, name, hostPort] = match;
  return LOOPBACK_HOSTS.has(name ?? "") && (hostPort === undefined || Number(hostPort) === port);
}

function bearerMatches(header: string | undefined, token: string | null): boolean {
  if (token === null || header === undefined || !header.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function reply(res: ServerResponse, status: number, body?: unknown) {
  res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

export async function startHookServer(options: HookServerOptions): Promise<HookServer> {
  let boundPort = options.port;
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST" || req.url !== HOOK_PATH) return reply(res, 404);
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== "null") return reply(res, 401);
    if (!hostIsLoopback(req.headers.host, boundPort)) return reply(res, 401);
    // Locked: K16 cannot be read yet; observers keep their events queued (CZ-02 §5.1).
    if (options.state() === "locked") return reply(res, 503, { status: "locked" });
    if (!bearerMatches(req.headers.authorization, options.hookToken())) return reply(res, 401);
    if (Number(req.headers["content-length"] ?? "0") > options.maxBodyBytes) return reply(res, 413);

    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > options.maxBodyBytes && !rejected) {
        rejected = true;
        reply(res, 413);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (rejected) return;
      if (options.state() === "paused") {
        options.onDiscard?.();
        return reply(res, 202);
      }
      options.onEvent(Buffer.concat(chunks));
      reply(res, 202);
    });
  };

  const server: Server = createServer(handle);
  const listen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  try {
    await listen(options.port);
  } catch (error) {
    // Port in use: take a free port (CZ-02 §10); T-062 writes it to the plugin data config.
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    await listen(0);
  }
  boundPort = (server.address() as AddressInfo).port;
  return {
    port: boundPort,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
