// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * PaymentRef (SL §5.2).
 */
export type PaymentRef = {
  /**
   * Schema version, major.minor; this file is 1.0.
   */
  schemaVersion: "1.0";
  [k: string]: unknown;
} & (
  | {
      /**
       * Schema version, major.minor; this file is 1.0.
       */
      schemaVersion?: "1.0";
      /**
       * Payment rail.
       */
      rail: "x402-exact";
      /**
       * Chain.
       */
      network: string;
      /**
       * Token (USDC).
       */
      asset: string;
      /**
       * Payer (the vault).
       */
      payer: string;
      /**
       * Payee.
       */
      payTo: string;
      /**
       * Amount.
       */
      amount: string;
      /**
       * EIP-3009 nonce.
       */
      nonce: string;
      /**
       * Authorization expiry.
       */
      validBefore: number;
      /**
       * Settlement transaction.
       */
      settlementTx?: string;
      /**
       * Vault reservation (server-only; excluded from paymentRefHash).
       */
      reservationId?: number;
      /**
       * Authorization index (server-only; excluded from paymentRefHash).
       */
      index?: number;
    }
  | {
      /**
       * Schema version, major.minor; this file is 1.0.
       */
      schemaVersion?: "1.0";
      /**
       * Payment rail.
       */
      rail: "gateway-batched";
      /**
       * Chain.
       */
      network: string;
      /**
       * Pocket EOA.
       */
      payer: string;
      /**
       * Payee.
       */
      payTo: string;
      /**
       * Amount.
       */
      amount: string;
      /**
       * Authorization nonce.
       */
      nonce: string;
      /**
       * Gateway API transfer id.
       */
      transferId?: string;
      /**
       * submitBatch transaction.
       */
      batchTx?: string;
    }
  | {
      /**
       * Schema version, major.minor; this file is 1.0.
       */
      schemaVersion?: "1.0";
      /**
       * Payment rail.
       */
      rail: "erc8183-job";
      /**
       * Chain.
       */
      network: string;
      /**
       * Escrow contract.
       */
      contract: string;
      /**
       * Job id.
       */
      jobId: string;
      /**
       * Client (the vault).
       */
      client: string;
      /**
       * Provider.
       */
      provider: string;
      /**
       * Evaluator.
       */
      evaluator: string;
      /**
       * Budget.
       */
      budget: string;
    }
  | {
      /**
       * Schema version, major.minor; this file is 1.0.
       */
      schemaVersion?: "1.0";
      /**
       * Payment rail.
       */
      rail: "mpp";
      /**
       * Chain.
       */
      network: string;
      /**
       * MPP charge id (SL-F27 GAP; unused).
       */
      chargeId: string;
      /**
       * Payer.
       */
      payer: string;
      /**
       * Payee.
       */
      payTo: string;
      /**
       * Amount.
       */
      amount: string;
      /**
       * Settlement transaction.
       */
      settlementTx?: string;
    }
);

/**
 * Buyer receipt: SL §5.4 ObservationCore with kind=receipt, signed as SL §5.8 Receipt (spec 02 §4.13).
 */
export interface Receipt {
  /**
   * Schema version, major.minor; this file is 1.0.
   */
  schemaVersion: "1.0";
  /**
   * Observation kind.
   */
  kind: "receipt";
  /**
   * Reporter (SL §5.4).
   */
  reporter: {
    /**
     * Reporter kind.
     */
    kind: "buyer";
    /**
     * Reporter id.
     */
    id: string;
    /**
     * The vault (ERC-1271 kind SL_RECEIPT) or the pocket EOA.
     */
    address: string;
  };
  payment: PaymentRef;
  /**
   * keccak256(jcs(PaymentRef)).
   */
  payment_ref_hash: string;
  /**
   * Price shown before paying.
   */
  listed_price_atomic?: string;
  /**
   * URL origin the reporter called.
   */
  origin_asserted: string;
  /**
   * Hash of the 402 received.
   */
  requirements_hash_seen?: string;
  /**
   * Request commit (SL §5.4).
   */
  request?: {
    /**
     * requestCommit.
     */
    commit: string;
    /**
     * Canonicalisation scheme.
     */
    canonical_scheme: "sl-req-v1";
    /**
     * Request size in bytes.
     */
    size: number;
  };
  /**
   * Response commit (SL §5.4).
   */
  response?: {
    /**
     * HTTP status.
     */
    status_code?: number;
    /**
     * responseCommit.
     */
    commit?: string;
    /**
     * Response size in bytes.
     */
    size?: number;
    /**
     * MIME type.
     */
    mime?: string;
    /**
     * Optional merchant DeliveryAttestation.
     */
    merchant_attestation?: {
      /**
       * DeliveryAttestation signature.
       */
      sig: string;
      /**
       * Signer.
       */
      signer: string;
      /**
       * Timestamp.
       */
      ts: number;
    };
  };
  /**
   * Timings.
   */
  timing?: {
    /**
     * Request time.
     */
    t_request: number;
    /**
     * Authorization signed.
     */
    t_payment_signed: number;
    /**
     * First byte.
     */
    t_first_byte?: number;
    /**
     * Complete.
     */
    t_complete?: number;
  };
  /**
   * Outcome (SL §5.4).
   */
  outcome: "delivered" | "http-error" | "timeout" | "no-response" | "unknown" | "skipped";
  /**
   * Disclosure level; hash-only by default.
   */
  disclosure: "public" | "validator-only" | "hash-only";
  /**
   * Buyer-run checks.
   */
  local_checks?: {
    /**
     * Profile.
     */
    profile_id: string;
    /**
     * checksCommit.
     */
    checks_commit: string;
  };
  /**
   * Creation time.
   */
  created_at: string;
  /**
   * obs_ + keccak of the core (SL §5.1).
   */
  obs_id: string;
  /**
   * EIP-712 Receipt signature (SL §5.8); for the vault, the SL_RECEIPT envelope bytes.
   */
  sig: string;
  /**
   * Czar envelope (server-only).
   */
  envelopeRef?: string;
  /**
   * Czar step index (server-only).
   */
  stepIndex?: number;
}
