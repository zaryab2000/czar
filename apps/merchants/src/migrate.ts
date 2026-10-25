import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";

const FILENAME = "0012-merchant-payment-identifiers.sql";
const MIGRATION_LOCK = "czar:server:schema-migrations";
const MIGRATION_SQL = new URL(
  "../../server/migrations/0012-merchant-payment-identifiers.sql",
  import.meta.url,
);

export async function migrateMerchant(pool: Pool): Promise<void> {
  const sql = await readFile(MIGRATION_SQL, "utf8");
  const checksum = createHash("sha256").update(sql).digest();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [MIGRATION_LOCK]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await client.query<{ sha256: Buffer }>(
      "SELECT sha256 FROM schema_migrations WHERE filename = $1 FOR UPDATE",
      [FILENAME],
    );
    const existing = applied.rows[0];
    if (existing !== undefined) {
      if (!existing.sha256.equals(checksum))
        throw new Error(`Applied migration ${FILENAME} changed.`);
      await client.query("COMMIT");
      return;
    }
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (filename, sha256) VALUES ($1, $2)", [
      FILENAME,
      checksum,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Merchant migration ${FILENAME} failed and rollback failed.`,
        { cause: rollbackError },
      );
    }
    throw error;
  } finally {
    client.release();
  }
}
