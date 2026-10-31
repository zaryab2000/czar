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
    const paymentWithReorderedKeys = Object.fromEntries(Object.entries(payment).toReversed());
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
          phase: "call.response",
          at: completedAt,
          payload: {
            index: 0,
            paymentRef: paymentWithReorderedKeys,
            requestCommit: HASH,
            responseCommit: HASH,
            requirementsHashSeen: HASH,
            requestSize: 12,
            responseSize: 34,
            status: 200,
            contentType: "application/json",
          },
        },
        {
          phase: "acceptance.result",
          at: completedAt,
          payload: {
            index: 0,
            reportHash: `0x${"22".repeat(32)}`,
            obsId: "obs_1",
          },
        },
      ],
      [{ report_hash: `0x${"22".repeat(32)}`, obs_id: "obs_1", checks }],
    );

    expect(input.attestation.localChecksCommit).toBe(H(checks));
    expect(input.attestation.localChecksCommit).not.toBe(`0x${"22".repeat(32)}`);
  });

  it("binds each repeated-body payment to its own durable acceptance report", () => {
    const checksA = [{ name: "delivery", result: "pass" }];
    const checksB = [
      { name: "delivery", result: "pass" },
      { name: "structural", result: "pass" },
    ];
    const reports = [
      { report_hash: `0x${"22".repeat(32)}`, obs_id: "obs_1", checks: checksA },
      { report_hash: `0x${"33".repeat(32)}`, obs_id: "obs_2", checks: checksB },
    ];
    const trace = [
      {
        phase: "call.response",
        at: new Date("2026-10-25T12:00:04Z"),
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
      {
        phase: "call.response",
        at: new Date("2026-10-25T12:00:05Z"),
        payload: {
          index: 1,
          paymentRef: { ...payment, index: 1, nonce: `0x${"44".repeat(32)}` },
          requestCommit: HASH,
          responseCommit: HASH,
          requirementsHashSeen: HASH,
          requestSize: 12,
          responseSize: 34,
          status: 200,
          contentType: "application/json",
        },
      },
      {
        phase: "acceptance.result",
        at: new Date("2026-10-25T12:00:04Z"),
        payload: { index: 0, reportHash: reports[0]!.report_hash, obsId: reports[0]!.obs_id },
      },
      {
        phase: "acceptance.result",
        at: new Date("2026-10-25T12:00:05Z"),
        payload: { index: 1, reportHash: reports[1]!.report_hash, obsId: reports[1]!.obs_id },
      },
    ] as const;
    const context = (index: number) =>
      ({
        input: {
          planId: "plan",
          envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000001:1",
          step: { stepIndex: 0, acceptanceProfileId: "prof_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        },
        paymentRef: index === 0 ? payment : trace[1]!.payload.paymentRef,
        index,
        requestedAt: new Date("2026-10-25T12:00:01Z"),
        signedAt: new Date("2026-10-25T12:00:02Z"),
        bodyRef: "same-content-addressed-body",
        stepResult: { status: "delivered", source: { origin: "https://merchant.example" } },
      }) as never;

    const first = createReceiptInputFromTrace(context(0), trace, reports);
    const second = createReceiptInputFromTrace(context(1), trace, reports);

    expect(first.obsId).toBe("obs_1");
    expect(first.attestation.localChecksCommit).toBe(H(checksA));
    expect(second.obsId).toBe("obs_2");
    expect(second.attestation.localChecksCommit).toBe(H(checksB));
  });
});
