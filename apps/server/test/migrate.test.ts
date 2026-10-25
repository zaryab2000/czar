import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrate } from "#src/db/migrate";
import { setupDatabase } from "#test/db";

const getPool = setupDatabase();

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
      "model_reservations",
      "model_usage",
      "objective_cursors",
      "objectives",
      "outbox_events",
      "pairing_codes",
      "passkey_credentials",
      "pay_requests",
      "payer_job_briefs",
      "payer_job_deliverables",
      "payer_pullback_gateway_failures",
      "plan_pocket_keys",
      "plans",
      "profiles",
      "rate_limit_buckets",
      "results",
      "schema_migrations",
      "selection_interim_snapshots",
      "sessions",
      "step_executions",
      "steps",
      "users",
    ]);
  });
});
