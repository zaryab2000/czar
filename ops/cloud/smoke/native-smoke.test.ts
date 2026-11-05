// PM-014 smoke run without containers: the stack's own files and entry points as real processes.
//
//   node --test --experimental-strip-types ops/cloud/smoke/native-smoke.test.ts
//
// What is real here: Postgres 16 started by ops/cloud/postgres/start.sh from the shipped
// postgresql.conf and pg_hba.conf; ops/cloud/postgres/init-roles.sh and grants.sql; the pinned
// arc-anvil; `ponder start --schema public` as czar_indexer; the server's and the signer's cloud
// entries (through the smoke wrappers, which inject arc-anvil clients and nothing else) as
// czar_api and czar_signer; and the images' own healthcheck scripts. What it cannot show: the
// container users, mounts and Docker healthchecks. For those, run compose.smoke.yaml (README).
//
// The indexer runs Ponder's local branch (CZAR_CLOUD_CONFIG unset): its cloud branch refuses any
// RPC host but rpc.testnet.arc.io, and Ponder dials that host itself, so the cloud branch cannot run
// against arc-anvil without weakening the guard. `--schema public` and the database are the same in
// both branches, which is what PM-024 F8 is about.
//
// Preconditions (it fails, never skips, when one is missing):
//   - Postgres 16 binaries: CZAR_SMOKE_PG_BIN, or /usr/lib/postgresql/16/bin
//   - the checksummed arc-anvil: CZAR_ARC_ANVIL_BIN, or ~/.local/bin/arc-anvil
//     (scripts/install-arc-foundry.sh)
//   - run as root with a `postgres` OS user (Postgres runs as that user, and the shipped pg_hba.conf
//     admits the superuser only by peer as `postgres`), or run as the `postgres` user itself
//   - `pnpm install --frozen-lockfile` done
//   - free loopback ports; nothing else is assumed about the host
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  chownSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { TRIPWIRE_MARK } from "./tripwire.ts";
import { importFrom } from "./resolve-from.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const postgresDir = join(repoRoot, "ops/cloud/postgres");
const smokeDir = join(repoRoot, "ops/cloud/smoke");
const healthcheckDir = join(repoRoot, "ops/cloud/docker/healthcheck");
const PG_BIN = process.env["CZAR_SMOKE_PG_BIN"] ?? "/usr/lib/postgresql/16/bin";
const ANVIL_BIN = process.env["CZAR_ARC_ANVIL_BIN"] ?? join(homedir(), ".local/bin/arc-anvil");
const ARC_TESTNET = 5042002;
const ARC_TESTNET_RPC = "https://rpc.testnet.arc.io";
const ROLES = ["czar_api", "czar_signer", "czar_indexer", "czar_merchants", "czar_backup"] as const;
const SIGNER_CLIENT_GID = 10010;
const READY_TIMEOUT_MS = 180_000;
const POLL_MS = 500;
const PERMISSION_DENIED = "42501";
const QUERY_CANCELED = "57014";
const READ_ONLY_TRANSACTION = "25006";
const INDEXER_TABLES_FOR_SIGNER = [
  "envelopes",
  "reservations",
  "authorizations",
  "pullbacks",
  "pockets",
  "pocket_balances",
  "gateway_transfers",
  "jobs",
  "anchors",
  "manual_returns",
] as const;
const SIGNER_SERVER_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  plans: ["plan_hash", "plan", "state", "objective_id"],
  objectives: ["objective_id", "state"],
  users: ["user_id", "vault"],
  acceptance_reports: ["report_hash"],
  evidence_receipts: ["receipt"],
  payer_pullback_gateway_failures: [
    "pocket",
    "vault_address",
    "state",
    "closed_pocket",
    "return_tx",
    "return_block",
    "return_log_index",
    "returned_amount",
    "manual_return_required_at",
    "unavailable_since",
  ],
};

const asRoot = userInfo().uid === 0;
const pgUser = (() => {
  const result = spawnSync("id", ["-u", "postgres"], { encoding: "utf8" });
  assert.equal(result.status, 0, "no `postgres` OS user");
  return {
    uid: Number(result.stdout.trim()),
    gid: Number(spawnSync("id", ["-g", "postgres"], { encoding: "utf8" }).stdout.trim()),
  };
})();

