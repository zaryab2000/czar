import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupDatabase } from "#test/db";
import { makeObjectiveSubmission, seedDevice, TEST_USER_ID } from "#test/fixtures";
import {
  fillResponse,
  insertAtSign,
  markReleased,
  markSettled,
  setJobState,
} from "#src/evidence/observations";
import { clearFacts, isInjectionBlocked, openOwnerFacts, writeFacts } from "#src/evidence/health";

const getPool = setupDatabase();
const OBJECTIVE_ID = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const PLAN_ID = "pln_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const VAULT = "0x0000000000000000000000000000000000000001" as const;
const PAYEE = "0x0000000000000000000000000000000000000002" as const;
const SERVICE_ID = `svc_${"3".repeat(32)}`;
const ENVELOPE_REF = `eip155:5042002:${VAULT}:1`;
const AT = new Date();

async function sign(index: number) {
  return insertAtSign(getPool(), {
    userId: TEST_USER_ID,
    vault: VAULT,
    network: "eip155:5042002",
    rail: "x402-exact",
    serviceId: SERVICE_ID,
    versionId: "ver_unknown",
    taskClass: "data-json.search",
    objectiveId: OBJECTIVE_ID,
    envelopeRef: ENVELOPE_REF,
    stepIndex: 0,
    paymentRef: {
      schemaVersion: "1.0",
      rail: "x402-exact",
      network: "eip155:5042002",
      asset: "0x0000000000000000000000000000000000000003",
      payer: VAULT,
      payTo: PAYEE,
      amount: "1000",
      nonce: `0x${index.toString(16).padStart(64, "0")}` as const,
      validBefore: 1_800_000_000,
      reservationId: 9,
      index,
    },
    paymentId: `pay_${index.toString(16).padStart(32, "0")}`,
  });
}

async function openJob(index: number) {
  return insertAtSign(getPool(), {
    userId: TEST_USER_ID,
    vault: VAULT,
    network: "eip155:5042002",
    rail: "erc8183-job",
    serviceId: SERVICE_ID,
    versionId: "ver_unknown",
    taskClass: "data-json.extract",
    objectiveId: OBJECTIVE_ID,
    envelopeRef: ENVELOPE_REF,
    stepIndex: 0,
    paymentRef: {
      schemaVersion: "1.0",
      rail: "erc8183-job",
      network: "eip155:5042002",
      contract: "0x0000000000000000000000000000000000000004",
      jobId: String(index),
      client: VAULT,
      provider: PAYEE,
      evaluator: "0x0000000000000000000000000000000000000005",
      budget: "1000",
    },
    paymentId: `pay_${index.toString(16).padStart(32, "0")}`,
  });
}

beforeAll(async () => seedDevice(getPool()));
beforeEach(async () => {
  await getPool().query("DELETE FROM supplier_health");
  await getPool().query("DELETE FROM observations");
  await getPool().query("DELETE FROM step_executions");
  await getPool().query("DELETE FROM steps");
  await getPool().query("DELETE FROM plans");
  await getPool().query("DELETE FROM objectives");
  const submission = makeObjectiveSubmission(OBJECTIVE_ID);
  await getPool().query(
    `INSERT INTO objectives (objective_id,user_id,device_id,submission,objective_hash,state,envelope_ref)
     VALUES ($1,$2,$3,$4::jsonb,$5,'executing',$6)`,
    [
      OBJECTIVE_ID,
      TEST_USER_ID,
      submission.deviceId,
      JSON.stringify(submission),
      submission.objectiveHash,
      ENVELOPE_REF,
    ],
  );
  await getPool().query(
    `INSERT INTO plans (plan_id,objective_id,plan,plan_hash,payee_root,state)
     VALUES ($1,$2,'{}',$3,$4,'approved')`,
    [PLAN_ID, OBJECTIVE_ID, `0x${"1".repeat(64)}`, `0x${"2".repeat(64)}`],
  );
  await getPool().query("UPDATE objectives SET plan_id=$2 WHERE objective_id=$1", [
    OBJECTIVE_ID,
    PLAN_ID,
  ]);
});

