import { H } from "@czar/hashing";
import type { RankingDecision } from "@czar/schemas";

export function rankingPolicyVersion(input: {
  readonly confidenceZ: number;
  readonly consecutiveFailures: number;
}): string {
  return `pol_${H({
    policy: "ratings-v1",
    confidenceZ: input.confidenceZ,
    healthConsecutiveFailures: input.consecutiveFailures,
  }).slice(2, 18)}`;
}

export interface DecisionInput {
  readonly query: {
    readonly taskClass: string;
    readonly capability: string;
    readonly max_price_atomic: string;
  };
  readonly candidatesConsidered: number;
  readonly ranked: RankingDecision["ranked"];
  readonly unverified: RankingDecision["unverified"];
  readonly excluded: RankingDecision["excluded"];
  readonly policyVersion: string;
  readonly snapshotId: string;
  readonly receivedAt: Date;
  readonly queryId: string;
  readonly unverifiedWithApproval: boolean;
}

/** Builds the canonical Selection Layer decision from a persisted count snapshot. */
export function makeRankingDecision(input: DecisionInput): RankingDecision {
  const explore =
    input.ranked.length === 0 && input.unverifiedWithApproval ? input.unverified[0] : undefined;
  return {
    schemaVersion: "1.3",
    query_id: input.queryId,
    received_at: input.receivedAt.toISOString(),
    policy_version: input.policyVersion,
    snapshot_id: input.snapshotId,
    snapshot_anchor_tx: null,
    query: {
      task: input.query.capability,
      task_class: input.query.taskClass,
      constraints: { max_price_atomic: input.query.max_price_atomic },
      risk_quantile: 0.05,
      weights: {},
    },
    candidates_considered: input.candidatesConsidered,
    excluded: input.excluded,
    ranked: input.ranked,
    unverified: input.unverified,
    missing_dimensions_for_class: ["correctness"],
    insufficient_evidence: input.ranked.length === 0,
    ...(explore
      ? {
          exploration_slot: {
            service_id: explore.service_id,
            reason: "no-ranked-candidate",
          },
        }
      : {}),
  };
}