type Pg = typeof import("pg");
const pg = await importFrom<Pg>("signer", "pg");

interface Running {
  readonly name: string;
  readonly child: ChildProcess;
  stderr: string;
}
const processes: Running[] = [];
let work = "";
let pgPort = 0;
let anvilUrl = "";
const passwords = new Map<string, string>();
const ports = { server: 0, indexer: 0, kms: 0 };

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const address = probe.address();
  await new Promise<void>((done) => probe.close(() => done()));
  if (address === null || typeof address === "string") throw new Error("no free port");
  return address.port;
}

/** Runs a command as the postgres OS user (root: runuser), with a clean environment. */
function asPostgres(command: string, args: readonly string[], env: Record<string, string>) {
  const fullEnv = { PATH: `${PG_BIN}:/usr/bin:/bin`, LANG: "C.UTF-8", ...env };
  if (!asRoot) return { command, args: [...args], env: fullEnv };
  const envArgs = Object.entries(fullEnv).map(([key, value]) => `${key}=${value}`);
  return {
    command: "runuser",
    args: ["-u", "postgres", "--", "env", "-i", ...envArgs, command, ...args],
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
  };
}

function launch(
  name: string,
  command: string,
  args: readonly string[],
  options: { env: Record<string, string>; cwd?: string },
) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const running: Running = { name, child, stderr: "" };
  // Both streams, in arrival order: Ponder reports a failed start on stdout.
  const collect = (chunk: Buffer) => {
    running.stderr += chunk.toString();
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  processes.push(running);
  return running;
}

async function waitFor(label: string, check: () => Promise<boolean> | boolean, running?: Running) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (running && running.child.exitCode !== null)
      assert.fail(
        `${label} exited (${running.child.exitCode}) before it was ready:\n${running.stderr}`,
      );
    if (await check()) return;
    await sleep(POLL_MS);
  }
  assert.fail(`${label} was not ready in time${running ? `:\n${running.stderr}` : ""}`);
}

/** The images' own probe: exit 0 only on a 2xx answer. */
function httpProbe(url: string): boolean {
  return spawnSync(process.execPath, [join(healthcheckDir, "http-health.mjs"), url]).status === 0;
}

function writeSecret(path: string, value: string, owner?: { uid: number; gid: number }) {
  writeFileSync(path, `${value}\n`, { mode: 0o400 });
  chmodSync(path, 0o400);
  if (owner && asRoot) chownSync(path, owner.uid, owner.gid);
}

function rolePool(role: string): InstanceType<Pg["Pool"]> {
  // Discrete fields, not a connectionString: pg 8.23.1 lets a parsed connection string override
  // every other option, and a URL without a password parses to `password: ''`, which silently
  // discards a password function (pg/lib/connection-parameters.js:60).
  return new pg.Pool({
    host: "127.0.0.1",
    port: pgPort,
    user: role,
    database: "czar",
    password: async () => passwords.get(role) ?? "",
    max: 2,
  });
}

async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code ?? "no-code";
  }
}

function runInitRoles() {
  const { command, args, env } = asPostgres("/bin/sh", [join(work, "postgres/init-roles.sh")], {
    PGHOST: join(work, "pgsock"),
    PGPORT: String(pgPort),
    CZAR_PG_INIT_CREDENTIALS: join(work, "secrets/postgres-init"),
    CZAR_PG_INIT_GRANTS: join(work, "postgres/grants.sql"),
  });
  return spawnSync(command, args, { env, encoding: "utf8" });
}

