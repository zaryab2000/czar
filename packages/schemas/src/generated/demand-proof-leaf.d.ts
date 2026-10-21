// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * SUPERSEDED by demand-proof-leaf.v2.schema.json (RV-026): version 1 carried userPseudonym and the bare soulVersionHash, which let anyone join a user's soul-version leaves to their vault and payments. Version-1 leaves are never produced. Proof-of-demand chain for one objective, anchored as an EVIDENCE_BATCH leaf (spec 02 §4.17; product §6.22).
 */
export interface DemandProofLeaf {
  /**
   * Schema version, major.minor; this file is 1.0.
   */
  schemaVersion: "1.0";
  /**
   * Leaf type.
   */
  leafType: "demand-proof";
  /**
   * Leaf version.
   */
  leafVersion: 1;
  /**
   * Rotating per-user pseudonym.
   */
  userPseudonym: string;
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
   * Soul version hash.
   */
  soulVersionHash: string;
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
