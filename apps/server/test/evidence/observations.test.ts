import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dedupKey, obsId, paymentRefHash } from "@czar/hashing";
import type { PaymentRef } from "@czar/schemas";
import { setupDatabase } from "#test/db";
import { makeObjectiveSubmission, seedDevice, TEST_USER_ID } from "#test/fixtures";
import {
  fillResponse,
  getObservation,
  insertAtSign,
  markReleased,
  markSettled,
  setJobState,
} from "#src/evidence/observations";

const getPool = setupDatabase();
const OBJECTIVE_ID = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const VAULT = "0x0000000000000000000000000000000000000001" as const;
const PAYEE = "0x0000000000000000000000000000000000000002" as const;
const ENVELOPE_REF = `eip155:5042002:${VAULT}:1`;
const AT = new Date("2026-10-31T00:00:00.000Z");

function paymentRef(nonce: string): PaymentRef {
  return {
    schemaVersion: "1.0",
    rail: "x402-exact",
    network: "eip155:5042002",
    asset: "0x0000000000000000000000000000000000000003",
    payer: VAULT,
    payTo: PAYEE,
    amount: "1000",
    nonce: `0x${nonce}`,
    validBefore: 1_800_000_000,
    reservationId: 9,
    index: 0,
  };
}

function signedInput(nonce: string, callIndex = 0) {
  return {
    userId: TEST_USER_ID,
    vault: VAULT,
    network: "eip155:5042002",
    rail: "x402-exact" as const,
    serviceId: "svc_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
    versionId: "ver_unknown",
    taskClass: "data-json.search",
    objectiveId: OBJECTIVE_ID,
    envelopeRef: ENVELOPE_REF,
    stepIndex: 0,
    callIndex,
    paymentRef: paymentRef(nonce),
    paymentId: `payment-${callIndex}`,
  };
}

beforeAll(async () => seedDevice(getPool()));
beforeEach(async () => {
  await getPool().query("DELETE FROM observations");
  await getPool().query("DELETE FROM objectives");
  await getPool().query("UPDATE users SET controlled=false WHERE user_id=$1", [TEST_USER_ID]);
  const submission = makeObjectiveSubmission(OBJECTIVE_ID);
  await getPool().query(
    `INSERT INTO objectives (objective_id,user_id,device_id,submission,objective_hash,state)
     VALUES ($1,$2,$3,$4::jsonb,$5,'executing')`,
    [
      OBJECTIVE_ID,
      TEST_USER_ID,
      submission.deviceId,
      JSON.stringify(submission),
      submission.objectiveHash,
    ],
  );
});

describe("payment observations (SCR-160 §14.1–2)", () => {
  it("inserts once at signing and re-derives the same identity after a crash", async () => {
    const input = signedInput("11".repeat(32));
    const expectedId = obsId(dedupKey(input.paymentRef));
    // The first process died after auth.signed and before the insert. Resume sees the saved payment.
    expect(await getObservation(getPool(), expectedId)).toBeNull();

    expect(await insertAtSign(getPool(), input)).toBe(expectedId);
    const first = await getPool().query<{ ctid: string }>(
      "SELECT ctid::text AS ctid FROM observations WHERE obs_id=$1",
      [expectedId],
    );
    expect(await insertAtSign(getPool(), input)).toBe(expectedId);
    const second = await getPool().query<{ ctid: string }>(
      "SELECT ctid::text AS ctid FROM observations WHERE obs_id=$1",
      [expectedId],
    );
    expect(second.rows[0]?.ctid).toBe(first.rows[0]?.ctid);
    expect(await getObservation(getPool(), expectedId)).toMatchObject({
      obsId: expectedId,
      paymentRefHash: paymentRefHash(input.paymentRef),
      settledAt: null,
      releasedAt: null,
      respondedAt: null,
      delivered: null,
      controlled: false,
    });
  });

  it("fills response and chain settlement once without overwriting first facts", async () => {
    const input = signedInput("22".repeat(32));
    const id = await insertAtSign(getPool(), input);
    await fillResponse(getPool(), id, AT, 1);
    await fillResponse(getPool(), id, new Date(AT.getTime() + 1_000), 0);
    await markSettled(getPool(), id, AT, `0x${"44".repeat(32)}`);
    await markSettled(getPool(), id, new Date(AT.getTime() + 1_000), `0x${"55".repeat(32)}`);
    expect(await getObservation(getPool(), id)).toMatchObject({
      delivered: 1,
      respondedAt: AT,
      settledAt: AT,
      settlementTx: `0x${"44".repeat(32)}`,
      releasedAt: null,
    });
  });

  it("keeps an unused authorization released and a silent settled call undelivered", async () => {
    const released = await insertAtSign(getPool(), signedInput("33".repeat(32)));
    const silent = await insertAtSign(getPool(), signedInput("44".repeat(32), 1));
    await markReleased(getPool(), released, AT);
    await markSettled(getPool(), silent, AT);
    await fillResponse(getPool(), silent, undefined, 0);
    expect(await getObservation(getPool(), released)).toMatchObject({
      settledAt: null,
      releasedAt: AT,
    });
    expect(await getObservation(getPool(), silent)).toMatchObject({
      settledAt: AT,
      delivered: 0,
      respondedAt: null,
    });
  });

  it("copies the controlled flag at insert and advances a job state", async () => {
    await getPool().query("UPDATE users SET controlled=true WHERE user_id=$1", [TEST_USER_ID]);
    const id = await insertAtSign(getPool(), signedInput("55".repeat(32)));
    await setJobState(getPool(), id, "Funded");
    await setJobState(getPool(), id, "Completed", AT);
    expect(await getObservation(getPool(), id)).toMatchObject({
      controlled: true,
      jobState: "Completed",
      respondedAt: AT,
    });
  });
});
