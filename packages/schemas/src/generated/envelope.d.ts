// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * Server mirror of CzarVault envelope state, rebuilt from events (spec 02 §4.8). The contract is the source of truth.
 */
export interface Envelope {
  /**
   * Schema version, major.minor; this file is 1.1. 1.1 (2026-10-19) adds shortfall and pocket; Closing is derived (RV-011, RV-048).
   */
  schemaVersion: "1.1";
  /**
   * Global reference.
   */
  envelopeRef: string;
  /**
   * Vault address.
   */
  vault: string;
  /**
   * Per-vault counter.
   */
  envelopeId: number;
  /**
   * Plan id.
   */
  planId?: string;
  /**
   * From EnvelopeOpened.
   */
  objectiveHash: string;
  /**
   * From EnvelopeOpened.
   */
  planHash: string;
  /**
   * From EnvelopeOpened.
   */
  payeeRoot: string;
  /**
   * keccak256 of the category string.
   */
  categoryId: string;
  /**
   * Envelope cap.
   */
  cap: string;
  /**
   * Per-step cap.
   */
  maxStepAmount: string;
  /**
   * Pocket cap in bps.
   */
  pocketCapBps: number;
  /**
   * Expiry.
   */
  expiresAt: number;
  /**
   * Who opened it.
   */
  approver: "owner" | "agent";
  /**
   * Transaction hash of the opening call.
   */
  approvalTx: string;
  /**
   * Funds that left the vault permanently.
   */
  spent: string;
  /**
   * Open reservations.
   */
  reserved: string;
  /**
   * Deposited to Gateway, not yet pulled back.
   */
  pocketOutstanding: string;
  /**
   * In ERC-8183 escrow.
   */
  jobEscrowed: string;
  /**
   * Credits owed back to the envelope that the owner had already withdrawn; from ShortfallRecorded (RV-011). Absent means 0.
   */
  shortfall?: string;
  /**
   * The envelope's single pocket, from PocketRegistered (D48, D71).
   */
  pocket?: string;
  /**
   * Open and Closed come from events; Closing is derived by the indexer: on-chain Open and (now >= expiresAt or the close sequence has started) (RV-048).
   */
  state: "Open" | "Closing" | "Closed";
  /**
   * Indexer cursor.
   */
  lastEventBlock: number;
}
