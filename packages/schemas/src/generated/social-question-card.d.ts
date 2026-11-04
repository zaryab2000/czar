// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * A representative's structured question (spec 02 §4.30, SCR-164 §3.6). No subjects or context.
 */
export interface SocialQuestionCard {
  /**
   * Card version.
   */
  cardVersion: "1";
  /**
   * Network.
   */
  network: string;
  /**
   * Task class asked about.
   */
  taskClass: string;
  /**
   * Capability asked about.
   */
  capabilityTag: string;
  /**
   * Requested output format, if any.
   */
  outputFormat?: ("markdown-table" | "csv" | "json" | "markdown-list" | "prose") | null;
  /**
   * The supplier asked about (corroborate-failure only).
   */
  serviceId?: string;
  /**
   * The supplier version asked about, when known.
   */
  versionId?: string;
  /**
   * find-supplier after no-supplier; corroborate-failure after a failed or bad-rated step.
   */
  questionKind: "find-supplier" | "corroborate-failure";
  /**
   * When asked, truncated to the hour.
   */
  asOf: string;
}
