// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * Typed answers from the optional soul interview (spec 02 §4.25, D90). Each field is a fixed question id. Deterministic templates map answers to beliefs; no model call. Budget answers never change vault settings.
 */
export interface InterviewSubmission {
  /**
   * Schema version, major.minor; this file is 1.1 (2026-10-20: taste.outputFormat, D91).
   */
  schemaVersion: "1.1";
  /**
   * Fixed per submission; a repeat returns the same result.
   */
  idempotencyKey: string;
  /**
   * Place answers; saved context only in Phase 1 (D90 item 6).
   */
  place?: {
    /**
     * BCP 47 language tag.
     */
    locale?: string;
    /**
     * IANA time zone name.
     */
    timeZone?: string;
    /**
     * ISO 4217 code the person prefers; descriptive only, Phase 1 shows USD (D51).
     */
    displayCurrencyPreference?: string;
  };
  /**
   * Mission answers.
   */
  mission?: {
    /**
     * Lowercase hex of a known root projectRef from listLocalSoulSourceRoots (spec 02 §4.26); links the deadline to that project.
     */
    projectRootId?: string;
    /**
     * Project name.
     */
    projectName?: string;
    /**
     * What the project should achieve.
     */
    goal?: string;
    /**
     * Project deadline (date).
     */
    deadline?: string;
  };
  /**
   * Constraint answers. The three typed fields feed ObjectiveSubmission.constraints; the text fields are saved context.
   */
  constraints?: {
    /**
     * Most the person wants one objective to cost; becomes ObjectiveSubmission.constraints.maxTotal. Never a vault limit.
     */
    maxTotalPerObjective?: string;
    /**
     * Only previously used payees; becomes ObjectiveSubmission.constraints.noNewPayees.
     */
    noNewPayees?: boolean;
    /**
     * Allowed spending categories; becomes ObjectiveSubmission.constraints.categoriesAllowed.
     *
     * @maxItems 20
     *
     * Items: Category.
     */
    categoriesAllowed?: string[];
    /**
     * Tools or vendors the person does not want used; saved context.
     *
     * @maxItems 10
     *
     * Items: Name.
     */
    offLimitsTools?: string[];
    /**
     * A privacy rule in the person's words; saved context.
     */
    privacyRule?: string;
  };
  /**
   * Taste answers. outputFormat is used (D91); the other taste answers are saved context only in Phase 1.
   */
  taste?: {
    /**
     * Preferred output format.
     */
    preferredFormat?: string;
    /**
     * Preferred or trusted sources.
     */
    preferredSources?: string;
    /**
     * Preferred result format when the person's file does not decide it; becomes TaskSpec.output.format (D91). Typed, so it can reach the server.
     */
    outputFormat?: "markdown-table" | "csv" | "json" | "markdown-list" | "prose";
  };
  /**
   * Spending posture answers; saved context only in Phase 1. Lowering a real limit is a CZ-22 owner action.
   */
  spendingPosture?: {
    /**
     * How careful the person wants Czar to be.
     */
    riskPreference?: "careful" | "balanced" | "relaxed";
    /**
     * Free note.
     */
    note?: string;
  };
  /**
   * Hourly value in USD (USDC atomic units); sets soul.json hourlyValue with setByUser true.
   */
  hourlyValue?: string;
}
