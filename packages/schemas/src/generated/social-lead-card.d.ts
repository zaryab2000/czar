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
   * An https origin only (scheme, host, optional port; no path or query).
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
