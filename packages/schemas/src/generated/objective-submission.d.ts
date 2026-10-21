// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * The only object the daemon sends to the server for a new objective (spec 02 §4.4; D25). Contains no local-only field.
 */
export interface ObjectiveSubmission {
  /**
   * Schema version, major.minor; this file is 1.0.
   */
  schemaVersion: "1.0";
  /**
   * Objective id.
   */
  objectiveId: string;
  /**
   * objectiveHash per spec 02 §5.2.
   */
  objectiveHash: string;
  /**
   * soulVersionHash per spec 02 §5.2.
   */
  soulVersionHash: string;
  /**
   * Observation hashes.
   *
   * @maxItems 50
   *
   * Items: Observation hash.
   */
  observationHashes: string[];
  /**
   * Detector.
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
   * Redacted plain-language goal.
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
   * A under $25/h ... E over $200/h; exact amount stays local.
   */
  hourlyBand: "A" | "B" | "C" | "D" | "E";
  /**
   * Constraints from the soul.
   */
  constraints?: {
    /**
     * Maximum total spend for this objective.
     */
    maxTotal?: string;
    /**
     * Allowed categories.
     *
     * Items: Category.
     */
    categoriesAllowed?: string[];
    /**
     * Only previously used payees.
     */
    noNewPayees?: boolean;
  };
  /**
   * Redaction stats; counts and entity names only.
   */
  redaction: {
    /**
     * Layer-2 (PII) stats.
     */
    layer2: {
      /**
       * Number of layer-2 replacements.
       */
      hits: number;
      /**
       * Entity names that fired.
       *
       * Items: Presidio entity name.
       */
      entities: string[];
    };
  };
  /**
   * Device id from the device token.
   */
  deviceId: string;
  /**
   * Submission time.
   */
  submittedAt: string;
  taskSpec: TaskSpec;
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
