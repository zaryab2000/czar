import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { claimNextInbox, retryInbox } from "#src/social/inbox";
import { findOrCreateRepresentative } from "#src/social/representatives";
import { setupDatabase } from "#test/db";
import { seedDevice, TEST_USER_ID } from "#test/fixtures";

const pool = setupDatabase();
const now = new Date("2026-11-05T12:00:00Z");
const random = { bytes: randomBytes };
let representativeId = "";

describe("social inbox leases", () => {
  beforeAll(async () => {
    await seedDevice(pool());
    representativeId = (await findOrCreateRepresentative(pool(), TEST_USER_ID, random))
      .representative_id;
    const event = await pool().query<{ event_id: string }>(
      "INSERT INTO outbox_events(name,payload) VALUES('ignored.fixture','{}') RETURNING event_id",
    );
    await pool().query(
      "INSERT INTO social_inbox(representative_id,event_id,kind,refs) VALUES($1,$2,'post-routed','{}')",
      [representativeId, event.rows[0]?.event_id],
    );
  });

  it("lets one worker claim and reclaims after the lease expires", async () => {
    const claimed = await Promise.all([
      claimNextInbox(pool(), now, 120_000, random),
      claimNextInbox(pool(), now, 120_000, random),
    ]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
    const first = claimed.find(Boolean)!;
    expect(first.attempts).toBe(1);
    expect(await claimNextInbox(pool(), now, 120_000, random)).toBeNull();
    const reclaimed = await claimNextInbox(
      pool(),
      new Date(now.getTime() + 120_001),
      120_000,
      random,
    );
    expect(reclaimed?.inbox_id).toBe(first.inbox_id);
    expect(reclaimed?.lease_token).not.toBe(first.lease_token);
    expect(reclaimed?.attempts).toBe(2);
  });

  it("backs off a transient item and fails it at the attempt cap", async () => {
    const active = await pool().query<{ inbox_id: string; lease_token: string }>(
      "SELECT inbox_id,lease_token FROM social_inbox WHERE representative_id=$1",
      [representativeId],
    );
    const row = active.rows[0]!;
    expect(
      await retryInbox(pool(), {
        inboxId: row.inbox_id,
        leaseToken: row.lease_token,
        now,
        baseMs: 5_000,
        maxMs: 600_000,
        maxAttempts: 2,
      }),
    ).toBe(true);
    const state = await pool().query<{ state: string; stop_reason: string }>(
      "SELECT state,stop_reason FROM social_inbox WHERE inbox_id=$1",
      [row.inbox_id],
    );
    expect(state.rows).toEqual([{ state: "failed", stop_reason: "failed-permanent" }]);
  });
});
