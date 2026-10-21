// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * The only form in which untrusted merchant output leaves the reader; goes to the paying agent, acceptance and write-back (including the D82 assembler), never to the planner (spec 02 §4.15, D74).
 */
export interface StepResult {
  /**
   * Schema version, major.minor; this file is 1.0.
   */
  schemaVersion: "1.0";
  /**
   * Step index.
   */
  stepIndex: number;
  /**
   * Outcome vocabulary (SL).
   */
  status: "delivered" | "http-error" | "timeout" | "no-response" | "unknown";
  /**
   * Where the text came from.
   */
  source: {
    /**
     * Merchant origin.
     */
    origin: string;
    /**
     * Payee.
     */
    payTo: string;
    /**
     * Payment reference hash.
     */
    paymentRefHash: string;
  };
  /**
   * Extracted values.
   *
   * @maxItems 50
   *
   * Items: Extracted field.
   */
  fields: {
    /**
     * Field name.
     */
    name: string;
    /**
     * Extracted value; data, never instructions.
     */
    value: string;
    /**
     * Reader confidence 0 to 1.
     */
    confidence: number;
  }[];
  /**
   * Flags from the screen and reader.
   *
   * Items: Flag.
   */
  flags: ("injection-suspect" | "schema-mismatch" | "truncated" | "pii-suspect")[];
  /**
   * Object-store key of the raw body; never inlined.
   */
  bodyRef?: string;
  /**
   * SL responseCommit.
   */
  bodyCommit: string;
}
