import { beforeAll, describe, expect, it } from "vitest";
import { ratingLineageRoot } from "@czar/hashing";
import { readSupplierCountSnapshot, refreshSupplierCounts } from "#src/selection/ranking/counts";
import { setupDatabase } from "#test/db";
import { seedDevice, TEST_USER_ID } from "#test/fixtures";

const getPool = setupDatabase();
const network = "eip155:5042002";
const serviceId = `svc_${"a".repeat(32)}`;
const versionId = `ver_${"b".repeat(32)}`;
const ratingOne = "rtg_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const ratingTwo = "rtg_01K7ZT9P4N5Q6R7S8T9V0W1X2X";
const ratingAlternate = "rtg_01K7ZT9P4N5Q6R7S8T9V0W1X2V";
const corrected = "rtg_01K7ZT9P4N5Q6R7S8T9V0W1X2W";
const objectives = [
  "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
  "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2X",
  "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2V",
];
const payer = `0x${"1".repeat(40)}`;
const payee = `0x${"2".repeat(40)}`;
const alternate = `0x${"3".repeat(40)}`;

async function seedRatedPayment(
  pool: ReturnType<ReturnType<typeof setupDatabase>>,
  objectiveId: string,
  ratingId: string,
  index: number,
  rail: "x402-exact" | "gateway-batched",
  actualPayTo: string,
): Promise<void> {
  const planId = objectiveId.replace("obj_", "pln_");
  const obsId = `obs_${index.toString(16).padStart(32, "0")}`;
  await pool.query(
    `INSERT INTO plans(plan_id,objective_id,plan,plan_hash,payee_root,state)
     VALUES($1,$2,'{}'::jsonb,'0x' || repeat('a',64),'0x' || repeat('b',64),'approved')`,
    [planId, objectiveId],
  );
  await pool.query(
    `INSERT INTO steps(plan_id,step_index,step,state)
     VALUES($1,0,$2::jsonb,'completed')`,
    [planId, JSON.stringify({ payee, serviceId })],
  );
  await pool.query("UPDATE objectives SET plan_id=$1 WHERE objective_id=$2", [planId, objectiveId]);
  await pool.query(
    `INSERT INTO observations(obs_id,user_id,vault,network,rail,service_id,version_id,
       task_class,objective_id,envelope_ref,step_index,call_index,payment_ref_hash,
       payment_id,dedup_key,settled_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,'data-json',$8,$9,0,0,
       '0x' || repeat('c',64),$10,$11,now())`,
    [
      obsId,
      TEST_USER_ID,
      payer,
      network,
      rail,
      serviceId,
      versionId,
      objectiveId,
      `${network}:${payer}:${index + 1}`,
      `payment-${index}`,
      `${rail}:${network}:${payer}:${actualPayTo}:0x${index.toString(16).padStart(64, "0")}`,
    ],
  );
  await pool.query("INSERT INTO rating_receipts(obs_id,rating_id) VALUES($1,$2)", [
    obsId,
    ratingId,
  ]);
}

beforeAll(async () => {
  const pool = getPool();
  await seedDevice(pool);
  for (const objectiveId of objectives) {
    await pool.query(
      `INSERT INTO objectives(objective_id,user_id,device_id,submission,objective_hash,state)
       VALUES($1,$2,(SELECT device_id FROM devices WHERE user_id=$2 LIMIT 1),
         '{}'::jsonb,'0x' || repeat('a',64),'delivered')`,
      [objectiveId, TEST_USER_ID],
    );
  }
  for (const [ratingId, objectiveId, value] of [
    [ratingOne, objectives[0], "good"],
    [ratingTwo, objectives[1], "good"],
    [ratingAlternate, objectives[2], "bad"],
  ]) {
    await pool.query(
      `INSERT INTO ratings(rating_id,user_id,vault,objective_id,step_index,network,
        service_id,version_id,task_class,value,surface)
       VALUES($1,$2,$3,$4,0,$5,$6,$7,'data-json',$8,'cli')`,
      [ratingId, TEST_USER_ID, payer, objectiveId, network, serviceId, versionId, value],
    );
  }
  await seedRatedPayment(pool, objectives[0]!, ratingOne, 1, "x402-exact", payee);
  await seedRatedPayment(pool, objectives[1]!, ratingTwo, 2, "gateway-batched", payee);
  await seedRatedPayment(pool, objectives[2]!, ratingAlternate, 3, "x402-exact", alternate);
});

describe("supplier count snapshots", () => {
  it("counts effective owner judgements once and replaces a correction", async () => {
    const pool = getPool();
    const options = {
      pool,
      network,
      policyVersion: `pol_${"a".repeat(16)}`,
      confidenceZ: 1.959964,
      workerId: "ranking-test",
      leaseSeconds: 300,
      now: new Date("2026-10-31T00:00:00Z"),
    };
    await refreshSupplierCounts(options);
    const read = () =>
      pool.query<{
        good: number;
        bad: number;
        owners_rated: number;
        owners_bad: number;
        lineage_root: string;
      }>("SELECT * FROM supplier_counts WHERE network=$1 AND service_id=$2", [network, serviceId]);
    expect((await read()).rows[0]).toMatchObject({
      good: 2,
      bad: 0,
      owners_rated: 1,
      owners_bad: 0,
      lineage_root: ratingLineageRoot([ratingOne, ratingTwo]),
    });
    const snapshot = await readSupplierCountSnapshot({
      pool,
      network,
      policyVersion: options.policyVersion,
      now: options.now,
      retentionDays: 30,
    });
    const stored = await pool.query<{ body_jcs: string }>(
      "SELECT body_jcs FROM selection_interim_snapshots WHERE snapshot_id=$1",
      [snapshot.snapshotId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(JSON.parse(stored.rows[0]!.body_jcs)).toHaveLength(1);
    await pool.query(
      `INSERT INTO ratings(rating_id,user_id,vault,objective_id,step_index,network,
        service_id,version_id,task_class,value,surface,supersedes)
       VALUES($1,$2,$3,$4,0,$5,$6,$7,'data-json','bad','cli',$8)`,
      [
        corrected,
        TEST_USER_ID,
        `0x${"1".repeat(40)}`,
        objectives[0],
        network,
        serviceId,
        versionId,
        ratingOne,
      ],
    );
    await pool.query("UPDATE rating_receipts SET rating_id=$1 WHERE rating_id=$2", [
      corrected,
      ratingOne,
    ]);
    await refreshSupplierCounts({ ...options, now: new Date("2026-10-31T00:01:00Z") });
    expect((await read()).rows[0]).toMatchObject({
      good: 1,
      bad: 1,
      owners_rated: 1,
      owners_bad: 1,
      lineage_root: ratingLineageRoot([corrected, ratingTwo]),
    });
    expect(
      (await pool.query("SELECT settled_at FROM observations WHERE payment_id='payment-3'")).rows[0]
        ?.settled_at,
    ).not.toBeNull();
    await pool.query(
      `INSERT INTO executor_leases(envelope_ref,worker_id,expires_at)
       VALUES($1,'other-worker','2027-01-01T00:00:00Z')`,
      [`ranking:supplier-counts:${network}`],
    );
    expect(await refreshSupplierCounts(options)).toBe(false);
  });
});
