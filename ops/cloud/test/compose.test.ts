// Tests for the cloud stack's compose files (PM-014; SCR-170 §1, §4, §5).
//
// Run from the repository root:
//
//   node --test --experimental-strip-types ops/cloud/test/compose.test.ts
//
// They need the `docker compose` CLI (to parse and validate the files exactly as Docker will), but
// no Docker daemon, no image and no network: `docker compose config` only reads files. Nothing
// here starts a container. The image-dependent acceptance run is in ops/cloud/README.md.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PARAMETERS } from "../../../packages/config/src/registry.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cloudDir = fileURLToPath(new URL("../", import.meta.url));
const composeFile = join(cloudDir, "compose.yaml");
const smokeFile = join(cloudDir, "compose.smoke.yaml");
const read = (relative: string) => readFileSync(join(repoRoot, relative), "utf8");

/** The production start order (SCR-170 §1; ops/local/process-compose.yaml). */
const START_ORDER = ["postgres", "indexer", "server", "signer", "merchants"] as const;
/** Czar's own app containers: the only ones whose stdout the Ops Agent may ship. */
const APP_SERVICES = ["server", "signer", "merchants", "web"] as const;
/** Containers whose raw stdout must never reach Cloud Logging (logging ruling, PM-014). */
const UNSHIPPED_SERVICES = ["postgres", "postgres-init", "indexer"] as const;
const LONG_RUNNING = ["postgres", "indexer", "server", "signer", "merchants", "web"] as const;
const SECRETS_ROOT = "/run/czar/secrets";
const SIGNER_RUN_DIR = "/run/czar/signer";
const CLOUD_CONFIG_TARGET = "/etc/czar/cloud.toml";
const DEPLOYMENT_TARGET = "/app/deployments/arc-testnet.json";
const APP_UID = "10001";
const SIGNER_UID = "10002";
const SIGNER_CLIENT_GID = "10010";
/** The official postgres image's own user, which SCR-170 §4 lets Postgres run as. */
const POSTGRES_IMAGE_UID = "999";

interface Mount {
  readonly type: string;
  readonly source?: string;
  readonly target: string;
  readonly read_only?: boolean;
  readonly volume?: { readonly subpath?: string };
}
interface Service {
  readonly image?: string;
  readonly user?: string;
  readonly network_mode?: string;
  readonly restart?: string;
  readonly environment?: Readonly<Record<string, string | null>>;
  readonly volumes?: readonly Mount[];
  readonly depends_on?: Readonly<Record<string, { readonly condition: string }>>;
  readonly logging?: { readonly driver?: string };
  readonly ports?: readonly unknown[];
  readonly profiles?: readonly string[];
  readonly healthcheck?: { readonly test?: readonly string[]; readonly disable?: boolean };
  readonly command?: readonly string[];
  readonly entrypoint?: readonly string[];
  readonly working_dir?: string;
}
interface Model {
  readonly services: Readonly<Record<string, Service>>;
}

function compose(files: readonly string[], env: Record<string, string> = {}) {
  return spawnSync(
    "docker",
    ["compose", ...files.flatMap((file) => ["-f", file]), "config", "--format", "json"],
    {
      encoding: "utf8",
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...env },
    },
  );
}

function model(files: readonly string[] = [composeFile]): Model {
  const result = compose(files, { CZAR_IMAGE_TAG: "0123abc" });
  assert.equal(result.status, 0, `docker compose config failed:\n${result.stderr}`);
  return JSON.parse(result.stdout) as Model;
}

const service = (name: string, files?: readonly string[]): Service => {
  const found = model(files).services[name];
  assert.ok(found, `no service ${name}`);
  return found;
};

test("docker compose -f ops/cloud/compose.yaml config is valid", () => {
  const result = compose([composeFile], { CZAR_IMAGE_TAG: "0123abc" });
  assert.equal(result.status, 0, result.stderr);
  const names = Object.keys((JSON.parse(result.stdout) as Model).services).toSorted();
  assert.deepEqual(names, [
    "indexer",
    "merchants",
    "postgres",
    "postgres-init",
    "server",
    "signer",
    "web",
  ]);
});

test("the image tag is required, never a floating default", () => {
  const result = compose([composeFile]);
  assert.notEqual(result.status, 0, "compose accepted a missing CZAR_IMAGE_TAG");
  assert.match(result.stderr, /CZAR_IMAGE_TAG/);
  for (const name of APP_SERVICES.concat(["indexer"] as never))
    assert.equal(service(name).image, `czar-${name}:0123abc`, name);
});

