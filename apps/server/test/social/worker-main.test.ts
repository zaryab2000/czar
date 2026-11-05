import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "@czar/config";
import { evaluateIncidents } from "#src/social/incidents";
import { probeLeads } from "#src/social/leads";
import { createLesson } from "#src/social/lessons";
import {
  createSocialPool,
  runScheduledSocialHousekeeping,
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

describe("social worker schedule", () => {
  it("evaluates incidents hourly while running other housekeeping every 15 minutes", async () => {
    const evaluate = vi.fn(async () => {});
    const probe = vi.fn(async () => {});
    const schedule = { nextHousekeepingAt: 0, nextIncidentAt: 0 };
    const start = Date.parse("2026-11-05T12:00:00Z");

    for (const minutes of [0, 15, 30, 45, 60]) {
      await runScheduledSocialHousekeeping(
        database.getPool(),
        loadConfig(),
        new Date(start + minutes * 60_000),
        schedule,
        { evaluateIncidents: evaluate, probeLeads: probe },
      );
    }

    expect(probe).toHaveBeenCalledTimes(5);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(evaluate.mock.calls.map((call) => call[2]?.toISOString())).toEqual([
      "2026-11-05T12:00:00.000Z",
      "2026-11-05T13:00:00.000Z",
    ]);
  });
});
