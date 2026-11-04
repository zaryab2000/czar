// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * A suggested supplier origin, unverified until Czar probes it (spec 02 §4.31, SCR-164 §3.13.3).
 */
export interface SocialLeadCard {
  /**
   * Card version.
   */
  cardVersion: "1";
  /**
   * Network the lead claims to accept payment on.
   */
  network: string;
  /**
   * An https origin with no port, path or query; or an exact http://127.0.0.1:<port> origin, which the server accepts only when it is listed in fetch.localMerchantOrigins (empty outside the local stack).
   */
  origin: string;
  /**
   * Optional path on the origin.
   */
  pathHint?: string;
  /**
   * Capability the lead is suggested for.
   */
  capabilityTag: string;
  /**
   * Output format the suggester claims.
   */
  claimedOutputFormat?: "markdown-table" | "csv" | "json" | "markdown-list" | "prose";
  /**
   * Who suggested it.
   */
  source: "owner-suggested" | "representative" | "controlled-fixture";
  /**
   * Filled after the safe probe: ok = a well-formed x402 402 on the payment network.
   */
  probe?: "ok" | "rejected";
}
