import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createApp } from "../../server/src/app.ts";
import { migrate } from "../../server/src/db/migrate.ts";
import { loadConfig } from "../../server/node_modules/@czar/config/src/index.ts";

const serverRequire = createRequire(new URL("../../server/package.json", import.meta.url));
const { Pool } = serverRequire("pg");

const databaseRoot =
  process.env["CZAR_TEST_DATABASE_URL"] ?? "postgres://postgres@127.0.0.1:15432/postgres";
const rpcUrl = process.env["CZAR_ARC_RPC_URL"] ?? "http://127.0.0.1:8549";
const indexerUrl = process.env["CZAR_INDEXER_URL"] ?? "http://127.0.0.1:42069";
const appConfig = {
  CZAR_APP_CIRCLE_CLIENT_URL: process.env["CZAR_APP_CIRCLE_CLIENT_URL"],
  CZAR_APP_CIRCLE_CLIENT_KEY: process.env["CZAR_APP_CIRCLE_CLIENT_KEY"],
  CZAR_APP_ARC_RPC_URL: process.env["CZAR_APP_ARC_RPC_URL"],
};
const port = Number(process.env["CZAR_TEST_SERVER_PORT"] ?? 4310);
for (const name of Object.keys(process.env)) {
  if (name.startsWith("CZAR_")) delete process.env[name];
}
const databaseName = `czar_e2e_${randomBytes(8).toString("hex")}`;
const admin = new Pool({ connectionString: databaseRoot });
await admin.query(`CREATE DATABASE "${databaseName}"`);
const databaseUrl = new URL(databaseRoot);
databaseUrl.pathname = `/${databaseName}`;
const pool = new Pool({ connectionString: databaseUrl.toString() });
await migrate(pool);

const app = createApp({
  pool,
  config: loadConfig({ env: appConfig }),
  appOrigin: "http://localhost:3100",
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  clock: { now: () => new Date() },
  random: { bytes: randomBytes },
  appReadOptions: {
    rpcUrl,
    factoryAddress: "0xA624047E961D13bF49711e1383e7A3EBD3E25ef4",
    indexerUrl,
  },
});
const server = createServer(async (incoming, outgoing) => {
  if (incoming.method === "GET" && incoming.url === "/health") {
    outgoing.writeHead(200, { "Content-Type": "application/json" });
    outgoing.end('{"ready":true}');
    return;
  }
  try {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (typeof value === "string") headers.set(name, value);
    }
    const method = incoming.method ?? "GET";
    const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
    const request = new Request(`http://127.0.0.1:${port}${incoming.url ?? "/"}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body, duplex: "half" }),
    });
    const response = await app.fetch(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.writeHead(500, { "Content-Type": "application/problem+json" });
    outgoing.end('{"title":"Internal Server Error","status":500}');
  }
});

server.listen(port, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(async () => {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end();
      process.exit(0);
    });
  });
}