before(async () => {
  assert.ok(existsSync(join(PG_BIN, "postgres")), `no Postgres 16 binaries in ${PG_BIN}`);
  assert.ok(
    existsSync(ANVIL_BIN),
    `no arc-anvil at ${ANVIL_BIN}; run scripts/install-arc-foundry.sh`,
  );
  assert.match(
    spawnSync(ANVIL_BIN, ["--version"], { encoding: "utf8" }).stdout,
    /Commit SHA: d497beea7096ff2a8e583c8b307941f24a61b06b/,
    "arc-anvil is not the pinned arc-foundry v0.8.0-2",
  );
  assert.ok(asRoot || userInfo().username === "postgres", "run as root or as the postgres user");

  work = mkdtempSync(join(tmpdir(), "pm-014-smoke-"));
  chmodSync(work, 0o711);
  [pgPort, ports.server, ports.indexer, ports.kms] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
    freePort(),
  ]);
  const anvilPort = await freePort();
  anvilUrl = `http://127.0.0.1:${anvilPort}`;

  // The shipped Postgres files, copied where the postgres user can read them.
  mkdirSync(join(work, "postgres"), { mode: 0o755 });
  for (const file of [
    "postgresql.conf",
    "pg_hba.conf",
    "start.sh",
    "init-roles.sh",
    "grants.sql",
  ]) {
    copyFileSync(join(postgresDir, file), join(work, "postgres", file));
    chmodSync(join(work, "postgres", file), 0o644);
  }
  for (const dir of ["pgdata", "pgsock"]) {
    mkdirSync(join(work, dir), { mode: 0o700 });
    if (asRoot) chownSync(join(work, dir), pgUser.uid, pgUser.gid);
  }

  // Credentials: the layout czar-secrets.service writes, random values, never printed.
  for (const role of ROLES) passwords.set(role, randomBytes(24).toString("base64url"));
  const folders = {
    server: { "db-password": passwords.get("czar_api") },
    signer: { "db-password": passwords.get("czar_signer") },
    indexer: { "db-password": passwords.get("czar_indexer") },
    merchants: { "db-password": passwords.get("czar_merchants") },
  };
  mkdirSync(join(work, "secrets"), { mode: 0o711 });
  for (const [folder, files] of Object.entries(folders)) {
    mkdirSync(join(work, "secrets", folder), { mode: 0o700 });
    for (const [file, value] of Object.entries(files))
      writeSecret(join(work, "secrets", folder, file), value ?? "");
  }
  // One token per signer client, in the client's folder and under the signer's client-tokens.
  mkdirSync(join(work, "secrets/signer/client-tokens"), { mode: 0o700 });
  for (const client of ["server", "merchants"]) {
    const token = randomBytes(24).toString("hex");
    writeSecret(join(work, "secrets", client, "signer-token"), token);
    writeSecret(join(work, "secrets/signer/client-tokens", client), token);
  }
  // The job workers' caller: the signer expects its token although no worker runs yet.
  writeSecret(
    join(work, "secrets/signer/client-tokens/relayer-jobs"),
    randomBytes(24).toString("hex"),
  );
  mkdirSync(join(work, "secrets/postgres-init"), { mode: 0o500 });
  for (const role of ROLES)
    writeSecret(join(work, "secrets/postgres-init", role), passwords.get(role) ?? "", pgUser);
  if (asRoot) chownSync(join(work, "secrets/postgres-init"), pgUser.uid, pgUser.gid);
  // The indexer's local branch reads DATABASE_URL; its password goes in a 0600 pgpass file that
  // node-postgres reads itself, so it is never in a URL or a variable (a path is a pointer).
  writeFileSync(
    join(work, "indexer.pgpass"),
    `127.0.0.1:${pgPort}:czar:czar_indexer:${passwords.get("czar_indexer")}\n`,
    { mode: 0o600 },
  );

  // The smoke parameter file with this run's paths and ports; every other line unchanged.
  mkdirSync(join(work, "signer-run"), { mode: 0o750 });
  mkdirSync(join(work, "objects"), { mode: 0o700 });
  mkdirSync(join(work, "app/deployments"), { recursive: true });
  copyFileSync(
    join(smokeDir, "deployment.smoke.json"),
    join(work, "app/deployments/arc-testnet.json"),
  );
  const replacements: Record<string, string> = {
    "deploy.credentialFilesDir": JSON.stringify(join(work, "secrets")),
    "deploy.objectStorePath": JSON.stringify(join(work, "objects")),
    "deploy.indexerUrl": JSON.stringify(`http://127.0.0.1:${ports.indexer}`),
    "deploy.metadataTokenUrl": JSON.stringify(
      `http://127.0.0.1:${ports.kms}/computeMetadata/v1/instance/service-accounts/default/token`,
    ),
    "signer.kms.apiBaseUrl": JSON.stringify(`http://127.0.0.1:${ports.kms}`),
    "signer.socketPath": JSON.stringify(join(work, "signer-run/signer.sock")),
  };
  const config = readFileSync(join(smokeDir, "cloud.smoke.toml"), "utf8")
    .split("\n")
    .map((line) => {
      const key = /^"([^"]+)" = /.exec(line)?.[1];
      return key !== undefined && replacements[key] !== undefined
        ? `"${key}" = ${replacements[key]}`
        : line;
    })
    .join("\n");
  writeFileSync(join(work, "cloud.toml"), config);
});

