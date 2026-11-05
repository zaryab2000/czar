// PM-052: the nightly database backup and the restore drill (SCR-170 §5).
// Run with: node --test --experimental-strip-types ops/cloud/test/backup.test.ts
//
// The acceptance test is a local restore drill: migrate a fresh database, insert rows, dump it
// with pg-backup.sh, restore that object with pg-restore-drill.sh into a second fresh database,
// and check the row counts are equal.
//
// Nothing here talks to Google. A fake metadata server and a fake Cloud Storage run on loopback,
// and the two base URLs are overridden for the test only (the script refuses any other storage
// host). Postgres is the shared local Postgres 16 on 127.0.0.1:15432. Every database this file
// creates carries the prefix `pm052_` and is dropped afterwards. The fixture values below are
// invented strings, not credentials.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const cloudRoot = new URL("../", import.meta.url);
const backupDir = fileURLToPath(new URL("backup/", cloudRoot));
const backupScript = join(backupDir, "pg-backup.sh");
const drillScript = join(backupDir, "pg-restore-drill.sh");
const libScript = join(backupDir, "lib.sh");

const PG_HOST = "127.0.0.1";
const PG_PORT = "15432";
const PG_ADMIN = "postgres";
const BUCKET = "czar-alpha-backups-test";
const FAKE_TOKEN = "fake-access-token-for-the-test-only";
const FIXTURE_PASSWORD = String.raw`fixture:pass\word`; // has both characters .pgpass must escape
const today = new Date().toISOString().slice(0, 10);

// ---- Postgres helpers -------------------------------------------------------------------

function psql(database: string, sql: string): string {
  const run = spawnSync(
    "psql",
    [
      "-X",
      "-A",
      "-t",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-h",
      PG_HOST,
      "-p",
      PG_PORT,
      "-U",
      PG_ADMIN,
      "-d",
      database,
      "-c",
      sql,
    ],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, `psql failed: ${run.stderr}`);
  return run.stdout.trim();
}

const suffix = randomBytes(4).toString("hex");
const sourceDb = `pm052_src_${suffix}`;
const drillPrefix = `pm052_drill_${suffix}_`;
const drillDb = `${drillPrefix}${today.replaceAll("-", "_")}`;

function leftoverDrillDatabases(): string[] {
  const names = psql(
    "postgres",
    `SELECT datname FROM pg_database WHERE datname LIKE '${drillPrefix}%'`,
  );
  return names === "" ? [] : names.split("\n");
}

function userId(n: number): string {
  return `usr_${String(n).padStart(26, "0")}`;
}

/** Migrates a fresh database with the server's own migrator, then inserts fixture rows. */
async function createSourceDatabase(): Promise<void> {
  psql("postgres", `CREATE DATABASE "${sourceDb}"`);
  const serverRequire = createRequire(
    new URL("../../../apps/server/package.json", import.meta.url),
  );
  const { Pool } = serverRequire("pg") as typeof import("pg");
  const { migrate } = (await import(
    new URL("../../../apps/server/src/db/migrate.ts", import.meta.url).href
  )) as typeof import("../../../apps/server/src/db/migrate.ts");
  const pool = new Pool({
    host: PG_HOST,
    port: Number(PG_PORT),
    user: PG_ADMIN,
    database: sourceDb,
  });
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
  const users = [1, 2, 3].map((n) => `('${userId(n)}')`).join(", ");
  psql(sourceDb, `INSERT INTO users (user_id) VALUES ${users}`);
  psql(
    sourceDb,
    `INSERT INTO devices (device_id, user_id, device_name, platform, token_hash) VALUES
       ('dev_${"0".repeat(25)}1', '${userId(1)}', 'one', 'linux', decode(repeat('aa', 32), 'hex')),
       ('dev_${"0".repeat(25)}2', '${userId(2)}', 'two', 'macos', decode(repeat('bb', 32), 'hex'))`,
  );
  psql(
    sourceDb,
    `INSERT INTO model_usage (user_id, month_start, prompt, input_tokens, output_tokens) VALUES
       ('${userId(1)}', '2026-11-01', 'P-01', 10, 20),
       ('${userId(2)}', '2026-11-01', 'P-01', 30, 40)`,
  );
}

