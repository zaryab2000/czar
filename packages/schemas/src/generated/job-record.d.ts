// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * An ERC-8183 job opened by the vault as client (spec 02 §4.11).
 */
export interface JobRecord {
  /**
   * Schema version, major.minor; this file is 1.1. 1.1 (2026-10-19) adds state Released (RV-009).
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
   * Step index.
   */
  stepIndex: number;
  /**
   * Escrow instance (Circle testnet or CzarJobEscrow).
   */
  jobEscrow: string;
  /**
   * The escrow's job id.
   */
  jobId: string;
  /**
   * keccak256(abi.encode(jobEscrow, jobId)).
   */
  jobKey: string;
  /**
   * Provider.
   */
  provider: string;
  /**
   * Evaluator (Czar key K7).
   */
  evaluator: string;
  /**
   * Step cap reserved at openJob.
   */
  reservedCap: string;
  /**
   * Budget from BudgetSet / getJob.
   */
  budget?: string;
  /**
   * Hash in the on-chain description string czar:<hash>.
   */
  descriptionHash: string;
  /**
   * From JobSubmitted.
   */
  deliverableHash?: string;
  /**
   * The reason passed to complete or reject.
   */
  reportHash?: string;
  /**
   * Job state. Released: an unfunded job the vault released (JobSynced state 6, RV-009).
   */
  state: "Opened" | "Funded" | "Submitted" | "Completed" | "Rejected" | "Expired" | "Refunded" | "Released";
  /**
   * Job expiry.
   */
  expiredAt: number;
  /**
   * Object-store key of the uploaded deliverable whose keccak256 equals the on-chain deliverable (D87 push model; replaces deliverableUri and the D53 .well-known URL).
   */
  deliverableRef?: string;
}
