import { randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { migrate } from "#src/db/migrate";
import { setupDatabase, TEST_DATABASE_URL } from "#test/db";

const getPool = setupDatabase();
const serverMigrations = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");

describe("CZ-12 migrations", () => {
  it("migration_appliesOnce_andRejectsEditedFile", async () => {
    const directory = await mkdtemp(join(tmpdir(), "czar-migrate-"));
    const filename = join(directory, "0090-test.sql");
    try {
      await writeFile(filename, "CREATE TABLE migration_once (id integer PRIMARY KEY);");
      await migrate(getPool(), directory);
      await migrate(getPool(), directory);
      const applied = await getPool().query(
        "SELECT sha256 FROM schema_migrations WHERE filename = $1",
        ["0090-test.sql"],
      );
      expect(applied.rowCount).toBe(1);
      expect(applied.rows[0]?.sha256).toHaveLength(32);

      await writeFile(filename, "CREATE TABLE migration_once (id integer PRIMARY KEY); SELECT 1;");
      await expect(migrate(getPool(), directory)).rejects.toThrow(/changed after application/);
      const table = await getPool().query("SELECT to_regclass('public.migration_once') AS name");
      expect(table.rows[0]?.name).toBe("migration_once");
    } finally {
      await getPool().query("DROP TABLE IF EXISTS migration_once");
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("migration_atomicOnFailure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "czar-migrate-fail-"));
    const filename = join(directory, "0091-failure.sql");
    try {
      await writeFile(
        filename,
        "CREATE TABLE migration_partial (id integer); SELECT * FROM missing_migration_table;",
      );
      await expect(migrate(getPool(), directory)).rejects.toThrow();
      const table = await getPool().query("SELECT to_regclass('public.migration_partial') AS name");
      const marker = await getPool().query(
        "SELECT filename FROM schema_migrations WHERE filename = $1",
        ["0091-failure.sql"],
      );
      expect(table.rows[0]?.name).toBeNull();
      expect(marker.rowCount).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("0030 replaces the localhost-only rp_id check with a host-name check (PM-016)", async () => {
    const scratch = await createScratchDatabase();
    const directory = await mkdtemp(join(tmpdir(), "czar-migrate-rp-id-"));
    try {
      const files = (await readdir(serverMigrations)).filter((name) => name.endsWith(".sql"));
      const before = files.filter((name) => name < "0030").toSorted();
      const migration0030 = files.find((name) => name.startsWith("0030-"));
      expect(migration0030).toBe("0030-passkey-rp-id-host.sql");
      for (const name of before) {
        await copyFile(join(serverMigrations, name), join(directory, name));
      }
      await migrate(scratch.pool, directory);

      const original = await scratch.pool.query<{ conname: string; definition: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
         WHERE conrelid = 'passkey_credentials'::regclass AND contype = 'c'
           AND pg_get_constraintdef(oid) LIKE '%rp_id%'`,
      );
      expect(original.rows.map(({ conname }) => conname)).toEqual([
        "passkey_credentials_rp_id_check",
      ]);
      expect(original.rows[0]?.definition).toContain("'localhost'");

      await insertCredential(scratch.pool, "localhost");
      await expect(insertCredential(scratch.pool, "app.example.com")).rejects.toThrow(
        /passkey_credentials_rp_id_check/,
      );

      await copyFile(
        join(serverMigrations, "0030-passkey-rp-id-host.sql"),
        join(directory, "0030-passkey-rp-id-host.sql"),
      );
      await migrate(scratch.pool, directory);

      const kept = await scratch.pool.query<{ rp_id: string }>(
        "SELECT rp_id FROM passkey_credentials ORDER BY credential_id",
      );
      expect(kept.rows.map(({ rp_id }) => rp_id)).toEqual(["localhost"]);
      const remaining = await scratch.pool.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint
         WHERE conrelid = 'passkey_credentials'::regclass AND contype = 'c'
           AND pg_get_constraintdef(oid) LIKE '%rp_id%'`,
      );
      expect(remaining.rows.map(({ conname }) => conname)).toEqual([
        "passkey_credentials_rp_id_host_check",
      ]);

      await insertCredential(scratch.pool, "app.example.com");
      await expect(insertCredential(scratch.pool, "Bad Host!")).rejects.toThrow(
        /passkey_credentials_rp_id_host_check/,
      );
      await expect(insertCredential(scratch.pool, "App.Example.Com")).rejects.toThrow(
        /passkey_credentials_rp_id_host_check/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
      await scratch.drop();
    }
  });

  it("creates the current server table foundation", async () => {
    const result = await getPool().query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    expect(result.rows.map(({ table_name }) => table_name)).toEqual([
      "acceptance_reports",
      "audit",
      "auth_challenges",
      "devices",
      "evidence_receipts",
      "executor_leases",
      "idempotency",
      "merchant_payment_identifiers",
      "model_reservations",
      "model_usage",
      "objective_cursors",
      "objectives",
      "observations",
      "outbox_events",
      "pairing_codes",
      "passkey_credentials",
      "pay_requests",
      "payer_freeze_autolimit_cursors",
      "payer_freeze_autolimit_events",
      "payer_job_briefs",
      "payer_job_deliverables",
      "payer_pullback_gateway_failures",
      "plan_pocket_keys",
      "plans",
      "profiles",
      "ranking_decisions",
      "rate_limit_buckets",
      "rating_receipts",
      "ratings",
      "ratings_effective",
      "results",
      "schema_migrations",
      "selection_interim_snapshots",
      "service_versions",
      "sessions",
      "step_executions",
      "steps",
      "supplier_counts",
      "supplier_health",
      "users",
    ]);
    const freezeColumns = await getPool().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='payer_freeze_autolimit_events'`,
    );
    expect(freezeColumns.rows.map(({ column_name }) => column_name)).toContain(
      "auto_limits_lowered_at",
    );
    const cursorColumns = await getPool().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='payer_freeze_autolimit_cursors'`,
    );
    expect(cursorColumns.rows.map(({ column_name }) => column_name)).toContain("scan_target_block");
  });
});

interface ScratchDatabase {
  readonly pool: Pool;
  drop(): Promise<void>;
}

/** A throwaway database so a migration can be applied step by step. */
async function createScratchDatabase(): Promise<ScratchDatabase> {
  const admin = new Pool({ connectionString: TEST_DATABASE_URL });
  const name = `czar_m_${randomBytes(8).toString("hex")}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString() });
  return {
    pool,
    async drop() {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.end();
    },
  };
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let credentialCounter = 0;

async function insertCredential(pool: Pool, rpId: string): Promise<void> {
  credentialCounter += 1;
  const high = CROCKFORD[Math.floor(credentialCounter / 32) % 32] ?? "0";
  const low = CROCKFORD[credentialCounter % 32] ?? "0";
  const userId = `usr_01K7ZT9P4N5Q6R7S8T9V0W1X${high}${low}`;
  const credentialId = `cred_rpid_${credentialCounter}`;
  await pool.query("INSERT INTO users (user_id) VALUES ($1)", [userId]);
  await pool.query(
    `INSERT INTO passkey_credentials (credential_id,user_id,qx,qy,sign_count,rp_id)
     VALUES ($1,$2,$3,$4,0,$5)`,
    [credentialId, userId, Buffer.alloc(32, 1), Buffer.alloc(32, 2), rpId],
  );
}
