import { describe, expect, it } from "vitest";
import { H, type Hash32 } from "@czar/hashing";
import { createReceiptInputFromTrace } from "#src/evidence/receipt-input";

const HASH = `0x${"11".repeat(32)}` as Hash32;
const payment = {
  schemaVersion: "1.0" as const,
  rail: "x402-exact" as const,
  network: "eip155:5042002",
  asset: "0x3600000000000000000000000000000000000000" as const,
  payer: "0x0000000000000000000000000000000000000001" as const,
  payTo: "0x0000000000000000000000000000000000000002" as const,
  amount: "1000",
  nonce: HASH,
  validBefore: 1_800_000_000,
  reservationId: 9,
  index: 0,
  settlementTx: HASH,
};

describe("receipt input from durable payment trace", () => {
  it("commits to checks rather than the enclosing AcceptanceReport hash", () => {
    const checks = [{ name: "delivery", result: "pass" }];
    const completedAt = new Date("2026-10-25T12:00:04Z");
    const input = createReceiptInputFromTrace(
      {
        input: {
          planId: "plan",
          envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
          step: { stepIndex: 0, acceptanceProfileId: "prof_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        },
        paymentRef: payment,
        index: 0,
        requestedAt: new Date("2026-10-25T12:00:01Z"),
        signedAt: new Date("2026-10-25T12:00:02Z"),
        bodyRef: "body_1",
        stepResult: {
          status: "delivered",
          source: { origin: "https://merchant.example" },
        },
      } as never,
      [
        {
          phase: "call.result",
          at: completedAt,
          payload: {
            index: 0,
            paymentRef: payment,
            requestCommit: HASH,
            responseCommit: HASH,
            requirementsHashSeen: HASH,
            requestSize: 12,
            responseSize: 34,
            status: 200,
            contentType: "application/json",
          },
        },
      ],
      [{ report_hash: `0x${"22".repeat(32)}`, obs_id: "obs_1", checks }],
    );

    expect(input.attestation.localChecksCommit).toBe(H(checks));
    expect(input.attestation.localChecksCommit).not.toBe(`0x${"22".repeat(32)}`);
  });
});
