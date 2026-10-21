// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * A batch of leaves anchored to OpenEvidenceLog as EVIDENCE_BATCH (spec 02 §4.20).
 */
export interface EvidenceBatch {
  /**
   * Schema version, major.minor; this file is 1.1 (2026-10-19: archiveUri is the host-free czar-archive form, D78).
   */
  schemaVersion: "1.1";
  /**
   * Batch id.
   */
  batchId: string;
  /**
   * Publisher address.
   */
  publisher: string;
  /**
   * OpenEvidenceLog kind.
   */
  kind: "EVIDENCE_BATCH";
  /**
   * Previous root of this publisher and kind; zero for the first.
   */
  prevRoot: string;
  /**
   * Merkle root (spec 02 §5.3).
   */
  root: string;
  /**
   * Leaves.
   *
   * @minItems 1
   *
   * Items: Leaf.
   */
  leaves: {
    /**
     * Leaf type.
     */
    leafType:
      | "demand-proof"
      | "soul-version"
      | "observation"
      | "report"
      | "assessment"
      | "correction"
      | "exposure"
      | "submission-log";
    /**
     * Leaf hash.
     */
    leafHash: string;
    /**
     * Content location.
     */
    contentUri?: string;
  }[];
  /**
   * Phase 1: keccak256(utf8(archiveUri)) with archiveUri = czar-archive:<root> (D78). Phase 2: keccak256 of the archive's IPFS CID (D54).
   */
  uriHash: string;
  /**
   * IPFS CID of the archive. Phase 2 only (D54); absent in Phase 1.
   */
  cid?: string;
  /**
   * commit transaction.
   */
  committedTx?: string;
  /**
   * Host-free archive reference czar-archive:<root> (D78). Never a localhost URL: the anchor is permanent. Resolved against the archive hosts in Czar's latest POLICY_RELEASE (Phase 1: the local server; stage 2: the public host). Content is JSON Lines of the leaf objects; its leaves rebuild the anchored root.
   */
  archiveUri: string;
}
