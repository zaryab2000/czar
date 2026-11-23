// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * The JSON body a buyer POSTs to an audit merchant, czar-audit-quick or czar-audit-deep (SCR-182 §2).
 */
export interface AuditRequest {
  /**
   * Solidity source text, or a 0x-prefixed 40-hex contract address when the merchant's address lookup is on; at most merchants.audit.maxInputChars (2000) characters (SCR-182 §2, §6).
   */
  contract: string;
}
