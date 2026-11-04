import { createHash } from "node:crypto";
import { loadConfig } from "@czar/config";
import { describe, expect, it } from "vitest";
import { evaluateIncidents, openIncidentsFor } from "#src/social/incidents";
import { getIncident, getThread, listIncidents, listThreads } from "#src/social/threads";
import { setupDatabase } from "#test/db";

const getPool = setupDatabase();
const NETWORK = "eip155:5042002";
const SERVICE = `svc_${"a".repeat(32)}`;
const VERSION = `ver_${"a".repeat(32)}`;
const NEXT_VERSION = `ver_${"b".repeat(32)}`;
const AT = new Date("2026-11-05T00:00:00.000Z");
const config = loadConfig();

function ownerId(index: number): string {
  return `usr_${String(index).padStart(26, "0")}`;
}

function objectiveId(index: number): string {
  return `obj_${String(index).padStart(26, "0")}`;
}

async function seedOwner(index: number): Promise<void> {
  const user = ownerId(index);
  const device = `dev_${String(index).padStart(26, "0")}`;
  await getPool().query("INSERT INTO users(user_id) VALUES($1)", [user]);
  await getPool().query(
    `INSERT INTO devices(device_id,user_id,device_name,platform,token_hash)
     VALUES($1,$2,'Test','linux',$3)`,
    [device, user, Buffer.alloc(32, index)],
  );
  await getPool().query(
    `INSERT INTO objectives(objective_id,user_id,device_id,submission,objective_hash,state)
     VALUES($1,$2,$3,$4,$5,'planning')`,
    [
      objectiveId(index),
      user,
      device,
      JSON.stringify({ capabilities: ["web-search"], taskSpec: { kind: "table-fill" } }),
      `0x${"a".repeat(64)}`,
    ],
  );
}

async function observation(
  owner: number,
  ordinal: number,
  service = SERVICE,
  version = VERSION,
  delivered = 0,
  settledAt = AT,
  taskClass = "web-search",
): Promise<string> {
  const obsId = `obs_${ordinal.toString(16).padStart(32, "0")}`;
  await getPool().query(
    `INSERT INTO observations(obs_id,user_id,vault,network,rail,service_id,version_id,
       task_class,objective_id,envelope_ref,step_index,call_index,payment_ref_hash,
       payment_id,dedup_key,delivered,settled_at)
     VALUES($1,$2,$3,$4,'x402-exact',$5,$6,$7,$8,$9,0,$10,$11,$12,$13,$14,$15)`,
    [
      obsId,
      ownerId(owner),
      `0x${"1".repeat(40)}`,
      NETWORK,
      service,
      version,
      taskClass,
      objectiveId(owner),
      `eip155:5042002:0x${"1".repeat(40)}:1`,
      ordinal,
      `0x${ordinal.toString(16).padStart(64, "0")}`,
      `pay_${ordinal}`,
      `dedup_${ordinal}`,
      delivered,
      settledAt,
    ],
  );
  return obsId;
}

async function rateGood(owner: number, ordinal: number, obsIds: string[]): Promise<void> {
  const ratingId = `rtg_${ordinal.toString().padStart(26, "0")}`;
  await getPool().query(
    `INSERT INTO ratings(rating_id,user_id,vault,objective_id,step_index,network,
       service_id,version_id,task_class,value,surface)
     VALUES($1,$2,$3,$4,0,$5,$6,$7,'web-search','good','web')`,
    [
      ratingId,
      ownerId(owner),
      `0x${"1".repeat(40)}`,
      objectiveId(owner),
      NETWORK,
      SERVICE,
      VERSION,
    ],
  );
  for (const obsId of obsIds)
    await getPool().query("INSERT INTO rating_receipts(obs_id,rating_id) VALUES($1,$2)", [
      obsId,
      ratingId,
    ]);
}

async function seenVersion(service: string, version: string, at: Date): Promise<void> {
  await getPool().query(
    `INSERT INTO service_versions(network,service_id,version_id,first_seen_at,last_seen_at)
     VALUES($1,$2,$3,$4,$4)`,
    [NETWORK, service, version, at],
  );
}

