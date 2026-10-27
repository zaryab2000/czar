// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * Server mirror of a vault reservation (spec 02 §4.9).
 */
export interface Reservation {
  /**
   * Schema version, major.minor; this file is 1.0.
   */
  schemaVersion: "1.0";
  /**
   * Vault address.
   */
  vault: string;
  /**
   * Per-vault counter.
   */
  reservationId: number;
  /**
   * Envelope.
   */
  envelopeId: number;
  /**
   * Step index.
   */
  stepIndex: number;
  /**
   * Payee.
   */
  payee: string;
  /**
   * Amount per authorization.
   */
  unitAmount: string;
  /**
   * Number of authorizations N.
   */
  count: number;
  /**
   * Authorization expiry.
   */
  validBefore: number;
  /**
   * Signature encoding mode (spec 02 §6.3, AR-3).
   */
  mode: "envelope" | "digest";
  /**
   * 128-bit mask of settled indices, hex (upper bits zero).
   */
  settledMask: string;
  /**
   * Settled indices.
   */
  settledCount: number;
  /**
   * Released indices.
   */
  releasedCount: number;
  /**
   * Reservation state.
   */
  state: "Active" | "Finalizing" | "Final";
  /**
   * Payment ids by index (spec 02 §7.4).
   *
   * @maxItems 128
   *
   * Items: Payment id for the index at this position.
   */
  paymentIds?: string[];
}
