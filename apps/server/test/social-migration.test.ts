import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { migrate } from "#src/db/migrate";
import { setupDatabase } from "#test/db";

const getPool = setupDatabase();
const TEST_DATABASE_URL = "postgres://postgres@127.0.0.1:15432/postgres";

describe("SN-1 social role and migration", () => {
  it("allows its projections and rejects base-table reads and money writes", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE czar_social");
      await expect(
        client.query("SELECT * FROM social_objective_projection LIMIT 0"),
      ).resolves.toBeDefined();
      await expect(
        client.query("SELECT * FROM social_observation_projection LIMIT 0"),
      ).resolves.toBeDefined();
      await client.query("SAVEPOINT denied_read");
      await expect(client.query("SELECT * FROM observations LIMIT 0")).rejects.toMatchObject({
        code: "42501",
      });
      await client.query("ROLLBACK TO SAVEPOINT denied_read");
      for (const table of ["objectives", "steps", "users", "plans", "ranking_decisions"] as const) {
        await client.query("SAVEPOINT denied_base");
        await expect(client.query(`SELECT * FROM ${table} LIMIT 0`)).rejects.toMatchObject({
          code: "42501",
        });
        await client.query("ROLLBACK TO SAVEPOINT denied_base");
      }
      for (const table of [
        "observations",
        "ratings",
        "supplier_counts",
        "supplier_health",
        "ranking_decisions",
      ] as const) {
        await client.query("SAVEPOINT denied_write");
        await expect(client.query(`INSERT INTO ${table} DEFAULT VALUES`)).rejects.toMatchObject({
          code: "42501",
        });
        await client.query("ROLLBACK TO SAVEPOINT denied_write");
      }
      await client.query("SAVEPOINT denied_outbox");
      await expect(
        client.query("INSERT INTO outbox_events(name,payload) VALUES ('payment.settled','{}')"),
      ).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK TO SAVEPOINT denied_outbox");
      await expect(
        client.query(
          "INSERT INTO outbox_events(name,payload) VALUES ('social.post.published','{}')",
        ),
      ).resolves.toBeDefined();
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("applies concurrently in separate databases on one cluster", async () => {
    const admin = new Pool({ connectionString: TEST_DATABASE_URL });
    const names = [0, 1].map(() => `czar_social_${randomBytes(8).toString("hex")}`);
    const pools: Pool[] = [];
    try {
      for (const name of names) await admin.query(`CREATE DATABASE "${name}"`);
      for (const name of names) {
        const url = new URL(TEST_DATABASE_URL);
        url.pathname = `/${name}`;
        pools.push(new Pool({ connectionString: url.toString() }));
      }
      await expect(Promise.all(pools.map((pool) => migrate(pool)))).resolves.toBeDefined();
      for (const pool of pools) {
        const result = await pool.query("SELECT to_regclass('social_representatives') AS name");
        expect(result.rows[0]?.name).toBe("social_representatives");
      }
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
      for (const name of names) await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.end();
    }
  });
});