describe("SN-4 incident evidence", () => {
  it("opens at three owners, updates units, recovers, and does not flap", async () => {
    for (const index of [1, 2, 3]) await seedOwner(index);
    for (const index of [1, 2, 3]) await observation(index, index);
    await evaluateIncidents(getPool(), config, AT);
    let incidents = await openIncidentsFor(getPool(), NETWORK, [SERVICE], "web-search");
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ distinctOwners: 3, negativeUnits: 3 });
    const actionId = createHash("sha256")
      .update("system")
      .update("system.incident.opened")
      .update(incidents[0]!.incidentId)
      .update("opened")
      .digest("hex");
    const systemPosts = await getPool().query(
      "SELECT action_id FROM social_posts WHERE action_id=$1",
      [actionId],
    );
    expect(systemPosts.rowCount).toBe(1);
    await observation(1, 4);
    await evaluateIncidents(getPool(), config, AT);
    incidents = await openIncidentsFor(getPool(), NETWORK, [SERVICE], "web-search");
    expect(incidents[0]).toMatchObject({ distinctOwners: 3, negativeUnits: 4 });
    const later = new Date(AT.getTime() + 60_000);
    const goodForOne = await Promise.all(
      [5, 6, 7].map((i) => observation(1, i, SERVICE, VERSION, 1, later)),
    );
    const goodForTwo = await Promise.all(
      [8, 9].map((i) => observation(2, i, SERVICE, VERSION, 1, later)),
    );
    await rateGood(1, 1, goodForOne);
    await rateGood(2, 2, goodForTwo);
    await evaluateIncidents(getPool(), config, later);
    expect(await openIncidentsFor(getPool(), NETWORK, [SERVICE], "web-search")).toHaveLength(0);
    await evaluateIncidents(getPool(), config, later);
    const history = await getPool().query("SELECT state,close_reason FROM social_incidents");
    expect(history.rows).toEqual([{ state: "closed", close_reason: "recovered" }]);
  });

  it("closes a known version on use of a new one but keeps ver_unknown open", async () => {
    for (const index of [4, 5, 6]) await seedOwner(index);
    const unknownService = `svc_${"c".repeat(32)}`;
    await seenVersion(SERVICE, VERSION, new Date(AT.getTime() - 60_000));
    for (const index of [4, 5, 6]) {
      await observation(index, index + 10, SERVICE, VERSION);
      await observation(index, index + 20, unknownService, "ver_unknown");
    }
    await evaluateIncidents(getPool(), config, AT);
    const later = new Date(AT.getTime() + 60_000);
    await seenVersion(SERVICE, NEXT_VERSION, later);
    await observation(4, 40, SERVICE, NEXT_VERSION, 1, later);
    await observation(4, 41, unknownService, NEXT_VERSION, 1, later);
    await evaluateIncidents(getPool(), config, later);
    expect(await openIncidentsFor(getPool(), NETWORK, [SERVICE], "web-search")).toHaveLength(0);
    const unknown = await openIncidentsFor(getPool(), NETWORK, [unknownService], "web-search");
    expect(unknown[0]?.versionId).toBe("ver_unknown");
  });

  it("uses verified first-seen chronology, not another version's later payment time", async () => {
    for (const index of [7, 8, 9]) await seedOwner(index);
    const service = `svc_${"d".repeat(32)}`;
    const older = new Date(AT.getTime() - 120_000);
    await seenVersion(service, NEXT_VERSION, older);
    await seenVersion(service, VERSION, new Date(AT.getTime() - 60_000));
    await observation(7, 77, service, VERSION, 0, AT);
    await observation(7, 70, service, NEXT_VERSION, 1, new Date(AT.getTime() + 1_000));
    for (const index of [8, 9])
      await observation(index, index + 70, service, VERSION, 0, new Date(AT.getTime() + 2_000));
    await evaluateIncidents(getPool(), config, new Date(AT.getTime() + 3_000));
    const incidents = await openIncidentsFor(getPool(), NETWORK, [service], "web-search");
    expect(incidents).toMatchObject([{ versionId: VERSION, distinctOwners: 3 }]);
  });

  it("does not publish private identifiers inside incident system cards", async () => {
    for (const index of [10, 11, 12]) await seedOwner(index);
    const privateService = `svc_${"e".repeat(32)}`;
    for (const index of [10, 11, 12])
      await observation(index, index + 90, privateService, VERSION, 0, AT, "obs_private-id");
    await evaluateIncidents(getPool(), config, AT);
    expect(
      await openIncidentsFor(getPool(), NETWORK, [privateService], "obs_private-id"),
    ).toHaveLength(1);
    const incident = await getPool().query<{ incident_id: string; thread_id: string }>(
      "SELECT incident_id,thread_id FROM social_incidents WHERE service_id=$1",
      [privateService],
    );
    const ids = incident.rows[0];
    expect(ids).toBeDefined();
    if (!ids) return;
    expect(await getIncident(getPool(), ids.incident_id)).toBeNull();
    expect(await getThread(getPool(), ids.thread_id)).toBeNull();
    const incidents = await listIncidents(getPool(), { limit: 100 });
    const threads = await listThreads(getPool(), { limit: 100 });
    expect(incidents.items.some((item) => item["incidentId"] === ids.incident_id)).toBe(false);
    expect(threads.items.some((item) => item.threadId === ids.thread_id)).toBe(false);
    const posts = await getPool().query<{ card: Record<string, unknown> }>(
      "SELECT card FROM social_posts WHERE kind='system'",
    );
    expect(posts.rows.every((row) => !JSON.stringify(row.card).includes("obs_private-id"))).toBe(
      true,
    );
  });
});
