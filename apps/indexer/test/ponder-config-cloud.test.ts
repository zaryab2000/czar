// PM-059 / SCR-170 §3 (a): `ponder.config.ts` takes a cloud branch only when the pointer
// `CZAR_CLOUD_CONFIG` is set. The branch checks the RPC host before Ponder contacts it, and sets
// `database: {kind: "postgres", poolConfig}` (host, port, database, user, password function) from the password-free URL pointer, with the password
// read from the indexer's `db-password` file. With the pointer unset nothing changes. Each case loads the
// config in a child process, as `ponder-config-start-block.test.ts` does; nothing is contacted.
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const PASSWORD_FREE_URL = "postgres://czar_indexer@127.0.0.1:5432/czar";
const DESCRIBE_DATABASE =
  "const d = config.database; const out = d === undefined ? {absent: true} : " +
  "{kind: d.kind, connectionString: d.connectionString, host: d.poolConfig?.host, port: d.poolConfig?.port, " +
  "database: d.poolConfig?.database, user: d.poolConfig?.user, passwordType: typeof d.poolConfig?.password, " +
  "password: typeof d.poolConfig?.password === 'function' ? await d.poolConfig.password() : null};" +
  "process.stdout.write(JSON.stringify(out));";
const WHOLE_CONFIG = "process.stdout.write(JSON.stringify(config));";

interface Scenario {
  readonly cloud?: Readonly<Record<string, string>> | false;
  readonly env?: Readonly<Record<string, string>>;
  readonly expression?: string;
}

async function loadConfig(scenario: Scenario = {}): Promise<ReturnType<typeof spawnSync>> {
  const directory = await mkdtemp(join(tmpdir(), "czar-indexer-cloud-"));
  temporaryDirectories.push(directory);
  const deploymentPath = join(directory, "deployment.json");
  await writeFile(
    deploymentPath,
    JSON.stringify({
      chainId: 5042002,
      CzarVaultFactory: "0x0000000000000000000000000000000000000001",
      OpenEvidenceLog: "0x0000000000000000000000000000000000000002",
    }),
  );
  const credentials = join(directory, "secrets");
  await mkdir(join(credentials, "indexer"), { recursive: true, mode: 0o700 });
  const passwordFile = join(credentials, "indexer", "db-password");
  await writeFile(passwordFile, "from-the-file\n", { mode: 0o400 });
  await chmod(passwordFile, 0o400);

  const env: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"],
    HOME: process.env["HOME"],
    CZAR_LOCAL_CONFIG: resolve(import.meta.dirname, "../../../env/local.toml"),
    CZAR_INDEXER_DEPLOYMENT_PATH: deploymentPath,
    ...scenario.env,
  };
  if (scenario.cloud !== false && scenario.cloud !== undefined) {
    const parameters: Record<string, string> = {
      "deploy.environment": '"cloud-testnet"',
      "deploy.allowedRpcHosts": '["rpc.testnet.arc.io"]',
      "deploy.credentialFilesDir": JSON.stringify(credentials),
      "app.origin": '"https://app.example.com"',
      "merchants.publicOrigin": '"https://merchants.example.com"',
      "merchants.lab.enabled": "false",
      "selection.paymentNetwork": '"eip155:5042002"',
      ...scenario.cloud,
    };
    const configPath = join(directory, "cloud.toml");
    await writeFile(
      configPath,
      Object.entries(parameters)
        .map(([key, value]) => `"${key}" = ${value}`)
        .join("\n"),
    );
    env["CZAR_CLOUD_CONFIG"] = configPath;
  }

  const configUrl = pathToFileURL(resolve(import.meta.dirname, "../ponder.config.ts")).href;
  const script = `import config from ${JSON.stringify(configUrl)};${scenario.expression ?? DESCRIBE_DATABASE}`;
  return spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      script,
    ],
    { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8", env },
  );
}

describe("ponder.config.ts cloud branch (SCR-170 §3 a)", () => {
  it("builds the postgres database from the URL pointer and the db-password file", async () => {
    const result = await loadConfig({
      cloud: {},
      env: { CZAR_DATABASE_URL: PASSWORD_FREE_URL },
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(String(result.stdout))).toEqual({
      kind: "postgres",
      host: "127.0.0.1",
      port: 5432,
      database: "czar",
      user: "czar_indexer",
      passwordType: "function",
      password: "from-the-file",
    });
  });

  it("refuses a database URL that carries a password", async () => {
    const result = await loadConfig({
      cloud: {},
      env: { CZAR_DATABASE_URL: "postgres://czar_indexer:in-the-url@127.0.0.1:5432/czar" },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("CZAR_DATABASE_URL must not carry a password");
    expect(result.stderr).not.toContain("in-the-url");
  });

  it("refuses to start without the database URL pointer", async () => {
    const result = await loadConfig({ cloud: {} });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("CZAR_DATABASE_URL is not set");
  });

  it("refuses an RPC host outside deploy.allowedRpcHosts before Ponder can contact it", async () => {
    const result = await loadConfig({
      cloud: {},
      env: {
        CZAR_DATABASE_URL: PASSWORD_FREE_URL,
        CZAR_INDEXER_RPC_URL: "https://rpc.testnet.arc.network",
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("deploy.allowedRpcHosts");
  });

  it("refuses deploy.environment = local", async () => {
    const result = await loadConfig({
      cloud: { "deploy.environment": '"local"' },
      env: { CZAR_DATABASE_URL: PASSWORD_FREE_URL },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("deploy.environment");
  });
});

describe("ponder.config.ts with CZAR_CLOUD_CONFIG unset", () => {
  it("sets no database, so Ponder's own default applies as today", async () => {
    const result = await loadConfig({ cloud: false });
    expect(result.status).toBe(0);
    expect(JSON.parse(String(result.stdout))).toEqual({ absent: true });
  });

  it("ignores the cloud pointers entirely: the config is the same with or without them", async () => {
    const plain = await loadConfig({ cloud: false, expression: WHOLE_CONFIG });
    const withPointers = await loadConfig({
      cloud: false,
      expression: WHOLE_CONFIG,
      env: { CZAR_DATABASE_URL: "postgres://anyone:pw@127.0.0.1:1/x" },
    });
    expect(plain.status).toBe(0);
    expect(withPointers.status).toBe(0);
    expect(String(withPointers.stdout)).toBe(String(plain.stdout));
    expect(JSON.parse(String(plain.stdout))).not.toHaveProperty("database");
  });
});
