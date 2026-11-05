// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * The report an audit merchant returns for a paid request (SCR-182 §3). The merchant validates it before returning; an invalid report is a handler failure and is never settled. Every finding of czar-audit-deep carries a location and a fix.
 */
export type AuditReport = {
  /**
   * Schema version, major.minor; this file is 1.0.
   */
  schemaVersion: "1.0";
  /**
   * The audit service that wrote the report.
   */
  service: "czar-audit-quick" | "czar-audit-deep";
  /**
   * Short overall assessment.
   */
  summary: string;
  /**
   * Findings, most severe first; czar-audit-quick returns at most merchants.audit.quick.maxFindings (3).
   *
   * @maxItems 15
   */
  findings: Finding[];
  /**
   * H(contract) over the contract value the buyer sent (@czar/hashing), so the report is bound to its input.
   */
  inputHash: string;
  /**
   * The model id that produced the findings.
   */
  model: string;
  /**
   * When the merchant produced the report.
   */
  generatedAt: string;
};

/**
 * One finding.
 *
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "Finding".
 */
export interface Finding {
  /**
   * How serious the finding is.
   */
  severity: "critical" | "high" | "medium" | "low" | "info";
  /**
   * What is wrong.
   */
  issue: string;
  /**
   * Where in the contract, for example a function name; optional for czar-audit-quick.
   */
  location?: string;
  /**
   * How to fix it; optional for czar-audit-quick.
   */
  fix?: string;
}
