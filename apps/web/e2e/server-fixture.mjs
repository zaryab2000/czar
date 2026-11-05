import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createApp } from "../../server/src/app.ts";
import { migrate } from "../../server/src/db/migrate.ts";
import { loadConfig } from "../../server/node_modules/@czar/config/src/index.ts";
import { E2E_VAULT_FACTORY } from "./e2e-deployment.mjs";

const serverRequire = createRequire(new URL("../../server/package.json", import.meta.url));
const { Pool } = serverRequire("pg");

const databaseRoot =
  process.env["CZAR_TEST_DATABASE_URL"] ?? "postgres://postgres@127.0.0.1:15432/postgres";
const socialFixture = process.env["CZAR_SOCIAL_E2E_FIXTURE"] === "1";
if (socialFixture) {
  const databaseAddress = new URL(databaseRoot);
  if (
    !["127.0.0.1", "localhost"].includes(databaseAddress.hostname) ||
    databaseAddress.pathname !== "/postgres"
  ) {
    throw new Error("The social E2E fixture requires a local disposable PostgreSQL root.");
  }
}
const rpcUrl = process.env["CZAR_ARC_RPC_URL"] ?? "http://127.0.0.1:8549";
const indexerUrl = process.env["CZAR_INDEXER_URL"] ?? "http://127.0.0.1:42069";
const appConfig = {
  CZAR_APP_CIRCLE_CLIENT_URL: process.env["CZAR_APP_CIRCLE_CLIENT_URL"],
  CZAR_APP_CIRCLE_CLIENT_KEY: process.env["CZAR_APP_CIRCLE_CLIENT_KEY"],
  CZAR_APP_ARC_RPC_URL: process.env["CZAR_APP_ARC_RPC_URL"],
  CZAR_APP_ORIGIN: "http://localhost:3100",
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
if (socialFixture) {
  const userId = `usr_${"1".repeat(26)}`;
  const representativeId = `rep_${"1".repeat(26)}`;
  const threadId = `thr_${"1".repeat(26)}`;
  const postId = `pst_${"1".repeat(26)}`;
  const serviceId = `svc_${"1".repeat(32)}`;
  const token = Buffer.alloc(32, 19).toString("base64url");
  await pool.query("INSERT INTO users(user_id,controlled) VALUES($1,true)", [userId]);
  await pool.query(
    "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
    [createHash("sha256").update(token).digest(), userId],
  );
  await pool.query(
    `INSERT INTO social_representatives(representative_id,user_id,handle,controlled)
     VALUES($1,$2,'Rep-1111',true)`,
    [representativeId, userId],
  );
  await pool.query(
    `INSERT INTO social_threads(thread_id,kind,network,service_id,subject_key,opened_by,contributions)
     VALUES($1,'service','eip155:5042002',$2,$3,$4,1)`,
    [threadId, serviceId, `service:eip155:5042002:${serviceId}`, representativeId],
  );
  const card = {
    cardVersion: "1",
    network: "eip155:5042002",
    supplierKind: "x402",
    serviceId,
    versionId: null,
    taskClass: "web-search",
    capabilityTag: "web-search",
    outputFormat: null,
    deliveryOutcome: "delivered",
    rating: "good",
    callsPaid: 1,
    callsDelivered: 1,
    amountBand: "0.1-1",
    controlled: true,
    observedAt: "2026-11-05T00:00:00Z",
  };
  await pool.query(
    `INSERT INTO social_posts(post_id,thread_id,author_id,kind,card,action_id)
     VALUES($1,$2,$3,'experience',$4,'social-e2e-experience')`,
    [postId, threadId, representativeId, card],
  );
  await pool.query(
    `INSERT INTO social_lessons(lesson_id,user_id,network,service_id,task_class,proposition,
       strength,source_post_id,source_obs_id,expires_at)
     VALUES($1,$2,'eip155:5042002',$3,'web-search','prefer',0.5,$4,
       'social-e2e-observation',now()+interval '1 day')`,
    [`les_${"1".repeat(26)}`, userId, serviceId, postId],
  );
}

const app = createApp({
  pool,
  config: loadConfig({ env: appConfig }),
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  clock: { now: () => new Date() },
  random: { bytes: randomBytes },
  vaultFactory: E2E_VAULT_FACTORY,
  appReadOptions: {
    rpcUrl,
    factoryAddress: E2E_VAULT_FACTORY,
    indexerUrl,
  },
});
let cleanupPromise;
function cleanupDatabase() {
  cleanupPromise ??= (async () => {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.end();
  })();
  return cleanupPromise;
}
const server = createServer(async (incoming, outgoing) => {
  if (incoming.method === "GET" && incoming.url === "/health") {
    outgoing.writeHead(200, { "Content-Type": "application/json" });
    outgoing.end('{"ready":true}');
    return;
  }
  if (socialFixture && incoming.method === "POST" && incoming.url === "/__e2e/dispose") {
    try {
      await cleanupDatabase();
      outgoing.writeHead(204);
      outgoing.end();
      server.close();
    } catch (error) {
      process.stderr.write(`The disposable E2E database could not be removed: ${error}\n`);
      outgoing.writeHead(500);
      outgoing.end();
    }
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
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    server.closeAllConnections();
    try {
      await cleanupDatabase();
      process.exit(0);
    } catch (error) {
      process.stderr.write(`The disposable E2E database could not be removed: ${error}\n`);
      process.exit(1);
    }
  });
}
