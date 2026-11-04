import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { validateSchema } from "@czar/schemas";
import { consumeSocialBatch } from "#src/social/consumer";
import {
  replayControlledFixtures,
  seedControlledFixtures,
  type ControlledFixture,
} from "#src/social/controlled-fixtures";
import { controlledLocalContext } from "#src/social/controlled-local";
import { setupDatabase } from "#test/db";
import { createTestContext } from "#test/fixtures";

const pool = setupDatabase();
const fixturePath = new URL("./fixtures/controlled-evidence.json", import.meta.url);
let fixture: ControlledFixture;

describe("controlled social fixture", () => {
  beforeAll(async () => {
    fixture = JSON.parse(await readFile(fixturePath, "utf8")) as ControlledFixture;
  });

  it("refuses a remote database before reading the local overlay", async () => {
    await expect(
      controlledLocalContext({ CZAR_DATABASE_URL: "postgres://example.invalid/czar" }),
    ).rejects.toThrow(/loopback PostgreSQL/);
  });

  it("uses valid structured task specifications for every controlled outcome", () => {
    expect(fixture.experiences.every((item) => validateSchema("task-spec", item.taskSpec))).toBe(
      true,
    );
    expect(validateSchema("task-spec", fixture.noSupplier.taskSpec)).toBe(true);
  });

  it("seeds three controlled owners with settled evidence and direct ratings", async () => {
    const context = createTestContext(pool());
    await seedControlledFixtures(pool(), fixture, {
      count: 3,
      network: fixture.network,
      consentTextVersion: "1",
      now: new Date("2026-11-05T12:00:00Z"),
      random: context.random,
      versionFor: async () => `ver_${"a".repeat(32)}`,
    });
    const counts = await pool().query<{
      users: string;
      representatives: string;
      objectives: string;
      observations: string;
      ratings: string;
      receipts: string;
    }>(`SELECT
      (SELECT count(*) FROM users WHERE controlled)::text AS users,
      (SELECT count(*) FROM social_representatives WHERE controlled)::text AS representatives,
      (SELECT count(*) FROM objectives o JOIN users u USING(user_id) WHERE u.controlled)::text AS objectives,
      (SELECT count(*) FROM observations WHERE controlled)::text AS observations,
      (SELECT count(*) FROM ratings r JOIN users u USING(user_id) WHERE u.controlled)::text AS ratings,
      (SELECT count(*) FROM rating_receipts rr JOIN observations o USING(obs_id)
        WHERE o.controlled)::text AS receipts`);
    expect(counts.rows[0]).toEqual({
      users: "3",
      representatives: "3",
      objectives: "10",
      observations: "18",
      ratings: "9",
      receipts: "18",
    });
    const submissions = await pool().query<{ submission: unknown }>(
      `SELECT o.submission FROM objectives o JOIN users u USING(user_id) WHERE u.controlled`,
    );
    expect(
      submissions.rows.every((row) => validateSchema("objective-submission", row.submission)),
    ).toBe(true);
    const handles = await pool().query<{ handle: string }>(
      "SELECT handle FROM social_representatives WHERE controlled ORDER BY handle",
    );
    expect(handles.rows).toHaveLength(3);
    expect(handles.rows.every((row) => /^Rep-[0-9A-HJKMNP-TV-Z]{4}$/.test(row.handle))).toBe(true);
  });

  it("replays outcome and rating events once for seeded fixtures", async () => {
    const first = await replayControlledFixtures(pool());
    expect(first).toEqual({ outcomes: 9, ratings: 9 });
    const second = await replayControlledFixtures(pool());
    expect(second).toEqual({ outcomes: 0, ratings: 0 });
    const events = await pool().query<{ name: string; count: string }>(
      `SELECT name,count(*)::text AS count FROM outbox_events
       WHERE name IN ('objective.delivered','rating.recorded') GROUP BY name ORDER BY name`,
    );
    expect(events.rows).toEqual([
      { name: "objective.delivered", count: "9" },
      { name: "rating.recorded", count: "9" },
    ]);
    expect(await consumeSocialBatch(pool(), 25)).toBe(19);
    const inbox = await pool().query<{ kind: string; count: string }>(
      `SELECT kind,count(*)::text AS count FROM social_inbox
       GROUP BY kind ORDER BY kind`,
    );
    expect(inbox.rows).toEqual([
      { kind: "need-unmet", count: "1" },
      { kind: "outcome-ready", count: "9" },
      { kind: "outcome-updated", count: "9" },
    ]);
  });
});