test("postgres uses the image digest pinned in ops/local/compose.yaml", () => {
  const local = /image:\s*(postgres:16\.15@sha256:[0-9a-f]{64})/.exec(
    read("ops/local/compose.yaml"),
  );
  assert.ok(local, "ops/local/compose.yaml pins no postgres digest");
  assert.equal(service("postgres").image, local[1]);
  assert.equal(service("postgres-init").image, local[1]);
});

test("every service is host-networked and publishes no port", () => {
  for (const [name, entry] of Object.entries(model().services)) {
    assert.equal(entry.network_mode, "host", `${name} is not host-networked`);
    assert.equal(entry.ports, undefined, `${name} publishes a port`);
  }
});

const SECRET_VALUE_PATTERNS: readonly [string, RegExp][] = [
  ["a URL with a password", /:\/\/[^/@\s]*:[^/@\s]*@/],
  ["a 32-byte hex value", /(?:0x)?[0-9a-fA-F]{64}/],
  ["a provider API key", /\bsk-[A-Za-z0-9_-]{8,}/],
  ["a bearer token", /\bbearer\s+\S{8,}/i],
  ["a PEM block", /-----BEGIN [A-Z ]+-----/],
  ["a long base64 run", /[A-Za-z0-9+/]{40,}={0,2}/],
];
/** Variable names that would carry a credential, not a pointer to one. */
const SECRET_NAME = /PASSWORD|PASSWD|TOKEN|SECRET|PRIVATE|MNEMONIC|SEED|API_?KEY|CREDENTIAL/i;

test("no environment value matches a secret pattern", () => {
  for (const files of [[composeFile], [composeFile, smokeFile]]) {
    for (const [name, entry] of Object.entries(model(files).services)) {
      for (const [key, value] of Object.entries(entry.environment ?? {})) {
        assert.doesNotMatch(key, SECRET_NAME, `${name}: ${key} names a credential`);
        for (const [label, pattern] of SECRET_VALUE_PATTERNS)
          assert.doesNotMatch(String(value ?? ""), pattern, `${name}: ${key} holds ${label}`);
      }
    }
  }
  // The source text too, so a value hidden in a comment or an unused anchor is caught.
  // An image digest is a public content hash, not a credential, so pinned digests are masked.
  for (const file of ["ops/cloud/compose.yaml", "ops/cloud/compose.smoke.yaml"]) {
    const text = read(file).replace(/@sha256:[0-9a-f]{64}/g, "@sha256:<digest>");
    for (const [label, pattern] of SECRET_VALUE_PATTERNS)
      assert.doesNotMatch(text, pattern, `${file} holds ${label}`);
  }
});

test("every database URL pointer names the service's own role and carries no password", () => {
  const roles: Record<string, string> = {
    indexer: "czar_indexer",
    server: "czar_api",
    signer: "czar_signer",
    merchants: "czar_merchants",
  };
  for (const [name, role] of Object.entries(roles)) {
    const url = new URL(String(service(name).environment?.["CZAR_DATABASE_URL"]));
    assert.equal(url.username, role, name);
    assert.equal(url.password, "", `${name} database URL carries a password`);
    assert.equal(url.hostname, "127.0.0.1", name);
    assert.equal(url.port, "5432", name);
    assert.equal(url.pathname, "/czar", name);
  }
  // Ponder otherwise falls back to DATABASE_URL; the cloud branch reads CZAR_DATABASE_URL only.
  assert.equal(service("indexer").environment?.["DATABASE_URL"], undefined);
});

test("each secrets mount is read-only and per service", () => {
  const expected: Record<string, string> = {
    indexer: "indexer",
    server: "server",
    signer: "signer",
    merchants: "merchants",
    "postgres-init": "postgres-init",
  };
  for (const [name, entry] of Object.entries(model().services)) {
    const mounts = (entry.volumes ?? []).filter(
      (mount) => mount.target.startsWith(SECRETS_ROOT) || mount.source?.startsWith(SECRETS_ROOT),
    );
    const folder = expected[name];
    if (folder === undefined) {
      assert.equal(mounts.length, 0, `${name} sees a credential folder`);
      continue;
    }
    assert.equal(mounts.length, 1, `${name} must mount exactly its own credential folder`);
    const [mount] = mounts;
    assert.equal(mount?.type, "bind", name);
    assert.equal(mount?.source, `${SECRETS_ROOT}/${folder}`, name);
    assert.equal(mount?.target, `${SECRETS_ROOT}/${folder}`, name);
    assert.equal(mount?.read_only, true, `${name} credential mount is writable`);
  }
});

