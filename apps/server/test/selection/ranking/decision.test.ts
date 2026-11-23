import { H } from "@czar/hashing";
import { validateSchema } from "@czar/schemas";
import { describe, expect, it } from "vitest";
import { makeRankingDecision, rankingPolicyVersion } from "#src/selection/ranking/decision";

const serviceId = `svc_${"a".repeat(32)}`;
const versionId = `ver_${"b".repeat(32)}`;

describe("ranking decision 1.2", () => {
  it("binds the policy and gives rated rows their Wilson score", () => {
    const policyVersion = rankingPolicyVersion({ confidenceZ: 1.959964, consecutiveFailures: 3 });
    expect(policyVersion).toBe(
      `pol_${H({ policy: "ratings-v1", confidenceZ: 1.959964, healthConsecutiveFailures: 3 }).slice(
        2,
        18,
      )}`,
    );
    const decision = makeRankingDecision({
      query: { taskClass: "data-json", capability: "web-search", max_price_atomic: "100" },
      candidatesConsidered: 1,
      ranked: [
        {
          rank: 1,
          service_id: serviceId,
          version_id: versionId,
          score: 0.5655,
          features: {
            good: 5,
            bad: 0,
            owners_rated: 1,
            owners_bad: 0,
            lower_bound: 0.5655,
            health_facts: [],
            price_atomic: "25",
          },
          evidence_refs: [],
          evidence_age_days: 0,
          missing: ["correctness"],
          badges: ["single-owner"],
          explanation: "5 rating(s) from people who paid: 5 good, 0 bad.",
        },
      ],
      unverified: [],
      excluded: [],
      policyVersion,
      snapshotId: `0x${"c".repeat(64)}`,
      receivedAt: new Date("2026-10-31T00:00:00Z"),
      queryId: "query-rated",
      unverifiedWithApproval: true,
    });
    expect(validateSchema("ranking-decision", decision)).toBe(true);
    expect(decision.ranked[0]?.score).toBe(0.5655);
    expect(decision.snapshot_anchor_tx).toBeNull();
    expect(decision.missing_dimensions_for_class).toEqual(["correctness"]);
    expect(decision.insufficient_evidence).toBe(false);
  });
});
