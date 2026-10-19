// Control socket (CZ-02 §4): Unix domain socket, mode 0600, JSON-RPC 2.0 over newline-delimited frames.
// Only same-user processes can connect. Methods are registered by the components that own them.
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

export const SOCKET_MODE = 0o600;
const DIR_MODE = 0o700;
const MAX_FRAME_BYTES = 1_048_576;

export type MethodHandler = (params: unknown) => unknown;

export interface ControlSocket {
  readonly path: string;
  close(): Promise<void>;
}

const METHOD_NOT_FOUND = -32601;
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const INTERNAL_ERROR = -32603;

function answer(raw: string, methods: ReadonlyMap<string, MethodHandler>): unknown {
  let request: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  try {
    request = JSON.parse(raw) as typeof request;
  } catch {
    return { jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "parse error" } };
  }
  const id = request.id ?? null;
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return { jsonrpc: "2.0", id, error: { code: INVALID_REQUEST, message: "invalid request" } };
  }
  const handler = methods.get(request.method);
  if (handler === undefined)
    return { jsonrpc: "2.0", id, error: { code: METHOD_NOT_FOUND, message: "method not found" } };
  try {
    return { jsonrpc: "2.0", id, result: handler(request.params) };
  } catch {
    return { jsonrpc: "2.0", id, error: { code: INTERNAL_ERROR, message: "internal error" } };
  }
}

export async function startControlSocket(
  path: string,
  methods: ReadonlyMap<string, MethodHandler>,
): Promise<ControlSocket> {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  if (existsSync(path)) {
    if (!lstatSync(path).isSocket())
      throw new Error("control socket path exists and is not a socket");
    unlinkSync(path);
  }

  const server: Server = createServer((socket: Socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_FRAME_BYTES) {
        socket.destroy();
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const frame = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (frame.trim() !== "") socket.write(`${JSON.stringify(answer(frame, methods))}\n`);
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("error", () => socket.destroy());
  });

  // Create the socket with no group/other bits, then set 0600 explicitly (no window with a wider mode).
  const previousUmask = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } finally {
    process.umask(previousUmask);
  }
  chmodSync(path, SOCKET_MODE);

  return {
    path,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (existsSync(path)) unlinkSync(path);
          if (error) reject(error);
          else resolve();
        }),
      ),
  };
}
