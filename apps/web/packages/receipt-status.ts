import type { LedgerReceipt } from "@czar/schemas";
import { formatUsd } from "@czar/web/money-format";

export function receiptStatusText(receipt: LedgerReceipt): string {
  switch (receipt.status) {
    case "reserved":
      return "Reserved";
    case "settled":
    case "completed":
      return "Paid";
    case "pending":
      return "Paid, settling (up to 16 minutes)";
    case "released":
      return "Not charged";
    case "refunded":
      return receipt.merchantIsCzar ? "Refunded by Czar (Czar service)" : "Refunded";
    case "failed":
      return "Failed, not charged";
    case "quarantined":
      return `Paid ${receipt.amountDisplay ?? formatUsd(receipt.amount)}; the result failed Czar's check. This merchant was rated down. Third-party calls are not refundable.`;
  }
}
