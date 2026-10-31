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

function signedInput(nonce: string) {
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
    paymentRef: paymentRef(nonce),
    paymentId: `pay_${nonce.slice(0, 32)}`,
  };
}

function openedJobInput() {
  return {
    ...signedInput("66".repeat(32)),
    rail: "erc8183-job" as const,
    taskClass: "data-json.extract",
    paymentRef: {
      schemaVersion: "1.0" as const,
      rail: "erc8183-job" as const,
      network: "eip155:5042002",
      contract: "0x0000000000000000000000000000000000000004" as const,
      jobId: "7",
      client: VAULT,
      provider: PAYEE,
      evaluator: "0x0000000000000000000000000000000000000005" as const,
      budget: "1000",
    },
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
    const finalRef = { ...input.paymentRef, settlementTx: `0x${"99".repeat(32)}` };
    expect(paymentRefHash(finalRef)).not.toBe(paymentRefHash(input.paymentRef));
    expect((await getObservation(getPool(), expectedId))?.paymentRefHash).toBe(
      paymentRefHash(input.paymentRef),
    );
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
    const silent = await insertAtSign(getPool(), signedInput("44".repeat(32)));
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
      callIndex: 1,
    });
  });

  it("allocates a new ordinal when a released call is signed again at local index zero", async () => {
    const first = await insertAtSign(getPool(), signedInput("77".repeat(32)));
    await markReleased(getPool(), first, AT);
    const second = await insertAtSign(getPool(), signedInput("88".repeat(32)));
    expect(first).not.toBe(second);
    expect(await getObservation(getPool(), first)).toMatchObject({ callIndex: 0 });
    expect(await getObservation(getPool(), second)).toMatchObject({ callIndex: 1 });
  });

  it("allocates a new ordinal after a partial paid attempt resets the local index", async () => {
    const first = await insertAtSign(getPool(), signedInput("aa".repeat(32)));
    await markSettled(getPool(), first, AT);
    const retry = signedInput("bb".repeat(32));
    const second = await insertAtSign(getPool(), {
      ...retry,
      paymentRef: { ...retry.paymentRef, reservationId: 10, index: 0 },
    });
    expect(first).not.toBe(second);
    expect(await getObservation(getPool(), first)).toMatchObject({ callIndex: 0 });
    expect(await getObservation(getPool(), second)).toMatchObject({ callIndex: 1 });
  });

  it("copies the controlled flag at insert and advances a job state", async () => {
    await getPool().query("UPDATE users SET controlled=true WHERE user_id=$1", [TEST_USER_ID]);
    const id = await insertAtSign(getPool(), openedJobInput());
    expect(await getObservation(getPool(), id)).toMatchObject({
      controlled: true,
      jobState: "Opened",
      settledAt: null,
      delivered: null,
    });
    await setJobState(getPool(), id, "Funded");
    await markSettled(getPool(), id, AT);
    await setJobState(getPool(), id, "Completed", AT);
    expect(await getObservation(getPool(), id)).toMatchObject({
      controlled: true,
      jobState: "Completed",
      settledAt: AT,
      delivered: 1,
      respondedAt: AT,
    });
  });

  it("records job expiry delivery only when it expired directly from Funded", async () => {
    const funded = await insertAtSign(getPool(), openedJobInput());
    const submitted = await insertAtSign(getPool(), {
      ...openedJobInput(),
      paymentRef: { ...openedJobInput().paymentRef, jobId: "8" },
      paymentId: `pay_${"88".repeat(16)}`,
    });
    await setJobState(getPool(), funded, "Funded");
    await setJobState(getPool(), submitted, "Funded");
    await setJobState(getPool(), submitted, "Submitted");
    await setJobState(getPool(), funded, "Expired", AT);
    await setJobState(getPool(), submitted, "Expired", AT);
    expect(await getObservation(getPool(), funded)).toMatchObject({
      jobState: "Expired",
      delivered: 0,
      respondedAt: AT,
    });
    expect(await getObservation(getPool(), submitted)).toMatchObject({
      jobState: "Expired",
      delivered: null,
      respondedAt: AT,
    });
  });

  it("rejects reattribution of a signed payment to another objective", async () => {
    const signed = signedInput("99".repeat(32));
    await insertAtSign(getPool(), signed);
    await expect(insertAtSign(getPool(), { ...signed, taskClass: "other" })).rejects.toThrow(
      "Observation identity collision",
    );
  });
});
