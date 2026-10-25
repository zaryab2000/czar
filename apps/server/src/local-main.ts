import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import {
  loadConfig,
  loadConfigFile,
  parameterEnvironment,
  validateLocalOnlyConfig,
} from "@czar/config";
import { createLogger } from "@czar/logging";
import { Pool } from "pg";
import { createLocalApp } from "#src/local-app";
import { migrate } from "#src/db/migrate";

const localConfigPath = process.env["CZAR_LOCAL_CONFIG"];
const config =
  localConfigPath === undefined
    ? loadConfig({ env: parameterEnvironment(process.env) })
    : await loadConfigFile(localConfigPath, { env: parameterEnvironment(process.env) });
const rpcUrl =
  process.env["CZAR_ARC_RPC_URL"] ?? `http://127.0.0.1:${config.get("signer.local.rpcPort")}`;
await validateLocalOnlyConfig({
  config,
  overlayPath: localConfigPath ?? "",
  arcRpcUrl: rpcUrl,
});
const objectStorePath = resolve(
  process.env["CZAR_LOCAL_OBJECT_STORE_PATH"] ??
    join(homedir(), "Library/Application Support/Czar/objects"),
);
await mkdir(objectStorePath, { recursive: true, mode: 0o700 });
const pool = new Pool({
  connectionString:
    process.env["CZAR_DATABASE_URL"] ?? "postgres://postgres@127.0.0.1:15433/postgres",
});
await migrate(pool);
const app = createLocalApp({
  pool,
  config,
  logger: createLogger({ service: "server", component: "CZ-15" }),
  clock: { now: () => new Date() },
  random: { bytes: (size) => randomBytes(size) },
  rpcUrl,
  objectStorePath,
});

const server = createServer(async (incoming, outgoing) => {
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
      else if (value !== undefined) headers.set(name, value);
    }
    const method = incoming.method ?? "GET";
    const body = method === "GET" || method === "HEAD" ? undefined : Readable.toWeb(incoming);
    const response = await app.fetch(
      new Request(`http://localhost${incoming.url ?? "/"}`, {
        method,
        headers,
        ...(body === undefined ? {} : ({ body, duplex: "half" } as RequestInit)),
      }),
    );
    outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.writeHead(503, { "content-type": "application/json" });
    outgoing.end('{"status":"unavailable"}');
  }
});

server.listen(Number(process.env["CZAR_SERVER_PORT"] ?? "3000"), "localhost");
const stop = () => server.close(() => void pool.end());
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
