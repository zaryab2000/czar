import type { RankingDecision } from "@czar/schemas";
import { rankingExplanation } from "#src/selection/ranking/explain";
import { wilsonLower } from "#src/selection/ranking/lower-bound";

export interface RankCandidate {
  readonly serviceId: string;
  readonly versionId: string;
  readonly priceAtomic: string;
  readonly good: number;
  readonly bad: number;
  readonly lowerBound?: number | null;
  readonly ownersRated: number;
  readonly ownersBad: number;
  readonly computedAt: Date;
  readonly lineageRoot?: string | null;
  readonly healthFacts: readonly string[];
  readonly injectionBlocked: boolean;
}

export interface OrderedCandidates {
  readonly ranked: RankingDecision["ranked"];
  readonly unverified: RankingDecision["unverified"];
  readonly excluded: RankingDecision["excluded"];
}

/** Applies SCR-160 ranking to candidates that passed the existing C4 gates. */
export function orderCandidates(
  candidates: readonly RankCandidate[],
  confidenceZ: number,
  now: Date = new Date(),
  consecutiveFailures = 3,
): OrderedCandidates {
  const excluded: RankingDecision["excluded"] = [];
  const rated: Array<{ candidate: RankCandidate; score: number }> = [];
  const unrated: RankCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.injectionBlocked) {
      excluded.push({
        service_id: candidate.serviceId,
        gate: "health-blocked",
        detail: "injection-blocked",
      });
      continue;
    }
    const total = candidate.good + candidate.bad;
    if (total === 0) {
      unrated.push(candidate);
      continue;
    }
    const score =
      candidate.lowerBound === undefined
        ? wilsonLower(candidate.good, total, confidenceZ)
        : candidate.lowerBound;
    if (score === null) throw new Error("Rated candidate has no Wilson lower bound.");
    rated.push({ candidate, score });
  }
  rated.sort(
    (left, right) =>
      right.score - left.score ||
      comparePrice(left.candidate.priceAtomic, right.candidate.priceAtomic) ||
      compareText(left.candidate.serviceId, right.candidate.serviceId),
  );
  unrated.sort(
    (left, right) =>
      comparePrice(left.priceAtomic, right.priceAtomic) ||
      compareText(left.serviceId, right.serviceId),
  );
  return {
    excluded,
    ranked: rated.map(({ candidate, score }, index) => ({
      rank: index + 1,
      service_id: candidate.serviceId,
      version_id: candidate.versionId,
      score,
      features: {
        good: candidate.good,
        bad: candidate.bad,
        owners_rated: candidate.ownersRated,
        owners_bad: candidate.ownersBad,
        lower_bound: score,
        health_facts: candidate.healthFacts.toSorted(),
        price_atomic: candidate.priceAtomic,
      },
      evidence_refs: candidate.lineageRoot ? [candidate.lineageRoot] : [],
      evidence_age_days: Math.max(0, (now.getTime() - candidate.computedAt.getTime()) / 86400000),
      missing: ["correctness"],
      badges: [
        ...(candidate.ownersRated === 1 ? ["single-owner"] : []),
        ...(candidate.healthFacts.length ? ["health-flagged"] : []),
      ],
      explanation: rankingExplanation({
        good: candidate.good,
        bad: candidate.bad,
        ownersRated: candidate.ownersRated,
        healthFacts: candidate.healthFacts.toSorted(),
        consecutiveFailures,
      }),
    })),
    unverified: unrated.map((candidate) => ({
      service_id: candidate.serviceId,
      reason: "unrated" as const,
      n_eff: 0,
    })),
  };
}

function comparePrice(left: string, right: string): number {
  const leftAmount = BigInt(left);
  const rightAmount = BigInt(right);
  return leftAmount < rightAmount ? -1 : leftAmount > rightAmount ? 1 : 0;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