// ---- fakes ------------------------------------------------------------------------------

type Stored = { body: Buffer; contentType: string };
type Fake = {
  metadataOrigin: string;
  storageOrigin: string;
  objects: Map<string, Stored>;
  requests: {
    service: "metadata" | "storage";
    method: string;
    url: string;
    authorization: string;
  }[];
  /** `ok`, a status code, or `no-size` (200 with an object resource that omits `size`). */
  uploadMode: "ok" | "no-size" | number;
  /** `ok` or `no-token` (200 with a body that has no `access_token`). */
  tokenMode: "ok" | "no-token";
};

const servers: Server[] = [];
after(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function fakes(): Promise<Fake> {
  const fake: Fake = {
    metadataOrigin: "",
    storageOrigin: "",
    objects: new Map(),
    requests: [],
    uploadMode: "ok",
    tokenMode: "ok",
  };

  const metadata = createServer((request, response) => {
    fake.requests.push({
      service: "metadata",
      method: request.method ?? "",
      url: request.url ?? "",
      authorization: String(request.headers["metadata-flavor"] ?? ""),
    });
    if (request.headers["metadata-flavor"] !== "Google") {
      response.writeHead(403).end("missing Metadata-Flavor");
      return;
    }
    const body =
      fake.tokenMode === "no-token"
        ? { expires_in: 3599, token_type: "Bearer" }
        : { access_token: FAKE_TOKEN, expires_in: 3599, token_type: "Bearer" };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });

  const storage = createServer((request, response) => {
    const url = new URL(request.url ?? "", "http://127.0.0.1");
    const authorization = String(request.headers.authorization ?? "");
    fake.requests.push({
      service: "storage",
      method: request.method ?? "",
      url: request.url ?? "",
      authorization,
    });
    if (authorization !== `Bearer ${FAKE_TOKEN}`) {
      response.writeHead(401).end("bad token");
      return;
    }

    const upload = /^\/upload\/storage\/v1\/b\/([^/]+)\/o$/.exec(url.pathname);
    if (request.method === "POST" && upload !== null) {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (typeof fake.uploadMode === "number") {
          response.writeHead(fake.uploadMode).end("fault");
          return;
        }
        const name = url.searchParams.get("name") ?? "";
        const body = Buffer.concat(chunks);
        const resource: Record<string, unknown> = {
          name,
          bucket: upload[1],
          size: String(body.length),
        };
        if (fake.uploadMode === "no-size") delete resource.size;
        else
          fake.objects.set(name, {
            body,
            contentType: String(request.headers["content-type"] ?? ""),
          });
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(resource));
      });
      return;
    }

    const download = /^\/storage\/v1\/b\/([^/]+)\/o\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && download !== null && url.searchParams.get("alt") === "media") {
      const stored = fake.objects.get(decodeURIComponent(download[2] ?? ""));
      if (stored === undefined) {
        response
          .writeHead(404, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { code: 404 } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/octet-stream" }).end(stored.body);
      return;
    }
    response.writeHead(400).end("bad path");
  });

  fake.metadataOrigin = await listen(metadata);
  fake.storageOrigin = await listen(storage);
  return fake;
}

// ---- running the scripts ----------------------------------------------------------------

type Run = { status: number; stdout: string; stderr: string };

let fixtureRoot = "";
let shimDir = "";
let shimRecord = "";
let passwordRoot = "";
let workRoot = "";

