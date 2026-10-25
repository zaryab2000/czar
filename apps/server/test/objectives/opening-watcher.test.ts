import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@czar/config";
import { setupDatabase } from "#test/db";
import { makeObjectiveSubmission, seedDevice, TEST_USER_ID } from "#test/fixtures";
import {
  createIndexerOpeningLookup,
  pollOpeningObjectives,
  startOpeningWatcher,
  type OpeningEnvelope,
} from "#src/objectives/opening-watcher";

const pool = setupDatabase();
const OBJECTIVE = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const PLAN_ID = "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const VAULT = "0x0000000000000000000000000000000000000001";
const OTHER_VAULT = "0x0000000000000000000000000000000000000002";
const PLAN_HASH = `0x${"1".repeat(64)}`;

async function seedOpeningObjective(expiresAt: string): Promise<void> {
  const submission = makeObjectiveSubmission(OBJECTIVE);
  await pool().query("UPDATE users SET vault=$1 WHERE user_id=$2", [VAULT, TEST_USER_ID]);
  await pool().query(
    `INSERT INTO objectives
       (objective_id,user_id,device_id,submission,objective_hash,state,created_at,updated_at)
     VALUES ($1,$2,$3,$4::jsonb,$5,'opening',$6,$6)`,
    [
      OBJECTIVE,
      TEST_USER_ID,
      submission.deviceId,
      JSON.stringify(submission),
      submission.objectiveHash,
      new Date("2026-10-21T00:00:00Z"),
    ],
  );
  await pool().query(
    `INSERT INTO plans (plan_id,objective_id,plan,plan_hash,payee_root,state,created_at,updated_at)
     VALUES ($1,$2,$3::jsonb,$4,$5,'approved',$6,$6)`,
    [
      PLAN_ID,
      OBJECTIVE,
      JSON.stringify({ expiresAt }),
      PLAN_HASH,
      `0x${"2".repeat(64)}`,
      new Date("2026-10-21T00:00:00Z"),
    ],
  );
  await pool().query("UPDATE objectives SET plan_id=$2 WHERE objective_id=$1", [
    OBJECTIVE,
    PLAN_ID,
  ]);
}

function dependencies(lookup: (hash: string) => Promise<OpeningEnvelope | null>, now: Date) {
  return {
    pool: pool(),
    config: loadConfig(),
    lookup: { envelopeByPlanHash: lookup },
    now: () => now,
  };
}

