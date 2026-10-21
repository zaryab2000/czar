// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * Selection Layer RankingDecision, adopted verbatim from SL §5.6 (spec 02 §4.19).
 */
export interface RankingDecision {
  /**
   * Schema version, major.minor; this file is 1.0.
   */
  schemaVersion: "1.0";
  /**
   * Query id.
   */
  query_id: string;
  /**
   * Receipt time.
   */
  received_at: string;
  /**
   * Policy version.
   */
  policy_version: string;
  /**
   * Anchored snapshot root.
   */
  snapshot_id: string;
  /**
   * Anchor transaction.
   */
  snapshot_anchor_tx: string;
  /**
   * The query.
   */
  query: {
    /**
     * Task text.
     */
    task: string;
    /**
     * Task class.
     */
    task_class?: string;
    /**
     * Constraints (SL C4).
     */
    constraints: {
      [k: string]: unknown;
    };
    /**
     * Risk quantile.
     */
    risk_quantile: number;
    /**
     * Weights.
     */
    weights: {
      [k: string]: unknown;
    };
  };
  /**
   * Candidates considered.
   */
  candidates_considered: number;
  /**
   * Excluded candidates.
   *
   * Items: Exclusion.
   */
  excluded: {
    /**
     * Service.
     */
    service_id: string;
    /**
     * Gate.
     */
    gate: string;
    /**
     * Detail.
     */
    detail: string;
  }[];
  /**
   * Ranked list.
   *
   * Items: Ranked entry.
   */
  ranked: {
    /**
     * Rank.
     */
    rank: number;
    /**
     * Service.
     */
    service_id: string;
    /**
     * Version.
     */
    version_id: string;
    /**
     * Score.
     */
    score: number;
    /**
     * Features.
     */
    features: {
      [k: string]: unknown;
    };
    /**
     * Evidence refs.
     *
     * Items: Evidence ref.
     */
    evidence_refs: string[];
    /**
     * Evidence age in days.
     */
    evidence_age_days: number;
    /**
     * Missing features.
     *
     * Items: Missing feature.
     */
    missing: string[];
    /**
     * Badges.
     *
     * Items: Badge.
     */
    badges: string[];
    /**
     * Templated explanation.
     */
    explanation: string;
  }[];
  /**
   * Unverified section.
   *
   * Items: Unverified entry.
   */
  unverified: {
    /**
     * Service.
     */
    service_id: string;
    /**
     * Reason.
     */
    reason: "n_eff_below_min";
    /**
     * Effective evidence count.
     */
    n_eff: number;
  }[];
  /**
   * Structurally missing dimensions.
   *
   * Items: Dimension.
   */
  missing_dimensions_for_class: string[];
  /**
   * True when nothing could be ranked.
   */
  insufficient_evidence: boolean;
  /**
   * Exploration slot.
   */
  exploration_slot?: {
    /**
     * Service.
     */
    service_id: string;
    /**
     * Reason.
     */
    reason: string;
  };
}
