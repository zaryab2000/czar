// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * A suggested belief waiting for the person's decision in the local viewer (spec 02 §4.24, D90). Never part of soul.json, drives, model soul excerpts or exports.
 */
export interface ProposedBelief {
  /**
   * Schema version, major.minor; this file is 1.0.
   */
  schemaVersion: "1.0";
  /**
   * Proposal id.
   */
  proposalId: string;
  /**
   * Target section.
   */
  section: "place" | "mission" | "rituals" | "friction" | "drives" | "taste" | "constraints" | "spendingPosture";
  /**
   * Normalized dedupe key; a tombstoned key blocks the proposal.
   */
  key: string;
  /**
   * Suggested belief text; markers allowed.
   */
  text: string;
  /**
   * Class the belief would have if accepted.
   */
  sourceClass: "declared" | "local-file" | "imported";
  /**
   * Receipts behind the proposal.
   *
   * @minItems 1
   * @maxItems 10
   *
   * Items: Receipt.
   */
  sourceReceiptIds: string[];
  /**
   * Set when the proposal belongs to one agent-mediated interview bundle accepted with a single confirmation (D90 item 5).
   */
  bundleId?: string;
  /**
   * Lifecycle.
   */
  status: "pending" | "accepted" | "rejected" | "expired";
  /**
   * When the proposal was made.
   */
  createdAt: string;
  /**
   * When the person accepted or rejected it, or it expired.
   */
  decidedAt?: string;
  /**
   * The belief created on acceptance.
   */
  beliefId?: string;
  /**
   * Screening results; a flagged proposal cannot be batch-accepted.
   *
   * @maxItems 20
   *
   * Items: Flag.
   */
  screenFlags: (
    | "p01-flagged"
    | "deny-list"
    | "skipped-suspicious"
    | "unsupported-language"
    | "oversized"
    | "truncated-span"
    | "stale-source"
  )[];
}
