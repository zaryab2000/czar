// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * Proof-of-demand chain for one objective, anchored as an EVIDENCE_BATCH leaf (spec 02 §4.17; product §6.22). Version 2 (RV-026): no pseudonym and no bare soulVersionHash; the soul link is a per-envelope salted commitment only the user can open.
 */
export interface DemandProofLeafV2 {
  /**
   * Schema version, major.minor; this file is 2.0.
   */
  schemaVersion: "2.0";
  /**
   * Leaf type.
   */
  leafType: "demand-proof";
  /**
   * Leaf version.
   */
  leafVersion: 2;
  /**
   * Observation hashes.
   *
   * @maxItems 50
   *
   * Items: Observation hash.
   */
  observationHashes: string[];
  /**
   * Objective hash.
   */
  objectiveHash: string;
  /**
   * keccak256(abi.encode(soulVersionHash, demandSalt)); demandSalt is per envelope, server-only, never used in a soul-version leaf; revealed only to the user (spec 02 §4.17, RV-026).
   */
  soulVersionCommit: string;
  /**
   * Plan hash.
   */
  planHash: string;
  /**
   * Envelope reference.
   */
  envelopeRef: string;
  /**
   * Approval reference.
   */
  approval: {
    /**
     * Who opened the envelope.
     */
    approver: "owner" | "agent";
    /**
     * Opening transaction.
     */
    txHash: string;
    /**
     * Block number.
     */
    blockNumber: number;
  };
  /**
   * Payment reference hashes.
   *
   * Items: paymentRefHash per step payment.
   */
  paymentRefHashes: string[];
  /**
   * Outcome hashes.
   *
   * Items: reportHash per step.
   */
  outcomeHashes: string[];
  /**
   * Envelope close time.
   */
  closedAt: number;
}
