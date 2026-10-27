// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * Payment reference, adopted from SL §5.2 with two server-only vault bookkeeping fields (spec 02 §4.12). paymentRefHash excludes reservationId and index. additionalProperties is enforced per rail branch under oneOf.
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