test("secrets.list fills every credential folder a service mounts, under that service's UID", () => {
  const rows = read("ops/cloud/systemd/secrets.list")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.split(/\s+/));
  const uidOf = new Map(rows.map(([, folder, , uid]) => [folder, uid]));
  assert.equal(uidOf.get("server"), APP_UID);
  assert.equal(uidOf.get("merchants"), APP_UID);
  assert.equal(uidOf.get("indexer"), APP_UID);
  assert.equal(uidOf.get("signer"), SIGNER_UID);
  assert.equal(uidOf.get("postgres-init"), POSTGRES_IMAGE_UID);
  // postgres-init sets each role's password from the same secret that role's service reads.
  const init = rows.filter(([, folder]) => folder === "postgres-init");
  const bySecret = (folder: string) =>
    rows.find(([, f, file]) => f === folder && file === "db-password")?.[0];
  assert.deepEqual(Object.fromEntries(init.map(([secret, , file]) => [file, secret])), {
    czar_api: bySecret("server"),
    czar_signer: bySecret("signer"),
    czar_indexer: bySecret("indexer"),
    czar_merchants: bySecret("merchants"),
    czar_backup: bySecret("backup"),
  });
  for (const row of init) assert.equal(row[4], "required", row.join(" "));
});

test("secrets.list gives the signer an expected token for every caller it loads at start", () => {
  const callers = /SOCKET_SERVICES = \[([^\]]+)\]/.exec(read("apps/signer/src/socket.ts"))?.[1];
  assert.ok(callers, "apps/signer/src/socket.ts names no SOCKET_SERVICES");
  const list = read("ops/cloud/systemd/secrets.list");
  for (const caller of callers.split(",").map((name) => name.trim().replace(/"/g, "")))
    assert.match(
      list,
      new RegExp(
        `^czar-alpha-signer-token-${caller}\\s+signer\\s+client-tokens/${caller}\\s+10002\\s+required$`,
        "m",
      ),
      `the cloud signer refuses to start without client-tokens/${caller}`,
    );
});

test("services run as the SCR-170 §4 users", () => {
  assert.equal(service("signer").user, `${SIGNER_UID}:${SIGNER_CLIENT_GID}`);
  for (const name of ["server", "merchants", "indexer", "web"])
    assert.equal(service(name).user, `${APP_UID}:${SIGNER_CLIENT_GID}`, name);
  assert.equal(service("postgres-init").user, `${POSTGRES_IMAGE_UID}:${POSTGRES_IMAGE_UID}`);
});

test("the signer socket folder is the host folder, bind-mounted into signer, server and merchants only", () => {
  for (const [name, entry] of Object.entries(model().services)) {
    const mounts = (entry.volumes ?? []).filter((mount) => mount.target === SIGNER_RUN_DIR);
    if (!["signer", "server", "merchants"].includes(name)) {
      assert.equal(mounts.length, 0, `${name} can reach the signer socket folder`);
      continue;
    }
    assert.equal(mounts.length, 1, name);
    assert.equal(mounts[0]?.type, "bind", `${name}: the socket folder must not be a named volume`);
    assert.equal(mounts[0]?.source, SIGNER_RUN_DIR, name);
  }
  // Clients need write access to connect(); only the signer may create the socket, which the
  // folder's 0750 10002:10010 mode enforces on the host.
  assert.equal(
    service("signer").volumes?.find((mount) => mount.target === SIGNER_RUN_DIR)?.read_only ?? false,
    false,
  );
});

test("env/cloud.toml and the deployment file are mounted read-only and the pointer names them", () => {
  for (const name of ["indexer", "server", "signer", "merchants"]) {
    const entry = service(name);
    const config = entry.volumes?.find((mount) => mount.target === CLOUD_CONFIG_TARGET);
    assert.equal(config?.type, "bind", name);
    assert.equal(config?.source, join(repoRoot, "env/cloud.toml"), name);
    assert.equal(config?.read_only, true, `${name}: env/cloud.toml is writable`);
    assert.equal(entry.environment?.["CZAR_CLOUD_CONFIG"], CLOUD_CONFIG_TARGET, name);
    const deployment = entry.volumes?.find((mount) => mount.target === DEPLOYMENT_TARGET);
    assert.equal(deployment?.source, join(repoRoot, "deployments/arc-testnet.json"), name);
    assert.equal(deployment?.read_only, true, name);
  }
  assert.equal(service("indexer").environment?.["CZAR_INDEXER_DEPLOYMENT_PATH"], DEPLOYMENT_TARGET);
});

test("every RPC pointer is the Arc testnet RPC", () => {
  const pointers: Record<string, string> = {
    indexer: "CZAR_INDEXER_RPC_URL",
    server: "CZAR_ARC_RPC_URL",
    merchants: "CZAR_ARC_RPC_URL",
    signer: "CZAR_SIGNER_RPC_URL",
  };
  for (const files of [[composeFile], [composeFile, smokeFile]])
    for (const [name, pointer] of Object.entries(pointers)) {
      const entry = model(files).services[name];
      if (entry === undefined || entry.profiles !== undefined) continue;
      assert.equal(
        entry.environment?.[pointer],
        "https://rpc.testnet.arc.io",
        `${name} ${pointer}`,
      );
      for (const value of Object.values(entry.environment ?? {}))
        assert.doesNotMatch(String(value ?? ""), /rpc\.testnet\.arc\.network/);
    }
});

/** `processes.<name>.depends_on.<dep>` from ops/local/process-compose.yaml, by indentation. */
function localDependencies(): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  let process: string | undefined;
  let inDepends = false;
  let inProcesses = false;
  for (const line of read("ops/local/process-compose.yaml").split("\n")) {
    if (/^\S/.test(line)) inProcesses = line.startsWith("processes:");
    if (!inProcesses) continue;
    const top = /^ {2}([a-z0-9-]+):\s*$/.exec(line);
    if (top) {
      process = top[1];
      inDepends = false;
      result.set(process ?? "", new Set());
      continue;
    }
    if (/^ {4}depends_on:\s*$/.test(line)) {
      inDepends = true;
      continue;
    }
    if (/^ {4}\S/.test(line)) inDepends = false;
    const dep = /^ {6}([a-z0-9-]+):\s*$/.exec(line);
    if (inDepends && dep && process) result.get(process)?.add(dep[1] ?? "");
  }
  return result;
}

test("the start order is postgres → indexer → server → signer → merchants, as in ops/local", () => {
  const local = localDependencies();
  const services = model().services;
  for (let index = 1; index < START_ORDER.length; index += 1) {
    const earlier = START_ORDER[index - 1] ?? "";
    const later = START_ORDER[index] ?? "";
    assert.ok(local.get(later)?.has(earlier), `ops/local: ${later} does not wait for ${earlier}`);
    assert.equal(
      services[later]?.depends_on?.[earlier]?.condition,
      "service_healthy",
      `${later} does not wait for ${earlier} to be healthy`,
    );
  }
  // Nothing earlier in the order waits for anything later (no cycle, no inversion).
  for (const [index, name] of START_ORDER.entries())
    for (const later of START_ORDER.slice(index + 1))
      assert.equal(services[name]?.depends_on?.[later], undefined, `${name} waits for ${later}`);
  // The roles exist before any app connects.
  for (const name of START_ORDER.slice(1))
    assert.equal(
      services[name]?.depends_on?.["postgres-init"]?.condition,
      "service_completed_successfully",
      name,
    );
  assert.equal(services["postgres-init"]?.depends_on?.["postgres"]?.condition, "service_healthy");
  assert.equal(services["web"]?.depends_on?.["server"]?.condition, "service_healthy");
});

test("every gated service has a healthcheck the image or this file supplies", () => {
  const services = model().services;
  const gated = new Set(
    Object.values(services).flatMap((entry) =>
      Object.entries(entry.depends_on ?? {})
        .filter(([, dep]) => dep.condition === "service_healthy")
        .map(([name]) => name),
    ),
  );
  for (const name of gated) {
    const entry = services[name];
    assert.notEqual(entry?.healthcheck?.disable, true, `${name}'s healthcheck is disabled`);
    // postgres's is declared here; the app images declare theirs (PM-013).
    if (name === "postgres") assert.ok(entry?.healthcheck?.test, "postgres has no healthcheck");
    else
      assert.match(
        read(`ops/cloud/docker/${name}.Dockerfile`),
        /^HEALTHCHECK /m,
        `${name}'s image has no HEALTHCHECK`,
      );
  }
});

test("long-running services restart unless stopped; the one-shot init does not", () => {
  const services = model().services;
  for (const name of LONG_RUNNING) assert.equal(services[name]?.restart, "unless-stopped", name);
  assert.equal(services["postgres-init"]?.restart, "no");
});

test("no service uses gcplogs; only Czar's own app containers use json-file", () => {
  for (const files of [[composeFile], [composeFile, smokeFile]])
    for (const [name, entry] of Object.entries(model(files).services))
      assert.notEqual(entry.logging?.driver, "gcplogs", name);
  const services = model().services;
  // The Ops Agent (PM-051) reads /var/lib/docker/containers/*/*-json.log. A container on the
  // `local` driver writes no such file, so its raw stdout cannot be shipped.
  for (const name of APP_SERVICES)
    assert.ok(
      services[name]?.logging === undefined || services[name]?.logging?.driver === "json-file",
      `${name} must use the default json-file driver`,
    );
  for (const name of UNSHIPPED_SERVICES)
    assert.equal(services[name]?.logging?.driver, "local", `${name}'s stdout would be shipped`);
});

test("postgres: loopback only, scram, terse errors, data on /var/lib/czar/postgres", () => {
  const entry = service("postgres");
  const data = entry.volumes?.find((mount) => mount.source === "/var/lib/czar/postgres");
  assert.equal(data?.type, "bind");
  const conf = read("ops/cloud/postgres/postgresql.conf");
  const setting = (key: string) =>
    new RegExp(`^${key}\\s*=\\s*'?([^'\\s#]+)'?`, "m").exec(conf)?.[1];
  assert.equal(setting("listen_addresses"), "127.0.0.1");
  assert.equal(setting("port"), "5432");
  assert.equal(setting("password_encryption"), "scram-sha-256");
  assert.equal(setting("log_error_verbosity"), "terse");
  assert.equal(setting("hba_file"), "/etc/czar/postgres/pg_hba.conf");
  assert.ok(
    entry.command?.some((arg) => arg === "config_file=/etc/czar/postgres/postgresql.conf"),
    "postgres does not start from the shipped postgresql.conf",
  );
  const hba = read("ops/cloud/postgres/pg_hba.conf")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.split(/\s+/));
  assert.ok(hba.length > 0);
  for (const row of hba) {
    assert.notEqual(row.at(-1), "trust", `trust in pg_hba.conf: ${row.join(" ")}`);
    assert.notEqual(row.at(-1), "password", `cleartext password in pg_hba.conf: ${row.join(" ")}`);
    if (row[0] === "local") assert.deepEqual(row, ["local", "all", "postgres", "peer"]);
    else {
      assert.equal(row[0], "host", row.join(" "));
      assert.equal(row[3], "127.0.0.1/32", row.join(" "));
      assert.equal(row[4], "scram-sha-256", row.join(" "));
      assert.ok(!row[2]?.split(",").includes("postgres"), "the superuser may connect over TCP");
    }
  }
  // The superuser has no password at all, so nothing sets one from the environment.
  assert.equal(entry.environment?.["POSTGRES_PASSWORD"], undefined);
  assert.equal(entry.environment?.["POSTGRES_HOST_AUTH_METHOD"], undefined);
});

