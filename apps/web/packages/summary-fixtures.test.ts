import { describe, expect, it } from "vitest";
import { validateRecordedExchange } from "@czar/api-contract";
import { monthlyStatementFixture, shadowTotalsFixture } from "#src/summary-fixtures";

describe("summary fixtures", () => {
  it("matches the monthly statement response schema", () => {
    expect(
      validateRecordedExchange("getMonthlyStatement", {
        responseStatus: 200,
        responseBody: monthlyStatementFixture,
      }).valid,
    ).toBe(true);
  });

  it("matches the ingest report shadow totals schema", () => {
    const report = {
      deviceId: "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
      periodStart: "2026-10-01T00:00:00.000Z",
      periodEnd: "2026-11-01T00:00:00.000Z",
      eventsIngested: 0,
      redactionHits: 0,
      shadowTotals: shadowTotalsFixture,
    };
    expect(
      validateRecordedExchange("ingestReport", {
        requestBody: report,
        responseStatus: 204,
      }).valid,
    ).toBe(true);
  });
});