function baseEnv(fake: Fake): Record<string, string> {
  return {
    PATH: `${shimDir}:${process.env.PATH ?? ""}`,
    HOME: process.env.HOME ?? "/",
    CZAR_BACKUP_BUCKET: BUCKET,
    CZAR_BACKUP_WORK_ROOT: workRoot,
    CZAR_CREDENTIAL_FILES_DIR: passwordRoot,
    CZAR_METADATA_TOKEN_URL: `${fake.metadataOrigin}/computeMetadata/v1/instance/service-accounts/default/token`,
    CZAR_STORAGE_BASE_URL: fake.storageOrigin,
    CZAR_BACKUP_PGHOST: PG_HOST,
    CZAR_BACKUP_PGPORT: PG_PORT,
    CZAR_BACKUP_PGUSER: PG_ADMIN,
    CZAR_BACKUP_PGDATABASE: sourceDb,
    CZAR_DRILL_PGHOST: PG_HOST,
    CZAR_DRILL_PGPORT: PG_PORT,
    CZAR_DRILL_PGUSER: PG_ADMIN,
    CZAR_DRILL_DB_PREFIX: drillPrefix,
    SHIM_RECORD: shimRecord,
  };
}

/**
 * Async on purpose: the fake servers live in this process, so a synchronous spawn would block
 * the event loop and the script's own requests would never be answered.
 */
function runScript(script: string, args: string[], env: Record<string, string>): Promise<Run> {
  const child = spawn("bash", [script, ...args], { env });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise<Run>((resolve) => {
    child.on("close", (code) => resolve({ status: code ?? -1, stdout, stderr }));
  });
}

function parseTable(
  stdout: string,
): Map<string, { recorded: string; restored: string; result: string }> {
  const rows = new Map<string, { recorded: string; restored: string; result: string }>();
  for (const line of stdout.split("\n")) {
    const cells = line.trim().split(/\s+/);
    if (cells.length === 4 && cells[0] !== "TABLE" && cells[0] !== "VERDICT") {
      rows.set(cells[0] ?? "", {
        recorded: cells[1] ?? "",
        restored: cells[2] ?? "",
        result: cells[3] ?? "",
      });
    }
  }
  return rows;
}

// ---- fixtures ---------------------------------------------------------------------------

