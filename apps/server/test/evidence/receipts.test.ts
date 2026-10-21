import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPaymentReceipt } from "#src/evidence/receipts";
import { jcs, type Hash32 } from "@czar/hashing";
import { loadConfig } from "@czar/config";
import { keccak256 } from "viem";
import { setupDatabase } from "#test/db";
import { testSigner } from "#test/payer/test-signer";

const getPool = setupDatabase();
const HASH: Hash32 = `0x${"11".repeat(32)}`;

beforeEach(async () => {
  await getPool().query("DELETE FROM evidence_receipts");
});

describe("settled payment receipts", () => {
  it("does not sign or persist an unpaid or released authorization", async () => {
    const sign = vi.fn();
    for (const state of ["unpaid", "released"] as const) {
      const result = await createPaymentReceipt(receiptInput(state), {
        pool: getPool(),
        config: loadConfig(),
        signer: { sign },
        settlement: { isSettled: async () => true },
        now: () => new Date("2026-10-21T00:00:00Z"),
      });
      expect(result).toBeNull();
    }
    await createPaymentReceipt(receiptInput("settled"), {
      pool: getPool(),
      config: loadConfig(),
      signer: { sign },
      settlement: { isSettled: async () => false },
      now: () => new Date("2026-10-21T00:00:00Z"),
    });
    expect(sign).not.toHaveBeenCalled();
  });

  it("computes PaymentRef hash without reservation bookkeeping and stores the signed v2 receipt", async () => {
    const signer = await testSigner();
    const result = await createPaymentReceipt(receiptInput("settled"), {
      pool: getPool(),
      config: loadConfig(),
      signer,
      settlement: { isSettled: async () => true },
      now: () => new Date("2026-10-21T00:00:00Z"),
    });
    expect(result?.paymentRef).toMatchObject(receiptInput("settled").payment);
    const {
      reservationId: _reservationId,
      index: _index,
      ...preimage
    } = result?.paymentRef ?? receiptInput("settled").payment;
    const expected = keccak256(jcs(preimage));
    expect(result?.receipt.payment_ref_hash).toBe(expected);
    expect(result?.paymentRef.reservationId).toBe(9);
    expect(result?.paymentRef.index).toBe(2);
    expect(result?.receipt.sig.length).toBeGreaterThan(130);
    const stored = await getPool().query<{ receipt: unknown; report_hashes: string[] }>(
      "SELECT receipt,report_hashes FROM evidence_receipts WHERE obs_id=$1",
      ["obs_11111111111111111111111111111111"],
    );
    expect(stored.rows[0]?.receipt).toEqual(result?.receipt);
    expect(stored.rows[0]?.report_hashes).toEqual([HASH]);
    const duplicateSigner = vi.fn();
    const duplicate = await createPaymentReceipt(receiptInput("settled"), {
      pool: getPool(),
      config: loadConfig(),
      signer: { sign: duplicateSigner },
      settlement: { isSettled: async () => true },
      now: () => new Date("2026-10-22T00:00:00Z"),
    });
    expect(duplicate).toEqual(result);
    expect(duplicateSigner).not.toHaveBeenCalled();
  });
});

function receiptInput(state: "settled" | "unpaid" | "released") {
  return {
    state,
    payment: {
      schemaVersion: "1.0" as const,
      rail: "x402-exact" as const,
      network: "eip155:5042002",
      asset: "0x3600000000000000000000000000000000000000",
      payer: "0x0000000000000000000000000000000000000001",
      payTo: "0x0000000000000000000000000000000000000002",
      amount: "1000",
      nonce: HASH,
      validBefore: 1_800_000_000,
      settlementTx: HASH,
      reservationId: 9,
      index: 2,
    },
    reportHashes: [HASH],
    profileId: "prof_11111111111111111111111111111111",
    envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
    stepIndex: 0,
    obsId: "obs_11111111111111111111111111111111",
    reporterId: "czar",
    originAsserted: "merchant.example",
    requestSize: 24,
    responseSize: 64,
    mimeType: "application/json",
    outcome: "delivered" as const,
    disclosure: "hash-only" as const,
    attestation: {
      requestCommit: HASH,
      responseCommit: HASH,
      statusCode: 200,
      originAsserted: "merchant.example",
      requirementsHashSeen: HASH,
      tRequest: 1_797_000_000n,
      tPaymentSigned: 1_797_000_001n,
      tComplete: 1_797_000_002n,
      outcome: 0,
      localChecksCommit: HASH,
      disclosure: 2,
      createdAt: 1_797_000_002n,
    },
  };
}
