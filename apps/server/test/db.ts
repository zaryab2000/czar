import { randomBytes } from "node:crypto";
import { afterAll, beforeAll } from "vitest";
import { Pool } from "pg";
import { migrate } from "#src/db/migrate";

const TEST_DATABASE_URL = "postgres://postgres@127.0.0.1:15432/postgres";

export function setupDatabase(): () => Pool {
  let database: Pool | undefined;
  let admin: Pool | undefined;
  let databaseName: string | undefined;

  beforeAll(async () => {
    admin = new Pool({ connectionString: TEST_DATABASE_URL });
    databaseName = `czar_t_${randomBytes(8).toString("hex")}`;
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const databaseUrl = new URL(TEST_DATABASE_URL);
    databaseUrl.pathname = `/${databaseName}`;
    database = new Pool({ connectionString: databaseUrl.toString() });
    await migrate(database);
  });

  afterAll(async () => {
    await database?.end();
    if (admin && databaseName) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end();
    }
  });

  return () => {
    if (!database) throw new Error("Test database has not been initialized.");
    return database;
  };
}
