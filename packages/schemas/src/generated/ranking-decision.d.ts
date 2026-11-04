// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * Selection Layer RankingDecision, adopted verbatim from SL §5.6 (spec 02 §4.19).
 */
export interface RankingDecision {
  /**
   * Schema version, major.minor; this file is 1.3 (SCR-163 §6: unverified[].version_id, the probed version an unrated candidate was selected at). 1.2: SCR-160 (unverified[].reason unrated; score = Wilson lower bound). 1.1: snapshot_anchor_tx may be null (SCR-137).
   */
  schemaVersion: "1.3";
  /**
   * Query id.
   */
  query_id: string;
  /**
   * Receipt time.
   */
  received_at: string;
  /**
   * Policy version: pol_ + 16 hex of keccak256 over the policy definition (SL PolicyVersion); for the interim producer, over its JCS descriptor (SCR-137).
   */
  policy_version: string;
  /**
   * Snapshot root: the anchored FEATURE_SNAPSHOT root (SL); for the Phase 1 interim producer, keccak256 of the stored JCS interim snapshot (SCR-137).
   */
  snapshot_id: string;
  /**
   * Anchor transaction of snapshot_id; null means the snapshot is not anchored (Phase 1 interim producer, SCR-137) and must never be presented as anchored.
   */
  snapshot_anchor_tx: string | null;
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
     * Gate (C4 gates, or health-blocked for an uncleared injection-blocked fact, SCR-160 §6).
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
     * Score: the Wilson lower bound of good/(good+bad) at selection.confidenceZ (SCR-160 §9.4).
     */
    score: number;
    /**
     * Features (SCR-160 §9.3): good, bad, owners_rated, owners_bad, lower_bound, health_facts[], price_atomic; incident (SCR-164 §3.13.1, when an incident is open): {incidentId, distinctOwners, negativeUnits, openedAt}.
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
     * Badges: single-owner, health-flagged, incident-open (SCR-160 §9.3).
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
     * The version this candidate was probed at in this query (SCR-163 §1); the expected version CZ-15 checks before paying (SCR-163 §6). Absent only when the query had no successful probe for it.
     */
    version_id?: string;
    /**
     * Reason: unrated (no rating record for the task class, SCR-160) or, for pre-SCR-160 rows, n_eff_below_min.
     */
    reason: "n_eff_below_min" | "unrated";
    /**
     * Effective evidence count; 0 for unrated (SCR-160).
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
