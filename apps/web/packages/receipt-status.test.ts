import { describe, expect, it } from "vitest";
import type { LedgerReceipt } from "@czar/schemas";
import { receiptStatusText } from "#src/receipt-status";

const makeReceipt = (status: LedgerReceipt["status"], merchantIsCzar = false): LedgerReceipt => ({
  objectiveId: "obj_01J00000000000000000000000",
  envelopeRef: "eip155:5042002:0x0000000000000000000000000000000000000000:0",
  stepIndex: 0,
  amount: "1000000",
  rail: "x402-exact",
  status,
  merchantIsCzar,
  paymentRefHash: `0x${"0".repeat(64)}`,
  createdAt: "2026-10-21T00:00:00Z",
});

describe("receiptStatusText", () => {
  it.each([
    ["reserved", "Reserved"],
    ["settled", "Paid"],
    ["pending", "Paid, settling (up to 16 minutes)"],
    ["completed", "Paid"],
    ["released", "Not charged"],
    ["failed", "Failed, not charged"],
    [
      "quarantined",
      "Paid $1.00; the result failed Czar's check. This merchant was rated down. Third-party calls are not refundable.",
    ],
  ] as const)("renders %s exactly", (status, expected) => {
    expect(receiptStatusText(makeReceipt(status))).toBe(expected);
  });

  it("uses the Czar refund wording only for Czar merchants", () => {
    expect(receiptStatusText(makeReceipt("refunded"))).toBe("Refunded");
    expect(receiptStatusText(makeReceipt("refunded", true))).toBe(
      "Refunded by Czar (Czar service)",
    );
  });
});
