// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * Error object returned by MCP tools and APIs (spec 02 §4.16).
 */
export interface StepError {
  /**
   * Schema version, major.minor; this file is 1.0.
   */
  schemaVersion: "1.0";
  /**
   * Stable error code.
   */
  code: string;
  /**
   * Human-readable message; never contains user text.
   */
  message: string;
  /**
   * Whether a retry may succeed.
   */
  retryable: boolean;
  /**
   * URL-mode elicitation target when approval is needed (D3-11).
   */
  elicitationUrl?: string;
}
