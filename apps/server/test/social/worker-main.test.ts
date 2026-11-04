import { describe, expect, it } from "vitest";
import { createSocialPool } from "#src/social/worker-main";
import { setupDatabaseConnection } from "#test/db";

const database = setupDatabaseConnection();

describe("social worker database role", () => {
  it("sets the social role on every new connection before any query", async () => {
    const pool = createSocialPool(database.getUrl(), 2);
    try {
      const users = await Promise.all([
        pool.query<{ current_user: string }>("SELECT current_user"),
        pool.query<{ current_user: string }>("SELECT current_user"),
      ]);
      expect(users.map((result) => result.rows[0]?.current_user)).toEqual([
        "czar_social",
        "czar_social",
      ]);
      await expect(pool.query("SELECT * FROM objectives LIMIT 1")).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await pool.end();
    }
  });
});
