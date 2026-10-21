// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * A pocket wallet for one envelope: mirror plus server fields (spec 02 §4.10).
 */
export interface PocketRecord {
  /**
   * Schema version, major.minor; this file is 1.1. 1.1 (2026-10-19) adds PullbackRecord.recovery and creditedToEnvelope (RV-004, RV-011).
   */
  schemaVersion: "1.1";
  /**
   * Vault.
   */
  vault: string;
  /**
   * Envelope.
   */
  envelopeId: number;
  /**
   * The pocket EOA.
   */
  pocket: string;
  /**
   * KMS key id; never the key.
   */
  keyRef: string;
  /**
   * Pocket state. DelegateReady is derived: on-chain Registered and GatewayWallet DelegateAdded(USDC, pocket, vault) seen (RV-048).
   */
  state: "Registered" | "DelegateReady" | "Funded" | "Draining" | "Closed";
  /**
   * Sum of fundPocket.
   */
  funded: string;
  /**
   * Native sent for gas, in 6-decimal units.
   */
  gasGranted: string;
  /**
   * Funded minus confirmed pullbacks.
   */
  outstanding: string;
  /**
   * Sum of pending pullback values.
   */
  pendingPullback: string;
  /**
   * Pullbacks.
   */
  pullbacks: PullbackRecord[];
  /**
   * Nanopayment ids.
   *
   * Items: Nanopayment transfer id from the Gateway API (A2-29).
   */
  gatewayTransferIds?: string[];
}
/**
 * One pullback from a pocket (spec 02 §4.10).
 *
 * This interface was referenced by `PocketRecord`'s JSON-Schema
 * via the `definition` "PullbackRecord".
 */
export interface PullbackRecord {
  /**
   * Per-vault counter.
   */
  pullbackId: number;
  /**
   * Value to mint back to the vault.
   */
  value: string;
  /**
   * Burn-intent salt (spec 02 §7.3).
   */
  salt: string;
  /**
   * Maximum Gateway fee allowed.
   */
  maxFee: string;
  /**
   * Burn-intent maxBlockHeight.
   */
  maxBlockHeight: number;
  /**
   * keccak256 of the byte-encoded TransferSpec (Gateway replay id).
   */
  transferSpecHash: string;
  /**
   * Block of requestPullback.
   */
  requestedAtBlock: number;
  /**
   * Pullback state.
   */
  state: "Pending" | "Confirmed" | "Cancelled";
  /**
   * Gateway API transferId.
   */
  attestationTransferId?: string;
  /**
   * gatewayMint transaction hash.
   */
  mintTx?: string;
  /**
   * True for a pullback of a Closed pocket; its mint is free balance (RV-004). Absent means false.
   */
  recovery?: boolean;
  /**
   * From PullbackConfirmed: true if the mint was credited back to the envelope (RV-011).
   */
  creditedToEnvelope?: boolean;
}