describe("persisted supplier health", () => {
  it("writes H1 once whether delivery failure precedes or follows settlement", async () => {
    const before = await sign(1);
    await fillResponse(getPool(), before, AT, 0);
    await markSettled(getPool(), before, AT);
    await markSettled(getPool(), before, AT);
    const after = await sign(2);
    await markSettled(getPool(), after, AT);
    await fillResponse(getPool(), after, AT, 0);
    const facts = await getPool().query<{ obs_id: string }>(
      "SELECT obs_id FROM supplier_health WHERE fact='settled-not-delivered' ORDER BY obs_id",
    );
    expect(new Set(facts.rows.map((row) => row.obs_id))).toEqual(new Set([before, after]));
  });

  it("writes H2 after three releases, not two, and resets after a settlement", async () => {
    const first = await sign(1);
    const second = await sign(2);
    await markReleased(getPool(), first, AT);
    await markReleased(getPool(), second, AT);
    expect(await openOwnerFacts(getPool(), TEST_USER_ID, "eip155:5042002", SERVICE_ID)).toEqual([]);
    const third = await sign(3);
    await markReleased(getPool(), third, AT);
    expect(await openOwnerFacts(getPool(), TEST_USER_ID, "eip155:5042002", SERVICE_ID)).toEqual([
      "repeated-unsettled-failure",
    ]);
    const paid = await sign(4);
    await fillResponse(getPool(), paid, AT, 1);
    await markSettled(getPool(), paid, new Date(AT.getTime() + 1_000));
    expect(await openOwnerFacts(getPool(), TEST_USER_ID, "eip155:5042002", SERVICE_ID)).toEqual([]);
    const later = await sign(5);
    await markReleased(getPool(), later, AT);
    const count = await getPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM supplier_health WHERE fact='repeated-unsettled-failure'",
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("does not count a traced expired-resume release toward H2", async () => {
    const first = await sign(1);
    const second = await sign(2);
    const third = await sign(3);
    await getPool().query(
      "INSERT INTO steps (plan_id,step_index,step,state) VALUES ($1,0,'{}','offered')",
      [PLAN_ID],
    );
    await getPool().query(
      `INSERT INTO step_executions (plan_id,step_index,attempt,phase,payload)
       VALUES ($1,0,0,'auth.signed',$2::jsonb),($1,0,0,'call.unpaid',$3::jsonb)`,
      [
        PLAN_ID,
        JSON.stringify({ index: 1, paymentId: `pay_${"1".padStart(32, "0")}` }),
        JSON.stringify({ index: 1, errorCode: "authorization-expired" }),
      ],
    );
    for (const id of [first, second, third]) await markReleased(getPool(), id, AT);
    expect(await openOwnerFacts(getPool(), TEST_USER_ID, "eip155:5042002", SERVICE_ID)).toEqual([]);
  });

  it("clears owner facts only with a later explicitly approved delivered settlement", async () => {
    const failed = await sign(1);
    await fillResponse(getPool(), failed, AT, 0);
    await markSettled(getPool(), failed, AT);
    const success = await sign(2);
    await fillResponse(getPool(), success, AT, 1);
    await markSettled(getPool(), success, new Date(AT.getTime() + 1_000));
    await clearFacts(getPool(), success);
    expect(await openOwnerFacts(getPool(), TEST_USER_ID, "eip155:5042002", SERVICE_ID)).toEqual([]);
    const cleared = await getPool().query<{ cleared_by_obs_id: string }>(
      "SELECT cleared_by_obs_id FROM supplier_health WHERE obs_id=$1",
      [failed],
    );
    expect(cleared.rows[0]?.cleared_by_obs_id).toBe(success);
  });

  it("clears H3 after a later approved job completes, in either fact ordering", async () => {
    const failed = await openJob(1);
    await writeFacts(getPool(), [{ fact: "job-failed", obsId: failed }]);
    const firstSuccess = await openJob(2);
    await markSettled(getPool(), firstSuccess, new Date(AT.getTime() + 1_000));
    await setJobState(getPool(), firstSuccess, "Completed", AT);
    expect(await openOwnerFacts(getPool(), TEST_USER_ID, "eip155:5042002", SERVICE_ID)).toEqual([]);

    const laterFailure = await openJob(3);
    await writeFacts(getPool(), [{ fact: "job-failed", obsId: laterFailure }]);
    const secondSuccess = await openJob(4);
    await setJobState(getPool(), secondSuccess, "Completed", AT);
    await markSettled(getPool(), secondSuccess, new Date(AT.getTime() + 2_000));
    expect(await openOwnerFacts(getPool(), TEST_USER_ID, "eip155:5042002", SERVICE_ID)).toEqual([]);
  });

  it("stores H4 idempotently and excludes the supplier while uncleared", async () => {
    const id = await sign(1);
    await writeFacts(getPool(), [{ fact: "injection-blocked", obsId: id }]);
    await writeFacts(getPool(), [{ fact: "injection-blocked", obsId: id }]);
    expect(await isInjectionBlocked(getPool(), "eip155:5042002", SERVICE_ID)).toBe(true);
    const count = await getPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM supplier_health WHERE fact='injection-blocked'",
    );
    expect(count.rows[0]?.count).toBe("1");
  });
});
