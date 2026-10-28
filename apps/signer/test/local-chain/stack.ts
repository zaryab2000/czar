// The real stores the signer's Postgres projection reads in production (SCR-146 §3.3 run 2): a throwaway
// Postgres database with the server migrations (CZ-12/CZ-15 tables and `audit`), the real CZ-19 Ponder indexer
// writing its tables into a schema of the same database, and a loopback Gateway API whose freshness the test
// controls (the one outside dependency: up serves the D92 stand-in's chain-backed `/v1/balances`, down is 503).
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { Pool } from "pg";
import { handleStandinRequest } from "../../../../ops/local/circle-standins/server.ts";
import { REPO_ROOT, waitFor } from "#test/local-chain/arc-node";

const ADMIN_DATABASE_URL = "postgres://postgres@127.0.0.1:15432/postgres";
const MIGRATIONS_DIR = `${REPO_ROOT}apps/server/migrations`;
const INDEXER_ROOT = `${REPO_ROOT}apps/indexer`;
const PONDER_BIN = `${INDEXER_ROOT}/node_modules/.bin/ponder`;
const LOCAL_OVERLAY = `${REPO_ROOT}env/local.toml`;
const INDEXER_READY_ATTEMPTS = 1_200;
/** Gateway poll cadence for the run; production keeps `indexer.gatewayPollSeconds` 30. */
const TEST_GATEWAY_POLL_SECONDS = "1";

export type TestDatabase = {
  readonly url: string;
  /** Resolves the indexer schema first, then the server's `public` tables, as the signer's pool would. */
  readonly pool: Pool;
  readonly schema: string;
  drop(): Promise<void>;
};

/** Creates a random database, applies every server migration in order and opens a projection pool. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const admin = new Pool({ connectionString: ADMIN_DATABASE_URL });
  const name = `czar_signer_lc_${randomBytes(6).toString("hex")}`;
  const schema = `indexer_${randomBytes(4).toString("hex")}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(ADMIN_DATABASE_URL);
  url.pathname = `/${name}`;
  const migrator = new Pool({ connectionString: url.toString() });
  try {
    const files = (await readdir(MIGRATIONS_DIR))
      .filter((file) => file.endsWith(".sql"))
      .toSorted();
    for (const file of files)
      await migrator.query(await readFile(`${MIGRATIONS_DIR}/${file}`, "utf8"));
  } finally {
    await migrator.end();
  }
  const pool = new Pool({
    connectionString: url.toString(),
    options: `-c search_path=${schema},public`,
  });
  return {
    url: url.toString(),
    pool,
    schema,
    async drop() {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
    },
  };
}

export type GatewayApi = {
  readonly baseUrl: string;
  setUp(up: boolean): void;
  stop(): Promise<void>;
};

/** A loopback Gateway API: when up, the D92 stand-in handler (balances read from the chain); when down, 503. */
export async function startGatewayApi(options: {
  readonly port: number;
  readonly rpcUrl: string;
}): Promise<GatewayApi> {
  let up = false;
  const rpc = async (method: string, params: readonly unknown[]) => {
    const response = await fetch(options.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await response.json()) as { result?: unknown; error?: unknown };
    if (body.error !== undefined) throw new Error(`RPC ${method} failed`);
    return body.result;
  };
  const server: Server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      void (async () => {
        if (!up) {
          outgoing.writeHead(503).end();
          return;
        }
        const request = new Request(`http://127.0.0.1:${options.port}${incoming.url ?? "/"}`, {
          method: incoming.method ?? "GET",
          headers: { "content-type": "application/json" },
          ...(incoming.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
        });
        const response = await handleStandinRequest(request, rpc);
        outgoing.writeHead(response.status, { "content-type": "application/json" });
        outgoing.end(await response.text());
      })().catch(() => {
        outgoing.writeHead(500).end();
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${options.port}`,
    setUp(value) {
      up = value;
    },
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export type Indexer = {
  logs(): string;
  stop(): Promise<void>;
};

/** Starts the real CZ-19 Ponder indexer (`apps/indexer`) on the node, writing into `database.schema`. */
export async function startIndexer(options: {
  readonly database: TestDatabase;
  readonly rpcUrl: string;
  readonly manifestPath: string;
  readonly gatewayApiBaseUrl: string;
  readonly port: number;
}): Promise<Indexer> {
  let logs = "";
  const environment: NodeJS.ProcessEnv = { ...process.env };
  delete environment["CZAR_INDEXER_DISABLE_EXTERNAL_POLL"];
  delete environment["CZAR_INDEXER_START_BLOCK"];
  const child: ChildProcess = spawn(
    PONDER_BIN,
    [
      "--root",
      INDEXER_ROOT,
      "start",
      "--port",
      String(options.port),
      "--schema",
      options.database.schema,
    ],
    {
      env: {
        ...environment,
        DATABASE_URL: options.database.url,
        CZAR_INDEXER_RPC_URL: options.rpcUrl,
        CZAR_INDEXER_DEPLOYMENT_PATH: options.manifestPath,
        CZAR_LOCAL_CONFIG: LOCAL_OVERLAY,
        CZAR_CHAIN_GATEWAY_API_BASE_URL: options.gatewayApiBaseUrl,
        CZAR_INDEXER_GATEWAY_POLL_SECONDS: TEST_GATEWAY_POLL_SECONDS,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (chunk: Buffer) => {
    logs += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    logs += chunk.toString();
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  await waitFor("Ponder indexer", INDEXER_READY_ATTEMPTS, async () => {
    if (child.exitCode !== null) throw new Error(`Ponder exited ${child.exitCode}\n${logs}`);
    try {
      const response = await fetch(`http://127.0.0.1:${options.port}/ready`, {
        signal: AbortSignal.timeout(1_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  });
  return {
    logs: () => logs,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await exited;
    },
  };
}
