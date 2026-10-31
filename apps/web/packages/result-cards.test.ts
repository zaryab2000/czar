import { describe, expect, it } from "vitest";
import { resultsThisWeek, resultRatingCopy } from "#src/result-cards";

const now = new Date("2026-10-31T12:00:00.000Z");
const card = (objectiveId: string, deliveredAt: string) => ({
  objectiveId,
  deliveredAt,
  kind: "research",
  stepCount: 1,
  suppliers: [],
  windowClosesAt: "2026-11-01T12:00:00.000Z",
});

describe("result cards", () => {
  it("includes the last seven days, including the exact boundary", () => {
    const cards = [
      card("current", now.toISOString()),
      card("boundary", "2026-10-24T12:00:00.000Z"),
      card("older", "2026-10-24T11:59:59.999Z"),
      card("future", "2026-11-01T12:00:00.000Z"),
    ];
    expect(resultsThisWeek(cards, now).map(({ objectiveId }) => objectiveId)).toEqual([
      "current",
      "boundary",
    ]);
  });

  it("has the specified rating copy keys", () => {
    expect(resultRatingCopy["results.rating.good"]).toBe("Good");
    expect(resultRatingCopy["results.rating.bad"]).toBe("Bad");
    expect(resultRatingCopy["results.rating.change"]).toBe("Change");
    expect(resultRatingCopy["results.rating.closed"]).toBe("Rating closed");
  });
});
