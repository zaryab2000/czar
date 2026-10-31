import type { AppResultCard } from "#src/app-api";

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

export const resultRatingCopy = {
  "results.rating.good": "Good",
  "results.rating.bad": "Bad",
  "results.rating.change": "Change",
  "results.rating.closed": "Rating closed",
  "results.rating.thanks":
    "Thanks. Czar will rank {merchantLabel} {direction} for tasks like this.",
  "results.rating.thisWeek": "Czar did {n} tasks this week. Rate any you looked at.",
} as const;

export function resultsThisWeek(
  cards: readonly AppResultCard[],
  now: Date,
): readonly AppResultCard[] {
  const latest = now.getTime();
  const earliest = latest - WEEK_MS;
  return cards.filter((card) => {
    const delivered = Date.parse(card.deliveredAt);
    return Number.isFinite(delivered) && delivered >= earliest && delivered <= latest;
  });
}

export function ratingThanks(merchantLabel: string, value: "good" | "bad"): string {
  return resultRatingCopy["results.rating.thanks"]
    .replace("{direction}", value === "good" ? "higher" : "lower")
    .replace("{merchantLabel}", merchantLabel);
}

export function thisWeekHeading(count: number): string {
  return resultRatingCopy["results.rating.thisWeek"].replace("{n}", String(count));
}
