import { randomBytes } from "node:crypto";
import { afterAll, beforeAll } from "vitest";
import { Pool } from "pg";
import { migrate } from "#src/db/migrate";

export const TEST_DATABASE_URL = "postgres://postgres@127.0.0.1:15432/postgres";

export interface TestDatabaseConnection {
  getPool(): Pool;
  getUrl(): string;
}

export function setupDatabaseConnection(): TestDatabaseConnection {
  let database: Pool | undefined;
  let admin: Pool | undefined;
  let databaseName: string | undefined;
  let databaseUrl: string | undefined;

  beforeAll(async () => {
    admin = new Pool({ connectionString: TEST_DATABASE_URL });
    databaseName = `czar_t_${randomBytes(8).toString("hex")}`;
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(TEST_DATABASE_URL);
    url.pathname = `/${databaseName}`;
    databaseUrl = url.toString();
    database = new Pool({ connectionString: databaseUrl });
    await migrate(database);
  });

  afterAll(async () => {
    await database?.end();
    if (admin && databaseName) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end();
    }
  });

  return {
    getPool() {
      if (!database) throw new Error("Test database has not been initialized.");
      return database;
    },
    getUrl() {
      if (!databaseUrl) throw new Error("Test database has not been initialized.");
      return databaseUrl;
    },
  };
}

export function setupDatabase(): () => Pool {
  return setupDatabaseConnection().getPool;
}