before(async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-052-"));
  fixtureRoot = root;
  shimDir = join(root, "shim");
  shimRecord = join(root, "record");
  passwordRoot = join(root, "secrets");
  workRoot = join(root, "work");
  for (const dir of [shimDir, shimRecord, join(passwordRoot, "backup"), workRoot]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(passwordRoot, "backup", "db-password"), `${FIXTURE_PASSWORD}\n`);

  const realPgDump = spawnSync("which", ["pg_dump"], { encoding: "utf8" }).stdout.trim();
  // A pg_dump wrapper: it records the .pgpass file the script built, optionally commits a write
  // AFTER the snapshot was exported (SHIM_INSERT_SQL), and then runs the real pg_dump unchanged.
  writeFileSync(
    join(shimDir, "pg_dump"),
    [
      "#!/usr/bin/env bash",
      'cp -- "$PGPASSFILE" "$SHIM_RECORD/pgpass"',
      'stat --format=%a -- "$PGPASSFILE" >"$SHIM_RECORD/pgpass.mode"',
      'printf "%s\\n" "$*" >"$SHIM_RECORD/pg_dump.args"',
      'if [[ -n "${SHIM_INSERT_SQL:-}" ]]; then',
      `  psql -X -q -h ${PG_HOST} -p ${PG_PORT} -U ${PG_ADMIN} -d "$SHIM_DB" -c "$SHIM_INSERT_SQL" >&2`,
      "fi",
      `exec ${realPgDump} "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(join(shimDir, "pg_dump"), 0o755);

  await createSourceDatabase();
});

after(() => {
  for (const name of leftoverDrillDatabases()) {
    psql("postgres", `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  }
  psql("postgres", `DROP DATABASE IF EXISTS "${sourceDb}" WITH (FORCE)`);
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function emptyWorkRoot(): string[] {
  return readdirSync(workRoot);
}

// ---- the drill --------------------------------------------------------------------------

describe("backup, then restore drill", () => {
  test("a dump restores to the counts taken in its own snapshot, and nothing leaks", async () => {
    const fake = await fakes();
    const liveBefore = Number(psql(sourceDb, "SELECT count(*) FROM users"));
    assert.equal(liveBefore, 3);

    // A write that commits after the snapshot is exported but before pg_dump reads: it is in the
    // live table, and it must be in neither the dump nor the recorded counts.
    const backup = await runScript(backupScript, [], {
      ...baseEnv(fake),
      SHIM_DB: sourceDb,
      SHIM_INSERT_SQL: `INSERT INTO users (user_id) VALUES ('${userId(4)}')`,
    });
    assert.equal(backup.status, 0, backup.stderr);
    assert.equal(
      Number(psql(sourceDb, "SELECT count(*) FROM users")),
      4,
      "the concurrent write landed",
    );

    // Sizes only: no table names, no row values, no token, no password.
    const printed = `${backup.stdout}${backup.stderr}`;
    assert.match(printed, /counts\.json|json: \d+ bytes/);
    assert.match(printed, /dump: \d+ bytes/);
    for (const forbidden of ["users", "devices", "usr_", FAKE_TOKEN, "fixture", "pass", sourceDb]) {
      assert.ok(!printed.includes(forbidden), `the backup printed ${forbidden}`);
    }

    // Both objects are where the spec puts them, and the dump is a pg_dump custom archive.
    assert.deepEqual([...fake.objects.keys()].toSorted(), [
      `czar/${today}.counts.json`,
      `czar/${today}.dump`,
    ]);
    assert.equal(
      fake.objects.get(`czar/${today}.dump`)?.body.subarray(0, 5).toString("latin1"),
      "PGDMP",
    );
    const recorded = JSON.parse(
      fake.objects.get(`czar/${today}.counts.json`)?.body.toString("utf8") ?? "{}",
    ) as {
      snapshot: string;
      tables: Record<string, number>;
    };
    assert.match(recorded.snapshot, /^[0-9A-F]{8}-[0-9A-F]{8}-[0-9]+$/);
    assert.equal(
      recorded.tables["public.users"],
      3,
      "counts come from the snapshot, not the live table",
    );
    assert.equal(recorded.tables["public.devices"], 2);
    assert.equal(recorded.tables["public.model_usage"], 2);
    assert.ok(Object.keys(recorded.tables).length > 10, "every table in the schema is counted");
    assert.ok("public.schema_migrations" in recorded.tables);

    // pg_dump was given the exported snapshot and the custom format.
    const dumpArgs = readFileSync(join(shimRecord, "pg_dump.args"), "utf8");
    assert.match(dumpArgs, /--format=custom/);
    assert.match(dumpArgs, new RegExp(`--snapshot=${recorded.snapshot}`));
    assert.ok(!dumpArgs.includes(FIXTURE_PASSWORD), "the password is not a pg_dump argument");

    // The password reached libpq through a 0600 .pgpass line with `\` and `:` escaped, and it
    // was removed afterwards, with everything else the run created.
    assert.equal(readFileSync(join(shimRecord, "pgpass.mode"), "utf8").trim(), "600");
    assert.equal(
      readFileSync(join(shimRecord, "pgpass"), "utf8"),
      `${PG_HOST}:${PG_PORT}:${sourceDb}:${PG_ADMIN}:fixture\\:pass\\\\word\n`,
    );
    assert.deepEqual(emptyWorkRoot(), [], "the work folder (token, password, dump) was removed");

    // The token came from the metadata server with the required header; Storage got a bearer.
    assert.ok(fake.requests.some((r) => r.service === "metadata" && r.authorization === "Google"));
    const storageCalls = fake.requests.filter((r) => r.service === "storage");
    assert.equal(storageCalls.length, 2);
    assert.ok(storageCalls.every((r) => r.authorization === `Bearer ${FAKE_TOKEN}`));

    // The drill: restore that object into a new database and compare.
    const drill = await runScript(drillScript, ["--date", today], baseEnv(fake));
    assert.equal(drill.status, 0, drill.stderr + drill.stdout);
    if (process.env.PM052_SHOW_DRILL !== undefined) process.stdout.write(drill.stdout);
    assert.match(drill.stdout, /^VERDICT PASS \d+ tables$/m);
    const table = parseTable(drill.stdout);
    assert.ok(table.size > 10);
    for (const [name, row] of table) {
      assert.equal(row.result, "equal", `${name} differs`);
      assert.equal(row.recorded, row.restored, `${name} differs`);
    }
    assert.deepEqual(table.get("public.users"), { recorded: "3", restored: "3", result: "equal" });
    assert.deepEqual(table.get("public.devices"), {
      recorded: "2",
      restored: "2",
      result: "equal",
    });
    assert.deepEqual(table.get("public.model_usage"), {
      recorded: "2",
      restored: "2",
      result: "equal",
    });

    // The drill database is gone, and so is the drill's work folder.
    assert.deepEqual(leftoverDrillDatabases(), []);
    assert.deepEqual(emptyWorkRoot(), []);
    // The live source database was never written by the drill.
    assert.equal(Number(psql(sourceDb, "SELECT count(*) FROM users")), 4);
    // Restore it for the other tests.
    psql(sourceDb, `DELETE FROM users WHERE user_id = '${userId(4)}'`);
  });

  test("a restore whose counts differ from the recorded ones fails, and the database is still dropped", async () => {
    const fake = await fakes();
    const backup = await runScript(backupScript, [], baseEnv(fake));
    assert.equal(backup.status, 0, backup.stderr);

    const key = `czar/${today}.counts.json`;
    const counts = JSON.parse(fake.objects.get(key)?.body.toString("utf8") ?? "{}") as {
      tables: Record<string, number>;
    };
    counts.tables["public.users"] = 4; // as if a row had been lost on the way
    delete counts.tables["public.devices"]; // and a table were missing from the record
    fake.objects.set(key, {
      body: Buffer.from(JSON.stringify(counts)),
      contentType: "application/json",
    });

    const drill = await runScript(drillScript, ["--date", today], baseEnv(fake));
    assert.notEqual(drill.status, 0);
    assert.match(drill.stdout, /^VERDICT FAIL \d+ tables$/m);
    const table = parseTable(drill.stdout);
    assert.deepEqual(table.get("public.users"), {
      recorded: "4",
      restored: "3",
      result: "MISMATCH",
    });
    assert.deepEqual(table.get("public.devices"), {
      recorded: "missing",
      restored: "2",
      result: "MISMATCH",
    });
    assert.deepEqual(leftoverDrillDatabases(), []);
    assert.deepEqual(emptyWorkRoot(), []);
  });

  test("a counts file that is valid JSON but names no tables does not pass the drill", async () => {
    const fake = await fakes();
    assert.equal((await runScript(backupScript, [], baseEnv(fake))).status, 0);
    fake.objects.set(`czar/${today}.counts.json`, {
      body: Buffer.from(JSON.stringify({ tables: {} })),
      contentType: "application/json",
    });
    const drill = await runScript(drillScript, ["--date", today], baseEnv(fake));
    assert.notEqual(drill.status, 0);
    assert.match(drill.stderr, /non-empty table count object/);
    assert.deepEqual(leftoverDrillDatabases(), []);
  });

  test("the drill refuses a missing object, a bad date and an existing database, and creates nothing", async () => {
    const fake = await fakes();
    const env = baseEnv(fake);
    const missing = await runScript(drillScript, ["--date", "2001-01-01"], env);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /there is no backup object/);

    for (const bad of ["2026-13-45", "2026-02-30", "yesterday", ""]) {
      const run = await runScript(drillScript, bad === "" ? [] : ["--date", bad], env);
      assert.notEqual(run.status, 0, `accepted --date ${bad}`);
    }
    assert.equal(
      fake.requests.filter((r) => r.service === "storage").length,
      1,
      "only the one valid-date call",
    );

    // A database with the drill's name already exists: the drill must not reuse or drop it.
    assert.equal((await runScript(backupScript, [], env)).status, 0);
    psql("postgres", `CREATE DATABASE "${drillDb}"`);
    const clash = await runScript(drillScript, ["--date", today], env);
    assert.notEqual(clash.status, 0);
    assert.match(clash.stderr, /already exists/);
    assert.deepEqual(
      leftoverDrillDatabases(),
      [drillDb],
      "the pre-existing database was left alone",
    );
    psql("postgres", `DROP DATABASE "${drillDb}"`);
  });
});

// ---- failures that must not look like success --------------------------------------------

describe("backup failure modes", () => {
  test("a token response with no access_token fails and uploads nothing", async () => {
    const fake = await fakes();
    fake.tokenMode = "no-token";
    const run = await runScript(backupScript, [], baseEnv(fake));
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /no access token/);
    assert.equal(fake.objects.size, 0);
    assert.equal(fake.requests.filter((r) => r.service === "storage").length, 0);
    assert.deepEqual(emptyWorkRoot(), []);
  });

  test("a Storage error fails the backup", async () => {
    const fake = await fakes();
    fake.uploadMode = 403;
    const run = await runScript(backupScript, [], baseEnv(fake));
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /HTTP 403/);
    assert.equal(fake.objects.size, 0);
  });

  test("a 200 that does not confirm the object (no size) fails the backup", async () => {
    const fake = await fakes();
    fake.uploadMode = "no-size";
    const run = await runScript(backupScript, [], baseEnv(fake));
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /did not confirm the uploaded object/);
  });

  test("a missing database password file fails before anything is dumped", async () => {
    const fake = await fakes();
    const run = await runScript(backupScript, [], {
      ...baseEnv(fake),
      CZAR_CREDENTIAL_FILES_DIR: join(workRoot, "no-such-folder"),
    });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /password file is not readable/);
    assert.equal(fake.requests.length, 0);
  });

  test("a storage host other than Google, a missing bucket and a bad bucket are refused", async () => {
    const fake = await fakes();
    for (const [script, override, pattern] of [
      [
        backupScript,
        { CZAR_STORAGE_BASE_URL: "https://storage.example.com" },
        /storage endpoint must be/,
      ],
      [
        backupScript,
        { CZAR_STORAGE_BASE_URL: "http://127.0.0.1.example.com:80" },
        /storage endpoint must be/,
      ],
      [backupScript, { CZAR_BACKUP_BUCKET: "" }, /CZAR_BACKUP_BUCKET is not set/],
      [backupScript, { CZAR_BACKUP_BUCKET: "Not A Bucket" }, /not a bucket name/],
      [
        drillScript,
        { CZAR_STORAGE_BASE_URL: "https://storage.example.com" },
        /storage endpoint must be/,
      ],
    ] as const) {
      const run = await runScript(script, script === drillScript ? ["--date", today] : [], {
        ...baseEnv(fake),
        ...override,
      });
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, pattern);
    }
    assert.equal(fake.requests.length, 0, "no request left the script");
  });
});