test("the signer's statement timeout is the signing budget, kms.signTimeoutMs (PM-024 F7)", () => {
  const budget = PARAMETERS.find((parameter) => parameter.key === "kms.signTimeoutMs");
  assert.ok(budget && "default" in budget);
  const grants = read("ops/cloud/postgres/grants.sql");
  const timeout = /ALTER ROLE czar_signer SET statement_timeout = '(\d+)ms'/.exec(grants);
  assert.ok(timeout, "grants.sql sets no statement_timeout for czar_signer");
  assert.equal(Number(timeout[1]), budget.default);
});

test("the cloud example config names the socket folder and group compose mounts", async () => {
  const { loadConfigFile } = await import("../../../packages/config/src/index.ts");
  const config = await loadConfigFile(join(repoRoot, "env/cloud.example.toml"));
  assert.equal(config.get("signer.socketPath"), `${SIGNER_RUN_DIR}/signer.sock`);
  assert.equal(config.get("signer.socketGroupGid"), Number(SIGNER_CLIENT_GID));
  assert.equal(config.get("deploy.credentialFilesDir"), SECRETS_ROOT);
  // Relative, so it resolves against the images' WORKDIR /app to the mounted file.
  assert.equal(config.get("deploy.deploymentFile"), "deployments/arc-testnet.json");
});