after(async () => {
  for (const running of processes.toReversed()) {
    if (running.child.exitCode === null) {
      running.child.kill("SIGTERM");
      await Promise.race([new Promise((done) => running.child.once("exit", done)), sleep(10_000)]);
      if (running.child.exitCode === null) running.child.kill("SIGKILL");
    }
  }
  if (work !== "" && process.env["CZAR_SMOKE_KEEP"] !== "1")
    rmSync(work, { recursive: true, force: true });
});

test("postgres starts from the shipped files, loopback only, and postgres-init applies the roles", async () => {
  const { command, args, env } = asPostgres(
    "/bin/sh",
    [
      join(work, "postgres/start.sh"),
      "-c",
      `config_file=${join(work, "postgres/postgresql.conf")}`,
      // The shipped file names the container paths; this run's are under the work folder.
      "-c",
      `hba_file=${join(work, "postgres/pg_hba.conf")}`,
      "-c",
      `unix_socket_directories=${join(work, "pgsock")}`,
      "-c",
      `port=${pgPort}`,
    ],
    { PGDATA: join(work, "pgdata") },
  );
  const postgres = launch("postgres", command, args, { env });
  await waitFor(
    "postgres",
    () =>
      spawnSync(join(PG_BIN, "pg_isready"), [
        "--host",
        join(work, "pgsock"),
        "--port",
        String(pgPort),
        "--quiet",
      ]).status === 0,
    postgres,
  );
  assert.match(postgres.stderr, /listening on IPv4 address "127\.0\.0\.1", port \d+/);
  assert.doesNotMatch(postgres.stderr, /listening on IPv4 address "0\.0\.0\.0"|listening on IPv6/);

  const first = runInitRoles();
  assert.equal(first.status, 0, first.stderr);
  // Idempotent: a second `up` runs it again on the live database.
  const second = runInitRoles();
  assert.equal(second.status, 0, second.stderr);

  // No password reached the server as text: every role's stored secret is a SCRAM verifier.
  const admin = asPostgres(
    join(PG_BIN, "psql"),
    [
      "-X",
      "-tA",
      "-d",
      "postgres",
      "-c",
      `SELECT rolname || '=' || left(rolpassword, 14) FROM pg_authid WHERE rolname LIKE 'czar\\_%' ORDER BY 1`,
    ],
    {
      PGHOST: join(work, "pgsock"),
      PGPORT: String(pgPort),
    },
  );
  const stored = spawnSync(admin.command, admin.args, { env: admin.env, encoding: "utf8" });
  assert.equal(stored.status, 0, stored.stderr);
  assert.deepEqual(
    stored.stdout.trim().split("\n"),
    ROLES.toSorted().map((role) => `${role}=SCRAM-SHA-256$`),
  );
  for (const value of passwords.values())
    assert.ok(!postgres.stderr.includes(value), "a password reached the server log");

  // The superuser cannot log in over TCP at all.
  const superuser = new pg.Client({
    connectionString: `postgres://postgres@127.0.0.1:${pgPort}/postgres`,
    password: "x",
  });
  assert.equal(await sqlState(superuser.connect()), "28000");
  await superuser.end().catch(() => {});
});

