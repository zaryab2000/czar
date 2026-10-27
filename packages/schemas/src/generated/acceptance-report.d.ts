// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * SL §5.5 ValidationReportCore with assignment buyer-local in Phases 1–2, plus Czar fields (spec 02 §4.14). reportHash is the ERC-8183 reason.
 */
export interface AcceptanceReport {
  /**
   * Schema version, major.minor; this file is 1.0.
   */
  schemaVersion: "1.0";
  /**
   * Observation checked.
   */
  obs_id: string;
  /**
   * Acceptance profile.
   */
  profile_id: string;
  /**
   * Must equal profile.code_hash.
   */
  method_version: string;
  /**
   * Validator.
   */
  validator: {
    /**
     * Validator id.
     */
    id: string;
    /**
     * Evaluator key K7 address.
     */
    address: string;
  };
  /**
   * Assignment.
   */
  assignment: {
    /**
     * Assignment kind; buyer-local in Phases 1–2.
     */
    kind: "probe-pool" | "sl-assigned" | "buyer-local";
    /**
     * Salt commitment (Phase 3).
     */
    salt_commit?: string;
  };
  /**
   * Checks.
   *
   * Items: One check.
   */
  checks: {
    /**
     * Check name.
     */
    name: string;
    /**
     * Result (SL §5.5).
     */
    result: "pass" | "fail" | "inconclusive" | "not_checked";
    /**
     * Evidence reference.
     */
    evidence_ref?: string;
    /**
     * Check detail.
     */
    detail?: {
      [k: string]: unknown;
    };
  }[];
  /**
   * Consensus group id.
   */
  consensus_group?: string;
  /**
   * Cost in USD.
   */
  cost_usd: number;
  /**
   * Creation time.
   */
  created_at: string;
  /**
   * Limits. Documented values include no-correctness-check, screen-unavailable, sandbox-timeout (AM-11).
   *
   * Items: What the method cannot establish.
   */
  limits: string[];
  /**
   * Conflict flags; self-reported-checks in Phases 1–2; czar-test-buyer when Czar's own test-buyer vault paid (D91).
   *
   * Items: Conflict flag.
   */
  conflict_flags: ("validator-is-prober" | "validator-affiliated" | "self-reported-checks" | "czar-test-buyer")[];
  /**
   * Czar envelope.
   */
  envelopeRef: string;
  /**
   * Czar step index.
   */
  stepIndex: number;
  /**
   * Job key when the step is an ERC-8183 job.
   */
  jobKey?: string;
  /**
   * Overall decision.
   */
  decision: "pass" | "fail" | "inconclusive";
  /**
   * keccak256(jcs(report minus reportHash)); used as the ERC-8183 reason.
   */
  reportHash: string;
  /**
   * rep_ id (SL §5.1).
   */
  report_id?: string;
  /**
   * EIP-712 ValidationReport signature by K7.
   */
  sig?: string;
  /**
   * Acceptance flags; injection-quarantined when the P-01 screen held the body back (AM-11).
   *
   * Items: Acceptance-level flag.
   */
  flags?: "injection-quarantined"[];
}