test("the signer image's healthcheck resolves @czar/config and recognises a live socket", async () => {
  // PM-013's probe imported @czar/config from ops/cloud/docker/healthcheck/, where pnpm does not
  // link workspace packages, so it failed on every run and the signer could never become healthy.
  const dir = mkdtempSync(join(tmpdir(), "pm-014-probe-"));
  try {
    const socketPath = join(dir, "signer.sock");
    const configPath = join(dir, "cloud.toml");
    writeFileSync(configPath, `"signer.socketPath" = ${JSON.stringify(socketPath)}\n`);
    const probe = join(cloudDir, "docker/healthcheck/signer-socket.mjs");
    const run = () =>
      spawnSync(process.execPath, [probe], {
        encoding: "utf8",
        env: { CZAR_CLOUD_CONFIG: configPath, PATH: process.env["PATH"] ?? "" },
      });
    const missing = run();
    assert.equal(missing.status, 1);
    assert.doesNotMatch(missing.stderr, /ERR_MODULE_NOT_FOUND/);
    const server = createServer();
    await new Promise<void>((done) => server.listen(socketPath, done));
    try {
      const live = run();
      assert.equal(live.status, 0, live.stderr);
      assert.equal(live.stdout, "healthy socket\n");
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the merchants image carries the one server migration merchants applies at start", () => {
  const migrate = read("apps/merchants/src/migrate.ts");
  const file = /"\.\.\/\.\.\/server\/migrations\/([0-9a-z-]+\.sql)"/.exec(migrate)?.[1];
  assert.ok(file, "migrate.ts no longer names a server migration");
  assert.match(
    read("ops/cloud/docker/merchants.Dockerfile"),
    new RegExp(
      `^COPY apps/server/migrations/${file.replace(/\./g, "\\.")} apps/server/migrations/$`,
      "m",
    ),
  );
});

test("the smoke override is valid, keeps the cloud guard, and runs no indexer, merchants or web", () => {
  const services = model([composeFile, smokeFile]).services;
  // Without a profile, `config` (and so `up`) leaves the `full` services out entirely.
  const full = compose([composeFile, smokeFile], {
    CZAR_IMAGE_TAG: "0123abc",
    COMPOSE_PROFILES: "full",
  });
  assert.equal(full.status, 0, full.stderr);
  const withFull = (JSON.parse(full.stdout) as Model).services;
  for (const name of ["indexer", "merchants", "web"]) {
    assert.equal(services[name], undefined, `${name} runs in the smoke run`);
    assert.deepEqual(withFull[name]?.profiles, ["full"], `${name} is not in the full profile`);
  }
  for (const name of ["postgres", "postgres-init", "server", "signer", "arc-anvil", "kms-fake"])
    assert.ok(services[name] && services[name]?.profiles === undefined, `${name} missing`);
  // The smoke parameter file keeps the production RPC allowlist; the entries are driven with
  // injected clients against arc-anvil, so no guard is bypassed.
  const smokeConfig = read("ops/cloud/smoke/cloud.smoke.toml");
  assert.match(smokeConfig, /^"deploy\.allowedRpcHosts" = \["rpc\.testnet\.arc\.io"\]$/m);
  assert.match(smokeConfig, /^"deploy\.environment" = "cloud-testnet"$/m);
  assert.equal(services["server"]?.depends_on?.["indexer"], undefined);
  assert.equal(services["signer"]?.depends_on?.["server"]?.condition, "service_healthy");
  assert.equal(services["server"]?.depends_on?.["arc-anvil"]?.condition, "service_healthy");
  // arc-anvil is the checksummed arc-foundry binary, never upstream anvil or foundryup.
  const anvil = services["arc-anvil"];
  assert.ok(anvil?.command?.includes("--network") && anvil.command.includes("arc"));
  assert.ok(anvil?.command?.[0]?.endsWith("arc-anvil"));
});

test("no production source file carries a smoke bypass", () => {
  for (const file of [
    "apps/server/src/cloud-main.ts",
    "apps/signer/src/cloud-main.ts",
    "apps/merchants/src/cloud-main.ts",
    "packages/config/src/cloud-only.ts",
  ])
    assert.doesNotMatch(read(file), /smoke|CZAR_SMOKE/i, file);
});
