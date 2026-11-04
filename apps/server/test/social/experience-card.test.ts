import { beforeAll, describe, expect, it } from "vitest";
import { buildExperienceCard } from "#src/social/projection/experience-card";
import { setupDatabase } from "#test/db";
import { makeObjectiveSubmission, seedDevice, TEST_USER_ID } from "#test/fixtures";

const pool = setupDatabase();
const objectiveId = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const planId = "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const serviceId = `svc_${"a".repeat(32)}`;
const versionId = `ver_${"b".repeat(32)}`;
const vault = `0x${"0".repeat(40)}`;

describe("social experience projection", () => {
  beforeAll(async () => {
    await seedDevice(pool());
    const submission = makeObjectiveSubmission(objectiveId, { subject: "Acme Corp" });
    await pool().query(
      `INSERT INTO objectives(objective_id,user_id,device_id,submission,objective_hash,state)
       VALUES($1,$2,$3,$4,$5,'delivered')`,
      [objectiveId, TEST_USER_ID, submission.deviceId, submission, submission.objectiveHash],
    );
    await pool().query(
      `INSERT INTO plans(plan_id,objective_id,plan,plan_hash,payee_root,state)
       VALUES($1,$2,'{}',$3,$3,'approved')`,
      [planId, objectiveId, `0x${"1".repeat(64)}`],
    );
    await pool().query("UPDATE objectives SET plan_id=$2 WHERE objective_id=$1", [
      objectiveId,
      planId,
    ]);
    await pool().query(
      `INSERT INTO steps(plan_id,step_index,step,state)
       VALUES($1,0,$2,'done')`,
      [planId, { capability: "web-search", kind: "api-call", serviceId, unitAmount: "15000" }],
    );
    for (const [index, delivered] of [1, 0].entries()) {
      await pool().query(
        `INSERT INTO observations(obs_id,user_id,vault,network,rail,service_id,version_id,
           task_class,objective_id,envelope_ref,step_index,call_index,payment_ref_hash,payment_id,
           dedup_key,delivered,settled_at)
         VALUES($1,$2,$3,'eip155:5042002','x402-exact',$4,$5,'data-json.search',$6,$7,
           0,$8,$9,$10,$11,$12,$13)`,
        [
          `obs_${String(index).repeat(32)}`,
          TEST_USER_ID,
          vault,
          serviceId,
          versionId,
          objectiveId,
          `eip155:5042002:${vault}:1`,
          index,
          `0x${String(index).repeat(64)}`,
          `pay-${index}`,
          `dedup-${index}`,
          delivered,
          new Date("2026-11-05T13:24:11Z"),
        ],
      );
    }
    await pool().query(
      `INSERT INTO ratings(rating_id,user_id,vault,objective_id,step_index,network,service_id,
         version_id,task_class,value,surface)
       VALUES($1,$2,$3,$4,0,'eip155:5042002',$5,$6,'data-json.search','good','web')`,
      [`rtg_${"A".repeat(26)}`, TEST_USER_ID, vault, objectiveId, serviceId, versionId],
    );
  });

  it("builds one public card per settled step with private links kept separately", async () => {
    const result = await buildExperienceCard(pool(), objectiveId, 0);
    expect(result?.card).toMatchObject({
      supplierKind: "x402",
      serviceId,
      versionId,
      deliveryOutcome: "partial",
      rating: "good",
      callsPaid: 2,
      callsDelivered: 1,
      amountBand: "0.01-0.1",
      observedAt: "2026-11-05T00:00:00Z",
    });
    expect(result?.observationIds).toHaveLength(2);
    expect(JSON.stringify(result?.card)).not.toMatch(/Acme|obs_|pricing|0x/);
  });
});