describe("opening watcher", () => {
  beforeAll(async () => seedDevice(pool()));

  beforeEach(async () => {
    await pool().query("DELETE FROM outbox_events");
    await pool().query("DELETE FROM steps");
    await pool().query("DELETE FROM plans");
    await pool().query("DELETE FROM objectives");
    await pool().query("UPDATE users SET vault=NULL WHERE user_id=$1", [TEST_USER_ID]);
  });

  it("looks up an envelope by plan hash through the indexer query route", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        envelope: {
          envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:7",
          vault: VAULT,
          planHash: PLAN_HASH,
          status: "Open",
        },
        reservations: [],
        pockets: [],
        jobs: [],
      }),
    );
    const lookup = createIndexerOpeningLookup("http://127.0.0.1:42069", 2_000, fetcher);

    await expect(lookup.envelopeByPlanHash(PLAN_HASH)).resolves.toMatchObject({
      envelope: { vault: VAULT, planHash: PLAN_HASH, status: "Open" },
    });
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).href).toBe(`http://127.0.0.1:42069/envelopes/by-plan-hash/${PLAN_HASH}`);
    expect(options.method).toBe("GET");
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("keeps a timed-out approval matchable and matches only the user's open envelope", async () => {
    await seedOpeningObjective("2026-10-23T00:00:00.000Z");
    const lookup = vi.fn(async () => ({
      envelope: {
        envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:7",
        vault: OTHER_VAULT,
        planHash: PLAN_HASH,
        status: "Open",
      },
    }));

    await pollOpeningObjectives(dependencies(lookup, new Date("2026-10-21T00:16:00Z")));
    expect(lookup).toHaveBeenCalledOnce();
    await expect(
      pool().query("SELECT state FROM objectives WHERE objective_id=$1", [OBJECTIVE]),
    ).resolves.toMatchObject({ rows: [{ state: "awaiting-approval" }] });
    await expect(
      pool().query("SELECT state FROM plans WHERE plan_id=$1", [PLAN_ID]),
    ).resolves.toMatchObject({
      rows: [{ state: "approved" }],
    });

    lookup.mockResolvedValue({
      envelope: {
        envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:7",
        vault: VAULT,
        planHash: PLAN_HASH,
        status: "Closed",
      },
    });
    await pollOpeningObjectives(dependencies(lookup, new Date("2026-10-21T00:16:30Z")));
    await expect(
      pool().query("SELECT state FROM objectives WHERE objective_id=$1", [OBJECTIVE]),
    ).resolves.toMatchObject({ rows: [{ state: "awaiting-approval" }] });

    lookup.mockResolvedValue({
      envelope: {
        envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:7",
        vault: VAULT,
        planHash: PLAN_HASH,
        status: "Open",
      },
    });
    await pollOpeningObjectives(dependencies(lookup, new Date("2026-10-21T00:17:00Z")));
    await expect(
      pool().query("SELECT state,envelope_ref FROM objectives WHERE objective_id=$1", [OBJECTIVE]),
    ).resolves.toMatchObject({
      rows: [
        {
          state: "executing",
          envelope_ref: "eip155:5042002:0x0000000000000000000000000000000000000001:7",
        },
      ],
    });
    await expect(
      pool().query("SELECT name,payload FROM outbox_events WHERE name='plan.approved'"),
    ).resolves.toMatchObject({
      rows: [
        { name: "plan.approved", payload: { planId: PLAN_ID, envelopeRef: expect.any(String) } },
      ],
    });
  });

  it("expires the approved plan and objective at expiresAt without a match", async () => {
    await seedOpeningObjective("2026-10-21T00:00:00.000Z");
    const lookup = vi.fn(async () => null);
    await pollOpeningObjectives(dependencies(lookup, new Date("2026-10-21T00:00:00Z")));
    expect(lookup).not.toHaveBeenCalled();

    await expect(
      pool().query("SELECT state FROM objectives WHERE objective_id=$1", [OBJECTIVE]),
    ).resolves.toMatchObject({
      rows: [{ state: "expired" }],
    });
    await expect(
      pool().query("SELECT state FROM plans WHERE plan_id=$1", [PLAN_ID]),
    ).resolves.toMatchObject({
      rows: [{ state: "expired" }],
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("runs its initial poll and stop waits for the opening match to finish", async () => {
    await seedOpeningObjective("2026-10-23T00:00:00.000Z");
    let resolveLookup: ((value: OpeningEnvelope | null) => void) | undefined;
    const lookup = vi.fn(
      () =>
        new Promise<OpeningEnvelope | null>((resolve) => {
          resolveLookup = resolve;
        }),
    );
    const watcher = startOpeningWatcher(dependencies(lookup, new Date("2026-10-21T00:01:00Z")));
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());

    let stopped = false;
    const stopping = watcher.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    if (!resolveLookup) throw new Error("Opening lookup did not start.");
    resolveLookup({
      envelope: {
        envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:7",
        vault: VAULT,
        planHash: PLAN_HASH,
        status: "Open",
      },
    });
    await stopping;

    await expect(
      pool().query("SELECT state,envelope_ref FROM objectives WHERE objective_id=$1", [OBJECTIVE]),
    ).resolves.toMatchObject({
      rows: [
        {
          state: "executing",
          envelope_ref: "eip155:5042002:0x0000000000000000000000000000000000000001:7",
        },
      ],
    });
  });
});