// ---- static checks ----------------------------------------------------------------------

describe("backup files", () => {
  const scripts = [backupScript, drillScript, libScript];
  const service = readFileSync(join(backupDir, "czar-backup.service"), "utf8");
  const timer = readFileSync(join(backupDir, "czar-backup.timer"), "utf8");

  test("the scripts are strict bash and never put a secret in an environment or an argument", () => {
    for (const path of scripts) {
      const text = readFileSync(path, "utf8");
      assert.match(text, /^#!\/usr\/bin\/env bash$/m);
      assert.doesNotMatch(text, /PGPASSWORD/);
      assert.doesNotMatch(text, /--password\b|-W\b/);
      assert.doesNotMatch(text, /\.env\b/);
      assert.doesNotMatch(text, /set -x|xtrace/);
    }
    for (const path of [backupScript, drillScript]) {
      assert.match(readFileSync(path, "utf8"), /^set -euo pipefail$/m);
    }
    // The only host a token is ever sent to besides the metadata server.
    assert.match(readFileSync(libScript, "utf8"), /storage\\\.googleapis\\\.com/);
  });

  test("the backup is a custom-format dump at an exported snapshot of a REPEATABLE READ transaction", () => {
    const text = readFileSync(backupScript, "utf8");
    assert.match(text, /pg_dump --format=custom --snapshot="\$snapshot"/);
    assert.match(text, /BEGIN ISOLATION LEVEL REPEATABLE READ/);
    assert.match(text, /pg_export_snapshot\(\)/);
    assert.match(text, /PGUSER_VALUE="\$\{CZAR_BACKUP_PGUSER:-czar_backup\}"/);
    // The retention rule is the bucket's lifecycle (PM-011), not this script's.
    assert.doesNotMatch(text, /retention|--older|delete/i);
  });

  test("the timer fires daily at 02:30 UTC and catches up after downtime", () => {
    assert.match(timer, /^OnCalendar=\*-\*-\* 02:30:00 UTC$/m);
    assert.match(timer, /^Persistent=true$/m);
    assert.match(timer, /^Unit=czar-backup\.service$/m);
    assert.match(timer, /^WantedBy=timers\.target$/m);
    assert.match(service, /^Type=oneshot$/m);
    // Pointers come from an EnvironmentFile of names; no credential is set on the unit itself.
    const settings = service.split("\n").filter((line) => !line.startsWith("#"));
    assert.ok(!settings.some((line) => line.startsWith("Environment=")));
    assert.ok(!settings.some((line) => /PASSWORD|TOKEN/i.test(line)));
  });

  const shellcheck = spawnSync("shellcheck", ["--version"]).status === 0;
  test(
    "shellcheck is clean on every script",
    { skip: shellcheck ? false : "shellcheck is not installed" },
    () => {
      const run = spawnSync("shellcheck", ["-x", ...scripts], { encoding: "utf8" });
      assert.equal(run.status, 0, run.stdout + run.stderr);
    },
  );

  const analyze = spawnSync("systemd-analyze", ["--version"]).status === 0;
  test(
    "systemd-analyze verifies the service and the timer",
    { skip: analyze ? false : "systemd-analyze is not installed" },
    () => {
      // verify checks that ExecStart exists, so run it on copies whose install path points at this
      // folder. The two units the service orders itself after are copied as they are.
      const dir = mkdtempSync(join(tmpdir(), "pm-052-units-"));
      try {
        const systemd = fileURLToPath(new URL("systemd/", cloudRoot));
        for (const name of [
          "czar-secrets.service",
          "czar-metadata-guard.service",
          "run-czar-secrets.mount",
        ]) {
          writeFileSync(join(dir, name), readFileSync(join(systemd, name), "utf8"));
        }
        writeFileSync(
          join(dir, "czar-backup.service"),
          service.replaceAll("/opt/czar/ops/backup", backupDir.replace(/\/$/, "")),
        );
        writeFileSync(join(dir, "czar-backup.timer"), timer);
        const run = spawnSync(
          "systemd-analyze",
          ["verify", join(dir, "czar-backup.service"), join(dir, "czar-backup.timer")],
          {
            encoding: "utf8",
          },
        );
        assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
        assert.equal(
          `${run.stdout}${run.stderr}`.trim(),
          "",
          "systemd-analyze verify printed warnings",
        );
        const calendar = spawnSync("systemd-analyze", ["calendar", "*-*-* 02:30:00 UTC"], {
          encoding: "utf8",
        });
        assert.equal(calendar.status, 0, calendar.stderr);
        assert.match(calendar.stdout, /Normalized form: \*-\*-\* 02:30:00 UTC/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
