import { describe, expect, it } from "vitest";
import { loadConfig } from "@czar/config";
import { evaluateIncidents } from "#src/social/incidents";
import { probeLeads } from "#src/social/leads";
import { createLesson } from "#src/social/lessons";
import {
  createSocialPool,
  socialHousekeepingPass,
  socialWorkerHooks,
} from "#src/social/worker-main";
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

  it("wires the incident, lead, and lesson handlers into the local worker", async () => {
    expect(socialWorkerHooks).toMatchObject({ createLesson, evaluateIncidents, probeLeads });
    await expect(
      socialHousekeepingPass(
        database.getPool(),
        loadConfig(),
        new Date("2026-11-05T12:00:00Z"),
        socialWorkerHooks,
      ),
    ).resolves.toBeUndefined();
  });
});
