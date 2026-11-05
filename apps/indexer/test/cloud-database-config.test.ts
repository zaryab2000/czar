// OPS-06 / PR #225: the database settings the indexer hands to Ponder (SCR-170 §4).
//
// Ponder passes `{ connectionString, ...poolConfig, max, ssl }` to node-postgres
// (ponder 0.18.2, dist/esm/build/pre.js). node-postgres parses a `connectionString` over the other
// options, and a URL with no password writes `password: null` over the password function; the
// server then refuses the login with "client password must be a string". So the database config
// carries discrete fields and no URL, and the password function must survive on the client that
// node-postgres builds from what Ponder passes it.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, type PoolConfig } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "@czar/config";
import { cloudDatabaseConfig } from "#src/cloud-config";

const URL_POINTER = { CZAR_DATABASE_URL: "postgres://czar_indexer@127.0.0.1:5432/czar" };
const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) await rm(directories.pop() ?? "", { recursive: true });
});

/** A credential folder holding the indexer's `db-password` file; returns the folder and the file. */
async function credentialFolder(password: string): Promise<{ folder: string; file: string }> {
  const folder = await mkdtemp(join(tmpdir(), "czar-indexer-db-"));
  directories.push(folder);
  await mkdir(join(folder, "indexer"));
  const file = join(folder, "indexer", "db-password");
  await writeFile(file, password, { mode: 0o600 });
  return { folder, file };
}

/** Only `deploy.credentialFilesDir` is read, so a stub stands in for the loaded cloud config. */
const configWith = (folder: string): Config =>
  ({ get: (key: string) => (key === "deploy.credentialFilesDir" ? folder : undefined) }) as Config;

/** What Ponder hands to `new pg.Pool(...)`, exactly as its build step derives it. */
function ponderPoolConfig(database: object): PoolConfig {
  const { poolConfig, connectionString } = database as {
    poolConfig?: object;
    connectionString?: string;
  };
  return { connectionString, ...poolConfig, max: 30, ssl: false };
}

describe("cloudDatabaseConfig", () => {
  it("keeps the password function on the client node-postgres builds from Ponder's pool config", async () => {
    const { folder } = await credentialFolder("from-the-file\n");
    const database = cloudDatabaseConfig(configWith(folder), URL_POINTER);
    const client = new Client(ponderPoolConfig(database)) as unknown as {
      host: string;
      port: number;
      database: string;
      user: string;
      password: unknown;
    };
    expect(client).toMatchObject({
      host: "127.0.0.1",
      port: 5432,
      database: "czar",
      user: "czar_indexer",
    });
    expect(typeof client.password).toBe("function");
    await expect((client.password as () => Promise<string>)()).resolves.toBe("from-the-file");
  });

  it("carries no connection string for node-postgres to parse over the password function", async () => {
    const { folder } = await credentialFolder("x");
    const database = cloudDatabaseConfig(configWith(folder), URL_POINTER);
    expect(database).not.toHaveProperty("connectionString");
    expect(database.kind).toBe("postgres");
  });

  it("reads the password file at each connection, so a rotated secret takes effect", async () => {
    const { folder, file } = await credentialFolder("first\n");
    const { poolConfig } = cloudDatabaseConfig(configWith(folder), URL_POINTER);
    await expect(poolConfig.password()).resolves.toBe("first");
    await writeFile(file, "rotated\n");
    await expect(poolConfig.password()).resolves.toBe("rotated");
  });

  it("fails with the file's own error when the password file is missing", async () => {
    const folder = await mkdtemp(join(tmpdir(), "czar-indexer-db-"));
    directories.push(folder);
    const { poolConfig } = cloudDatabaseConfig(configWith(folder), URL_POINTER);
    await expect(poolConfig.password()).rejects.toThrow(/ENOENT/);
  });

  it("refuses a URL that carries a password, and a missing or malformed pointer", async () => {
    const { folder } = await credentialFolder("x");
    const config = configWith(folder);
    expect(() =>
      cloudDatabaseConfig(config, {
        CZAR_DATABASE_URL: "postgres://czar_indexer:pw@127.0.0.1/czar",
      }),
    ).toThrow(/must not carry a password/);
    expect(() => cloudDatabaseConfig(config, {})).toThrow(/CZAR_DATABASE_URL is not set/);
    expect(() => cloudDatabaseConfig(config, { CZAR_DATABASE_URL: "not a url" })).toThrow(
      /is not a URL/,
    );
  });
});
