// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * What an ERC-8183 provider must deliver (spec 02 §4.21, RV-025). Served only to the job's provider at GET /v1/jobs/{jobKey}/brief after an EIP-712 BriefRequest signature; never public, never on-chain. Its fields are the preimage of the on-chain descriptionHash. Version 2 (D86, D87): carries the approved TaskSpec; type-agnostic (no job-kind list); deliverables are pushed to Czar; optional fields may be added in later versions and providers must ignore optional fields they do not use.
 */
export interface JobBrief {
  /**
   * Schema version, major.minor; this file is 1.0.
   */
  schemaVersion: "1.0";
  /**
   * Brief format version (2 since D86/D87). Optional fields may be added without a version change; providers ignore optional fields they do not use.
   */
  briefVersion: 2;
  /**
   * Chain of the job.
   */
  network: string;
  /**
   * ERC-8183 instance.
   */
  jobEscrow: string;
  /**
   * Escrow job id as a decimal string (uint256).
   */
  jobId: string;
  /**
   * keccak256(abi.encode(jobEscrow, jobId)) (spec 02 §7.1).
   */
  jobKey: string;
  /**
   * descriptionHash preimage field.
   */
  planHash: string;
  /**
   * descriptionHash preimage field.
   */
  stepIndex: number;
  /**
   * descriptionHash preimage field; SL ProfileId.
   */
  acceptanceProfileId: string;
  /**
   * Capability tag.
   */
  capability: string;
  /**
   * Structured input for the call: the step's callInputs, keys from inputTemplate.inputKeys (RV-021), values rendered from the approved TaskSpec and earlier results (D84, D86 C1-a). Superseded by D86: 'Never free user text'.
   */
  inputs: {
    [k: string]: string | number | boolean;
  };
  taskSpec: TaskSpec;
  /**
   * Random per job; stops guessing low-entropy inputs from the public hash.
   */
  inputSalt: string;
  /**
   * H({hashRule: czar-hash-v1, kind: job-input, inputs, inputSalt}) (spec 02 §5.2).
   */
  inputCommit: string;
  /**
   * What to submit and where.
   */
  deliverable: {
    /**
     * Expected media type.
     */
    mimeType: string;
    /**
     * Keys the acceptance requirement check looks for.
     *
     * @maxItems 50
     *
     * Items: Key.
     */
    expectedKeys?: string[];
    /**
     * Optional JSON Schema the deliverable must validate against (8 KiB max when serialized).
     */
    schema?: {
      [k: string]: unknown;
    };
    /**
     * How the provider hands over the bytes (D87, replaces D53): push = upload to uploadRoute signed as DeliverableUpload, then submit the keccak256 of the bytes.
     */
    delivery: "push";
    /**
     * Upload route on Czar's server: POST /v1/jobs/{jobKey}/deliverable. In Phase 1 the server is local (http://localhost), so only a provider on the same machine can reach it (N3).
     */
    uploadRoute?: string;
    /**
     * acceptance.deliverableMaxBytes.
     */
    maxBytes?: number;
  };
  /**
   * The job's reservedCap; a setBudget above it is refused.
   */
  budgetCap: string;
  /**
   * The price Czar planned for this job (the provider's listed price, M1); setting it is expected, but any budget up to budgetCap is accepted.
   */
  targetBudget: string;
  /**
   * Czar evaluator K7.
   */
  evaluator: string;
  /**
   * Job expiry, unix seconds.
   */
  expiredAt: number;
  /**
   * Unix seconds: submit (and upload) by this time; = expiredAt − acceptance.evaluationWindowSeconds (M4, N5). Later submissions are evaluated only if a decision can still be made before the cutoff.
   */
  submitBy: number;
  /**
   * Unix seconds: the evaluator sends its decision by this time; a deliverable still missing then is rejected (N5).
   */
  decisionCutoff: number;
  /**
   * When the server built this response.
   */
  issuedAt: string;
  /**
   * Plain facts the provider should know before bidding (H5, M3, D27).
   */
  terms: {
    /**
     * The evaluator is Czar, acting for the buyer (D27).
     */
    evaluatorIsBuyerAgent: boolean;
    /**
     * What the evaluator checks.
     *
     * Items: Check kind.
     */
    checks: ("delivery" | "structural" | "requirement")[];
    /**
     * Always false in Phase 1: Czar checks the form, not correctness (H5).
     */
    correctnessChecked: false;
    /**
     * If the buyer freezes: a funded job not yet submitted is rejected and refunded; a submitted job is held until unfreeze or the decision cutoff (M3).
     */
    onBuyerFreeze: "reject-unsubmitted-hold-submitted";
  };
  /**
   * Reserved for approved file sharing (C1-b, stage 2). Absent in Phase 1 (D86).
   *
   * @maxItems 10
   *
   * Items: One approved file.
   */
  attachments?: {
    /**
     * Base name.
     */
    name: string;
    /**
     * Media type.
     */
    mimeType: string;
    /**
     * keccak256 of the bytes.
     */
    contentHash: string;
    /**
     * Download reference, served to the provider only.
     */
    ref: string;
    /**
     * Size.
     */
    bytes: number;
  }[];
}
/**
 * The approved TaskSpec: topic, subjects, fields, columns, context (D86 C1-a). Phase 1 carries no files.
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
