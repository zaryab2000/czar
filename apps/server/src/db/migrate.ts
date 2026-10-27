import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";

const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../migrations");
const migrationLock = "czar:server:schema-migrations";
const migrationFilename = /^\d{4}-[a-z0-9-]+\.sql$/;

async function migrationFiles(directory: string): Promise<string[]> {
  return (await readdir(directory))
    .filter((filename) => migrationFilename.test(filename))
    .toSorted();
}

async function migrateOne(client: PoolClient, path: string, filename: string): Promise<void> {
  const sql = await readFile(path, "utf8");
  const checksum = createHash("sha256").update(sql).digest();
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [migrationLock]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await client.query<{ sha256: Buffer }>(
      "SELECT sha256 FROM schema_migrations WHERE filename = $1 FOR UPDATE",
      [filename],
    );
    if (applied.rowCount) {
      if (!applied.rows[0]?.sha256.equals(checksum)) {
        throw new Error(`Applied migration ${filename} changed after application.`);
      }
      await client.query("COMMIT");
      return;
    }
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (filename, sha256) VALUES ($1, $2)", [
      filename,
      checksum,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function migrate(pool: Pool, directory = migrationDirectory): Promise<void> {
  const client = await pool.connect();
  try {
    for (const filename of await migrationFiles(directory)) {
      await migrateOne(client, resolve(directory, filename), filename);
    }
  } finally {
    client.release();
  }
}
