// The node:http adapter the cloud entry serves through (PM-059). A copy of the private adapter in
// `local-main.ts`, which this task may not edit (SCR-170 §3, §7): same request mapping, same logging,
// same 503 on an adapter failure. Kept in its own module so `local-main.ts` stays untouched.
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import type { Logger } from "@czar/logging";
import type { ServerMain } from "#src/main";

export function createServerHttpAdapter(root: ServerMain, logger: Logger): Server {
  return createServer(async (incoming, outgoing) => {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
        else if (value !== undefined) headers.set(name, value);
      }
      const method = incoming.method ?? "GET";
      const body = method === "GET" || method === "HEAD" ? undefined : Readable.toWeb(incoming);
      const response = await root.app.request(
        new Request(`http://localhost${incoming.url ?? "/"}`, {
          method,
          headers,
          ...(body === undefined ? {} : ({ body: body as never, duplex: "half" } as RequestInit)),
        }),
        undefined,
        { remoteAddr: incoming.socket.remoteAddress },
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      logger.error("server_http_adapter_failure", { rule: "http-adapter", state: "error" });
      outgoing.writeHead(503, { "content-type": "application/json" });
      outgoing.end('{"status":"unavailable"}');
    }
  });
}

export function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close((error) => (error ? reject(error) : resolveClose()));
    server.closeIdleConnections();
  });
}
