const HEALTH_APPEND: Readonly<Record<string, string>> = {
  "settled-not-delivered": " Last time it took payment and delivered nothing; Czar will ask first.",
  "job-failed": " It did not deliver the job; Czar will ask first.",
};

export const blockedExplanation = "Blocked: it returned text that tried to hijack the agent.";

/** Formats only owner-rating evidence and verified open health facts. */
export function rankingExplanation(input: {
  readonly good: number;
  readonly bad: number;
  readonly ownersRated: number;
  readonly healthFacts: readonly string[];
  readonly consecutiveFailures: number;
}): string {
  const total = input.good + input.bad;
  const base =
    total === 0
      ? "No ratings yet. Czar will ask before using it."
      : input.ownersRated > 1
        ? `${input.ownersRated} owners rated it: ${input.good} good, ${input.bad} bad.`
        : `${total} rating(s) from people who paid: ${input.good} good, ${input.bad} bad.`;
  return input.healthFacts.reduce((text, fact) => {
    if (fact === "repeated-unsettled-failure")
      return `${text} It failed ${input.consecutiveFailures} times in a row; Czar will ask first.`;
    return `${text}${HEALTH_APPEND[fact] ?? ""}`;
  }, base);
}