test("arc-anvil and the KMS fake start on loopback", async () => {
  const anvil = launch(
    "arc-anvil",
    ANVIL_BIN,
    [
      "--network",
      "arc",
      "--chain-id",
      String(ARC_TESTNET),
      "--host",
      "127.0.0.1",
      "--port",
      new URL(anvilUrl).port,
      "--mnemonic-random",
      "--quiet",
    ],
    { env: { PATH: "/usr/bin:/bin" } },
  );
  await waitFor(
    "arc-anvil",
    async () => {
      try {
        const response = await fetch(anvilUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        });
        return (
          ((await response.json()) as { result?: string }).result ===
          `0x${ARC_TESTNET.toString(16)}`
        );
      } catch {
        return false;
      }
    },
    anvil,
  );
  const kms = launch(
    "kms-fake",
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      join(smokeDir, "kms-fake.ts"),
    ],
    {
      env: {
        PATH: process.env["PATH"] ?? "",
        CZAR_SMOKE_KMS_PORT: String(ports.kms),
        CZAR_SMOKE_KMS_VERSIONS:
          "projects/czar-smoke/locations/asia-south1/keyRings/czar-alpha/cryptoKeys/relayer/cryptoKeyVersions/1",
        CZAR_SMOKE_KMS_POCKET_RING:
          "projects/czar-smoke/locations/asia-south1/keyRings/czar-alpha-pockets",
      },
    },
  );
  await waitFor("kms-fake", () => httpProbe(`http://127.0.0.1:${ports.kms}/health`), kms);
});

test("the indexer starts with `ponder start --schema public` as czar_indexer and its tables are in public", async () => {
  const indexer = launch(
    "indexer",
    "pnpm",
    [
      "--filter",
      "@czar/indexer",
      "exec",
      "ponder",
      "start",
      "--schema",
      "public",
      "--port",
      String(ports.indexer),
      "--hostname",
      "127.0.0.1",
    ],
    {
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: work,
        CZAR_LOCAL_CONFIG: join(repoRoot, "env/local.toml"),
        CZAR_INDEXER_DEPLOYMENT_PATH: join(work, "app/deployments/arc-testnet.json"),
        CZAR_INDEXER_RPC_URL: anvilUrl,
        CZAR_ARC_RPC_URL: anvilUrl,
        CZAR_INDEXER_DISABLE_EXTERNAL_POLL: "1",
        DATABASE_URL: `postgres://czar_indexer@127.0.0.1:${pgPort}/czar`,
        PGPASSFILE: join(work, "indexer.pgpass"),
      },
    },
  );
  await waitFor("indexer", () => httpProbe(`http://127.0.0.1:${ports.indexer}/health`), indexer);

  const backup = rolePool("czar_backup");
  try {
    const owners = await backup.query<{ tablename: string; tableowner: string }>(
      "SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)",
      [INDEXER_TABLES_FOR_SIGNER],
    );
    assert.deepEqual(
      owners.rows.map((row) => row.tablename).toSorted(),
      [...INDEXER_TABLES_FOR_SIGNER].toSorted(),
      "an indexer table the signer reads is not in schema public",
    );
    for (const row of owners.rows) assert.equal(row.tableowner, "czar_indexer", row.tablename);
  } finally {
    await backup.end();
  }
});

test("the server's cloud entry starts as czar_api and /health answers", async () => {
  const server = launch(
    "server",
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      join(smokeDir, "server-smoke.ts"),
    ],
    {
      cwd: join(work, "app"),
      env: {
        PATH: process.env["PATH"] ?? "",
        CZAR_CLOUD_CONFIG: join(work, "cloud.toml"),
        CZAR_DATABASE_URL: `postgres://czar_api@127.0.0.1:${pgPort}/czar`,
        CZAR_ARC_RPC_URL: ARC_TESTNET_RPC,
        CZAR_SERVER_PORT: String(ports.server),
        CZAR_SMOKE_ANVIL_URL: anvilUrl,
      },
    },
  );
  await waitFor("server", () => httpProbe(`http://127.0.0.1:${ports.server}/health`), server);
  const response = await fetch(`http://127.0.0.1:${ports.server}/health`);
  assert.equal(response.status, 200);
  process.stdout.write(`# GET /health -> ${response.status} ${await response.text()}\n`);
});

