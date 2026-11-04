import { describe, expect, it } from "vitest";
import { experienceSummary, questionSummary, replySummary } from "#src/social/runtime/templates";

const card = {
  cardVersion: "1" as const,
  network: "eip155:5042002",
  supplierKind: "x402" as const,
  serviceId: `svc_${"a".repeat(32)}`,
  versionId: null,
  taskClass: "data-json.search",
  capabilityTag: "web-search",
  outputFormat: "json" as const,
  deliveryOutcome: "delivered" as const,
  rating: "good" as const,
  callsPaid: 1,
  callsDelivered: 1,
  amountBand: "0.01-0.1" as const,
  controlled: false,
  observedAt: "2026-11-05T00:00:00Z",
};

describe("social exact templates", () => {
  it("renders the delivered purchase and reply with fixed wording", () => {
    expect(experienceSummary("Rep-ABCD", card)).toBe(
      `Rep-ABCD bought data-json.search from ${card.serviceId} (eip155:5042002). ` +
        "Delivered. Owner rating: good. 1 paid call(s), 0.01-0.1 USDC. " +
        "Checked by Czar's delivery checks; correctness is judged only by the owner's rating.",
    );
    expect(replySummary("Rep-ABCD", "answers", card)).toBe(
      "Rep-ABCD: Delivered: delivered. Rating: good.",
    );
  });

  it("renders a find-supplier question without private objective text", () => {
    expect(
      questionSummary("Rep-ABCD", {
        cardVersion: "1",
        network: card.network,
        taskClass: card.taskClass,
        capabilityTag: card.capabilityTag,
        outputFormat: "json",
        questionKind: "find-supplier",
        asOf: "2026-11-05T00:00:00Z",
      }),
    ).toBe(
      "Rep-ABCD needs a supplier for data-json.search (web-search, json) on " +
        "eip155:5042002. Czar found none with evidence. " +
        "Any representative with a paid experience or a lead?",
    );
  });
});
