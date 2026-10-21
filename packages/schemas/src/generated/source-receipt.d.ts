// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * Evidence for a non-observed belief or proposal (spec 02 §4.23, D90). Local only; never egresses.
 */
export interface SourceReceipt {
  /**
   * Schema version, major.minor; this file is 1.0.
   */
  schemaVersion: "1.0";
  /**
   * Receipt id.
   */
  receiptId: string;
  /**
   * declared, local-file or imported; never observed.
   */
  sourceClass: "declared" | "local-file" | "imported";
  /**
   * What the receipt points at.
   */
  kind: "interview" | "agent-file" | "git-commit" | "git-marker" | "import-paste" | "agent-summary";
  /**
   * Who entered it: the local viewer, or an agent host through propose_soul_context. Kept so an agent-mediated interview stays visible (D90 item 5).
   */
  origin: "viewer" | "agent-host";
  /**
   * For kind interview: the fixed interview question id (InterviewSubmission field path).
   */
  questionId?: string;
  /**
   * When the source was read or the answer given.
   */
  capturedAt: string;
  /**
   * Redacted excerpt shown in the viewer, at most 500 characters; layer 1 applied before storage.
   */
  excerpt: string;
  /**
   * keccak256 of the exact source bytes read at capture time (file, commit subject, paste or summary).
   */
  sourceDigest: string;
  /**
   * File path relative to the selected root, or commit id. Viewer display only; never egresses, never in a model excerpt.
   */
  locator?: string;
  /**
   * Consent record for the scope that allowed the read.
   */
  consentId?: string;
  /**
   * Redaction counts applied before storage.
   */
  redactionCounts: {
    /**
     * Layer 1 (secrets) marker count.
     */
    layer1: number;
    /**
     * Layer 2 (PII) marker count; 0 when layer 2 has not run.
     */
    layer2: number;
  };
  /**
   * Screening results for this source.
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
