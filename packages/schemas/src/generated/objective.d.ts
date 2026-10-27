// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * A candidate objective produced by the drives engine before publication (spec 02 §4.3). Holds local evidence links.
 */
export interface Objective {
  /**
   * Schema version, major.minor; this file is 1.1 (2026-10-20: dismissReason, D91).
   */
  schemaVersion: "1.1";
  /**
   * Objective id; the id itself is sent to the server.
   */
  objectiveId: string;
  /**
   * Soul version the objective was derived from.
   */
  soulVersion: number;
  /**
   * Detector that produced it; three in Phase 1.
   */
  detector:
    | "placeholder"
    | "repeated-error"
    | "agent-refusal"
    | "stale-work"
    | "repeated-search"
    | "copy-paste-loop"
    | "deadline";
  /**
   * Plain-language goal; redacted-to-server after layer 2.
   */
  goal: string;
  /**
   * Capabilities needed.
   *
   * @maxItems 10
   *
   * Items: Capability tag.
   */
  capabilities: string[];
  /**
   * Deadline if known.
   */
  deadline?: string;
  /**
   * Estimated minutes saved.
   */
  minutesSaved: number;
  /**
   * Local evidence links.
   *
   * @maxItems 50
   *
   * Items: Local evidence link.
   */
  evidence: {
    /**
     * Linked observation.
     */
    eventId: string;
    /**
     * Linked belief.
     */
    beliefId?: string;
  }[];
  /**
   * Observation hashes.
   *
   * @maxItems 50
   *
   * Items: observationHash per linked event (spec 02 §5.2).
   */
  observationHashes: string[];
  /**
   * Value-of-time filter output.
   */
  roi: {
    /**
     * Hourly-value band; only the band leaves the machine.
     */
    hourlyBand: "A" | "B" | "C" | "D" | "E";
    /**
     * Value-of-time ratio (minutes saved × hourly value ÷ price).
     */
    ratio: number;
  };
  /**
   * Local lifecycle status: candidate, dismissed, shadowed (priced in shadow mode, never sent for payment), published.
   */
  status: "candidate" | "dismissed" | "shadowed" | "published";
  taskSpec: TaskSpec;
  /**
   * Why a dismissed objective was dismissed (D91: no-capability when no taxonomy tag fits).
   */
  dismissReason?: "user" | "roi-filter" | "no-capability";
}
/**
 * The task's real subject (D84, §4.3.1).
 */
export interface TaskSpec {
  /**
   * Schema version, major.minor; this file is 1.1 (2026-10-20: output, D91).
   */
  schemaVersion: "1.1";
  /**
   * Shape of the task.
   */
  kind: "table-fill" | "list-fill" | "line-fill" | "error-fix" | "refused-task";
  /**
   * Nearest heading, table caption, error class or prompt gist.
   */
  topic: string;
  /**
   * Base file name only, never a path.
   */
  fileName?: string;
  /**
   * File extension.
   */
  fileExt?: string;
  /**
   * What to look up or act on, one entry per item (for a table: the row label of each row with a placeholder).
   *
   * @maxItems 50
   *
   * Items: One subject.
   */
  subjects: {
    /**
     * Subject text, layer 1 only.
     */
    label: string;
    /**
     * 1-based line in the file.
     */
    sourceLine?: number;
    /**
     * Added on the approval screen.
     */
    addedByUser?: boolean;
    /**
     * Exact placeholder spans for this subject, so CZ-11 can fill them in place (D85).
     *
     * @maxItems 20
     *
     * Items: One placeholder span.
     */
    placeholders?: {
      /**
       * Which field the span is for.
       */
      field: string;
      /**
       * The exact placeholder text, for example [Add price].
       */
      token: string;
      /**
       * Table column index (table-fill).
       */
      column?: number;
    }[];
  }[];
  /**
   * What to find for each subject (placeholder column headers or placeholder text).
   *
   * @maxItems 20
   *
   * Items: Field name.
   */
  fields: string[];
  /**
   * Full header row of the source table, in order (table-fill only).
   *
   * @maxItems 20
   *
   * Items: Column header.
   */
  columns?: string[];
  /**
   * Surrounding text, error text or the person's prompt, after layer 1.
   */
  context?: string;
  /**
   * Where the subject came from.
   */
  sourceTrust: "user-file" | "user-prompt" | "tool-output";
  /**
   * Subjects were changed on the approval screen.
   */
  editedByUser?: boolean;
  /**
   * How the person wants the result shaped (D91). Built by code: the person's own file decides first, then the interview answer taste.outputFormat, then the default for the task kind. Part of taskSpecHash when present.
   */
  output?: {
    /**
     * Output format.
     */
    format: "markdown-table" | "csv" | "json" | "markdown-list" | "prose";
    /**
     * What decided the format.
     */
    formatSource: "file" | "interview" | "default";
  };
}