test("the signer's cloud entry starts as czar_signer and the image's socket probe passes", async () => {
  const signer = launch(
    "signer",
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      join(smokeDir, "signer-smoke.ts"),
    ],
    {
      cwd: join(work, "app"),
      env: {
        PATH: process.env["PATH"] ?? "",
        CZAR_CLOUD_CONFIG: join(work, "cloud.toml"),
        CZAR_DATABASE_URL: `postgres://czar_signer@127.0.0.1:${pgPort}/czar`,
        CZAR_SIGNER_RPC_URL: ARC_TESTNET_RPC,
        CZAR_SMOKE_ANVIL_URL: anvilUrl,
      },
    },
  );
  const probe = () =>
    spawnSync(process.execPath, [join(healthcheckDir, "signer-socket.mjs")], {
      env: { PATH: process.env["PATH"] ?? "", CZAR_CLOUD_CONFIG: join(work, "cloud.toml") },
    }).status === 0;
  await waitFor("signer", probe, signer);
  assert.match(signer.stderr, /signer-smoke: socket up, chain 5042002, 1 key\(s\)/);
  // signer.socketGroupGid: 0660 with group 10010 in a 0750 folder (SCR-170 §4).
  const stat = spawnSync("stat", ["-c", "%a %g", join(work, "signer-run/signer.sock")], {
    encoding: "utf8",
  });
  assert.equal(stat.stdout.trim(), `660 ${SIGNER_CLIENT_GID}`);
});

test("PM-024 F8: the signer's indexer-backed reads find their tables, through the real projection", async () => {
  const signer = rolePool("czar_signer");
  try {
    for (const table of INDEXER_TABLES_FOR_SIGNER)
      await signer.query(`SELECT count(*) FROM ${table}`); // unqualified, as the projection reads
    for (const [table, columns] of Object.entries(SIGNER_SERVER_COLUMNS))
      await signer.query(`SELECT ${columns.join(", ")} FROM ${table} LIMIT 0`);

    const { createPostgresProjection } =
      await import("../../../apps/signer/src/postgres-projection.ts");
    const { loadConfigFile } = await import("../../../packages/config/src/index.ts");
    const chainUntouched = new Proxy(
      {},
      { get: () => () => assert.fail("a database read touched the chain") },
    );
    const projection = createPostgresProjection({
      config: await loadConfigFile(join(work, "cloud.toml")),
      database: signer,
      chain: chainUntouched as never,
      factory: "0x1111111111111111111111111111111111111111",
    });
    const zero = `0x${"00".repeat(32)}` as const;
    const address = "0x7777777777777777777777777777777777777777" as const;
    assert.deepEqual(await projection.nanoSpent(address, address), { step: 0n, pocket: 0n });
    assert.equal(await projection.latestEvidenceRoot(address, 1), zero);
    assert.equal(await projection.evidenceBatchExists(zero), false);
    assert.equal(await projection.job(address, 1n), undefined);
    assert.equal(await projection.reportExists(zero), false);
    assert.equal(await projection.checksCommitExists(zero), false);
  } finally {
    await signer.end();
  }
});

