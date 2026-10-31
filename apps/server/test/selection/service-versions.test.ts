import { beforeAll, describe, expect, it } from "vitest";
import { recordServiceVersion } from "#src/selection/service-versions";
import { setupDatabase } from "#test/db";
import { seedDevice, TEST_USER_ID } from "#test/fixtures";

const getPool = setupDatabase();
const network = "eip155:5042002";
const serviceId = `svc_${"a".repeat(32)}`;
const versionA = `ver_${"a".repeat(32)}`;
const versionB = `ver_${"b".repeat(32)}`;
const objectiveId = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const obsId = `obs_${"a".repeat(32)}`;
const vault = `0x${"1".repeat(40)}`;

beforeAll(async () => {
  const pool = getPool();
  await seedDevice(pool);
  await pool.query(
    `INSERT INTO objectives(objective_id,user_id,device_id,submission,objective_hash,state)
     VALUES($1,$2,(SELECT device_id FROM devices WHERE user_id=$2 LIMIT 1),
       '{}'::jsonb,'0x' || repeat('a',64),'delivered')`,
    [objectiveId, TEST_USER_ID],
  );
});

describe("SCR-163 service version ledger", () => {
  it("upserts probe sightings and clears old H4 only on a new version", async () => {
    const pool = getPool();
    const first = new Date("2026-10-31T00:00:00Z");
    const second = new Date("2026-10-31T00:01:00Z");
    const third = new Date("2026-10-31T00:02:00Z");
    await recordServiceVersion({ pool, network, serviceId, versionId: versionA, now: first });
    await pool.query(
      `INSERT INTO observations(obs_id,user_id,vault,network,rail,service_id,version_id,
         task_class,objective_id,envelope_ref,step_index,call_index,payment_ref_hash,
         payment_id,dedup_key)
       VALUES($1,$2,$3,$4,'x402-exact',$5,$6,'data-json',$7,$8,0,0,
         '0x' || repeat('b',64),'payment-a',$9)`,
      [
        obsId,
        TEST_USER_ID,
        vault,
        network,
        serviceId,
        versionA,
        objectiveId,
        `${network}:${vault}:1`,
        `x402-exact:${network}:${vault}:${vault}:0x${"c".repeat(64)}`,
      ],
    );
    await pool.query(
      `INSERT INTO supplier_health(fact,obs_id,user_id,network,service_id,version_id)
       VALUES('injection-blocked',$1,$2,$3,$4,$5)`,
      [obsId, TEST_USER_ID, network, serviceId, versionA],
    );
    await recordServiceVersion({ pool, network, serviceId, versionId: versionA, now: second });
    const firstRow = await pool.query<{
      first_seen_at: Date;
      last_seen_at: Date;
    }>("SELECT first_seen_at,last_seen_at FROM service_versions WHERE version_id=$1", [versionA]);
    expect(firstRow.rows).toEqual([{ first_seen_at: first, last_seen_at: second }]);
    expect(
      (await pool.query("SELECT cleared_at FROM supplier_health WHERE obs_id=$1", [obsId])).rows[0]
        ?.cleared_at,
    ).toBeNull();
    await recordServiceVersion({ pool, network, serviceId, versionId: versionB, now: third });
    expect(
      (await pool.query("SELECT cleared_at FROM supplier_health WHERE obs_id=$1", [obsId])).rows[0]
        ?.cleared_at,
    ).toEqual(third);
    expect(
      (
        await pool.query("SELECT version_id FROM service_versions WHERE service_id=$1", [serviceId])
      ).rows
        .map((row) => row.version_id)
        .toSorted(),
    ).toEqual([versionA, versionB]);
  });
});