test("czar_signer holds exactly PR #213's grants, and nothing more", async () => {
  const signer = rolePool("czar_signer");
  try {
    assert.equal(
      await sqlState(signer.query("SELECT user_secret FROM users LIMIT 0")),
      PERMISSION_DENIED,
    );
    assert.equal(
      await sqlState(signer.query("SELECT demand_salt FROM users LIMIT 0")),
      PERMISSION_DENIED,
    );
    assert.equal(await sqlState(signer.query("SELECT * FROM vaults LIMIT 0")), PERMISSION_DENIED);
    assert.equal(
      await sqlState(signer.query("SELECT * FROM merchant_payment_identifiers LIMIT 0")),
      PERMISSION_DENIED,
    );
    assert.equal(await sqlState(signer.query("DELETE FROM envelopes")), PERMISSION_DENIED);
    assert.equal(await sqlState(signer.query("UPDATE plans SET state = state")), PERMISSION_DENIED);
    assert.equal(
      await sqlState(signer.query("CREATE TABLE pm014_probe (x int)")),
      PERMISSION_DENIED,
    );
    // The audit log: INSERT and SELECT on the named columns, with no sequence grant.
    await signer.query(
      "INSERT INTO audit (actor_key_id, action, object_ids, outcome, at) VALUES ('K7', 'pm-014-smoke', '[]', 'signed', now())",
    );
    const audit = await signer.query("SELECT action FROM audit WHERE action = 'pm-014-smoke'");
    assert.equal(audit.rowCount, 1);
    assert.equal(
      await sqlState(signer.query("SELECT audit_id FROM audit LIMIT 0")),
      PERMISSION_DENIED,
    );
    assert.equal(await sqlState(signer.query("DELETE FROM audit")), PERMISSION_DENIED);
    const settings = await signer.query<{ statement_timeout: string }>("SHOW statement_timeout");
    assert.equal(settings.rows[0]?.statement_timeout, "2s");
    const path = await signer.query<{ search_path: string }>("SHOW search_path");
    assert.equal(path.rows[0]?.search_path, "public");
  } finally {
    await signer.end();
  }
});

test("PM-024 F7: a hung query as czar_signer is cancelled at the signing budget", async () => {
  const signer = rolePool("czar_signer");
  try {
    const started = Date.now();
    assert.equal(await sqlState(signer.query("SELECT pg_sleep(30)")), QUERY_CANCELED);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5_000, `cancelled after ${elapsed} ms`);
  } finally {
    await signer.end();
  }
});

test("czar_api, czar_merchants and czar_backup hold their grants and no more", async () => {
  const api = rolePool("czar_api");
  const merchants = rolePool("czar_merchants");
  const backup = rolePool("czar_backup");
  try {
    // The server reads the indexer over HTTP only (PR #213).
    assert.equal(await sqlState(api.query("SELECT * FROM envelopes LIMIT 0")), PERMISSION_DENIED);
    // Merchants: the real start-time migration path, then its one table.
    const { migrateMerchant } = await import("../../../apps/merchants/src/migrate.ts");
    await migrateMerchant(merchants as never);
    await merchants.query("SELECT * FROM merchant_payment_identifiers LIMIT 0");
    assert.equal(await sqlState(merchants.query("SELECT * FROM users LIMIT 0")), PERMISSION_DENIED);
    assert.equal(
      await sqlState(merchants.query("SELECT * FROM envelopes LIMIT 0")),
      PERMISSION_DENIED,
    );
    // Only the migrator may create roles (migration 0023 creates czar_social), and it cannot touch
    // another service's role.
    const attributes = await backup.query<{
      rolname: string;
      rolcreaterole: boolean;
      rolsuper: boolean;
    }>(
      "SELECT rolname, rolcreaterole, rolsuper FROM pg_roles WHERE rolname LIKE 'czar\\_%' ORDER BY 1",
    );
    for (const row of attributes.rows) {
      assert.equal(row.rolsuper, false, row.rolname);
      assert.equal(row.rolcreaterole, row.rolname === "czar_api", row.rolname);
    }
    assert.equal(await sqlState(api.query("ALTER ROLE czar_signer NOLOGIN")), PERMISSION_DENIED);
    assert.equal(
      await sqlState(api.query("GRANT pg_read_all_data TO czar_api")),
      PERMISSION_DENIED,
    );
    // Backups read everything and write nothing.
    await backup.query("SELECT count(*) FROM users");
    await backup.query("SELECT count(*) FROM envelopes");
    assert.equal(
      await sqlState(
        backup.query(
          "INSERT INTO audit (actor_key_id, action, object_ids, outcome, at) VALUES ('x','x','[]','x',now())",
        ),
      ),
      READ_ONLY_TRANSACTION,
    );
  } finally {
    await Promise.all([api.end(), merchants.end(), backup.end()]);
  }
});

test("no process tried to reach a non-loopback host", () => {
  for (const running of processes)
    assert.ok(!running.stderr.includes(TRIPWIRE_MARK), `${running.name}: ${running.stderr}`);
  for (const running of processes)
    assert.equal(running.child.exitCode, null, `${running.name} exited:\n${running.stderr}`);
});
