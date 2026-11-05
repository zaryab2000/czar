// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * A payee leaf of payeeRoot (spec 02 §4.7, §5.3).
 *
 * This interface was referenced by `Plan`'s JSON-Schema
 * via the `definition` "PayeeLeaf".
 */
export type PayeeLeaf = {
  /**
   * Payee address.
   */
  payee: string;
  /**
   * 1 x402 payTo, 2 ERC-8183 provider, 3 tip repo (Phase 2), 4 pocket EOA (D71).
   */
  kind: 1 | 2 | 3 | 4;
  /**
   * Step index 0-63 for kinds 1-3; 4294967295 (POCKET_STEP_INDEX) for kind 4.
   */
  stepIndex: number;
  /**
   * Per-step cap shared by the payee and its alternates (D36), enforced per step on-chain (RV-002); "0" for kind 4.
   */
  stepCap: string;
};

/**
 * The priced plan for one objective (spec 02 §4.5). What the user approves; planHash is written into the envelope.
 */
export interface Plan {
  /**
   * Schema version, major.minor; this file is 1.2 (2026-10-20: steps[].why and untestedOptions, D91; neither is in planHash); 1.3 (SCR-160): approvalReasons; why.alternativesLost reasons unrated and health-blocked. 1.4 (SCR-164): approvalReasons gains incident-open; steps[].why gains lessons[]. Emitters write 1.3 until SN-4, then 1.4 whenever either field is present; both values validate.
   */
  schemaVersion: "1.3" | "1.4";
  /**
   * Plan id.
   */
  planId: string;
  /**
   * Objective id.
   */
  objectiveId: string;
  /**
   * objectiveHash.
   */
  objectiveHash: string;
  /**
   * planHash per spec 02 §5.2.
   */
  planHash: string;
  /**
   * Chain.
   */
  network: string;
  /**
   * Spending category; categoryId = keccak256(utf8(category)) on-chain.
   */
  category: string;
  /**
   * Envelope cap = sum of step caps × (1 + slack).
   */
  cap: string;
  /**
   * Slack over the step caps; default 2500.
   */
  slackBps: number;
  /**
   * Maximum over step caps.
   */
  maxStepAmount: string;
  /**
   * Pocket cap in bps of cap: 0 unless the plan has a gateway-nano step, then 2500 (D22, D71).
   */
  pocketCapBps: number;
  /**
   * Pocket EOA for the plan's gateway-nano steps; present if and only if such a step exists; committed in payeeLeaves as a kind-4 leaf (D71).
   */
  pocket?: string;
  /**
   * Envelope expiry.
   */
  expiresAt: string;
  /**
   * Steps.
   *
   * @maxItems 64
   */
  steps: Step[];
  /**
   * Plan payees plus at most two alternates per step (D36).
   */
  payeeLeaves: PayeeLeaf[];
  /**
   * Merkle root of payeeLeaves (spec 02 §5.3).
   */
  payeeRoot: string;
  /**
   * Selection Layer decisions used.
   *
   * Items: SL query_id.
   */
  rankingDecisionIds?: string[];
  /**
   * True for shadow-mode pricing (no envelope).
   */
  shadow: boolean;
  /**
   * Creation time.
   */
  createdAt: string;
  /**
   * Steps the planner removed before approval, with the reason (D82: agent-assist with no agent host).
   *
   * @maxItems 64
   *
   * Items: A dropped step.
   */
  droppedSteps?: {
    /**
     * Capability of the dropped step.
     */
    capability: string;
    /**
     * Why it was dropped. no-template: the rule-based fallback has no default input template for this capability (SCR-120).
     */
    reason: "no-agent" | "no-template";
  }[];
  /**
   * Shadow plans only (D83 point 7): real-market prices per capability from the MarketView; never used for payment.
   */
  marketReference?: {
    /**
     * selection.marketNetwork.
     */
    network: string;
    /**
     * One row per paid capability.
     *
     * @maxItems 64
     *
     * Items: Market prices for one capability.
     */
    perCapability: {
      /**
       * Capability.
       */
      capability: string;
      /**
       * Tier-ready services.
       */
      ready: number;
      /**
       * Lowest live price.
       */
      low?: string;
      /**
       * Median live price.
       */
      median?: string;
    }[];
  };
  taskSpec?: TaskSpec;
  /**
   * Write found values into the person's file in place of the recorded placeholders (D85); set on the approval screen.
   */
  fillInPlace?: boolean;
  /**
   * Shadow plans only (D91): unverified candidates quoted next to the plan, for the shadow report. Never payable from this plan; not in planHash.
   *
   * @maxItems 20
   *
   * Items: Untested option.
   */
  untestedOptions?: {
    /**
     * Capability.
     */
    capability: string;
    /**
     * Service.
     */
    serviceId: string;
    /**
     * Live 402 price per call.
     */
    livePrice: string;
    /**
     * Effective checked calls so far.
     */
    nEff: number;
  }[];
  /**
   * Why this plan needs the owner's explicit approval (SCR-160 §9.3): a paid step uses an unrated supplier, or one with an uncleared health fact for this owner, or the N1 exploration slot; incident-open (SCR-164 §3.13.1): the chosen supplier has an open incident; contract-sent (SCR-182 §5): a code-review step sends the owner's contract to the merchant. Not in planHash. A plan with a non-empty list is never opened under earned allowance.
   *
   * @maxItems 4
   *
   * Items: Reason.
   */
  approvalReasons?: ("unrated" | "health-fact" | "exploration-slot" | "incident-open" | "contract-sent")[];
}
/**
 * One step of a plan (spec 02 §4.6).
 *
 * This interface was referenced by `Plan`'s JSON-Schema
 * via the `definition` "Step".
 */
export interface Step {
  /**
   * Position; used in PayeeLeaf.
   */
  stepIndex: number;
  /**
   * Step id.
   */
  stepId: string;
  /**
   * Payment path from the router (spec 01 §8.7, D37); tip is Phase 2; local and agent-assist are unpaid (D82, spec 02 §4.6.1).
   */
  kind: "x402-exact" | "gateway-nano" | "erc8183-job" | "local" | "agent-assist" | "tip";
  /**
   * Capability this step provides.
   */
  capability: string;
  /**
   * Selection Layer service id.
   */
  serviceId?: string;
  /**
   * The merchant endpoint.
   */
  resource?: {
    /**
     * Merchant endpoint URL.
     */
    url: string;
    /**
     * HTTP method.
     */
    method: "GET" | "POST" | "PUT" | "DELETE";
  };
  /**
   * payTo or job provider; absent for local and agent-assist steps (D82).
   */
  payee?: string;
  /**
   * Up to two ranked alternates (D36).
   *
   * @maxItems 2
   *
   * Items: Alternate payee.
   */
  alternates?: string[];
  /**
   * Expected price per call from the live 402 (p1-D7).
   */
  unitAmount: string;
  /**
   * Expected number of calls; batch size n (D37).
   */
  expectedCalls: number;
  /**
   * Per-step cap, at least unitAmount × expectedCalls.
   */
  stepCap: string;
  /**
   * Why the router chose this kind, e.g. below-pocket-threshold.
   */
  routingReason: string;
  /**
   * Acceptance profile (SL §5.5).
   */
  acceptanceProfileId: string;
  /**
   * Structured input only; never user text (spec 01 §11.2 layer 3). Optional expectedKeys names the output keys the requirement check needs (AM-09). inputKeys names the only keys a pay call may send for this step (RV-021).
   */
  inputTemplate?: {
    /**
     * Keys the requirement check (CZ-16) and the reader (P-02 expectedFields) look for in the output.
     *
     * @maxItems 50
     *
     * Items: Key the merchant output must contain.
     */
    expectedKeys?: string[];
    /**
     * The only input keys a pay call may send for this step, with their types and limits (RV-021).
     *
     * @maxItems 20
     *
     * Items: One allowed input key.
     */
    inputKeys?: {
      /**
       * Key name.
       */
      name: string;
      /**
       * Value type.
       */
      type: "string" | "number" | "boolean";
      /**
       * Maximum string length (strings only).
       */
      maxLength?: number;
      /**
       * Allowed values, when the key is an enum.
       *
       * @maxItems 50
       */
      enum?: string[];
    }[];
    [k: string]: unknown;
  };
  /**
   * Dependencies.
   *
   * Items: Step index this step depends on.
   */
  dependsOn?: number[];
  /**
   * subjects: one call per TaskSpec subject (D84).
   */
  fanOut?: "none" | "subjects";
  /**
   * Concrete input per call, rendered by CZ-13 from inputTemplate and the TaskSpec; {{dep.*}} values are filled at run time (D84).
   *
   * @maxItems 128
   *
   * Items: One call's input.
   */
  callInputs?: {
    /**
     * Call index within the step.
     */
    callIndex: number;
    /**
     * TaskSpec subject this call serves.
     */
    subjectIndex?: number;
    /**
     * Key/value input sent to the merchant; values are strings, numbers or booleans, or a {{dep.<stepIndex>.<field>}} reference.
     */
    input: {
      [k: string]: string | number | boolean;
    };
  }[];
  /**
   * Shown on the approval screen for a job step whose provider gets only the task description and TaskSpec context, no files (D86; Phase 1 has no file sharing); contract-sent (SCR-182 §5) for a code-review step, whose input is the owner's contract source sent to the merchant.
   */
  contextNotice?: "task-description-only" | "contract-sent";
  /**
   * Templated reason for this step's supplier (D91). Not in planHash. Built by code from TaskSpec, the capability card and the RankingDecision; never model text.
   */
  why?: {
    /**
     * TaskSpec fields (or the subject label for one-subject kinds) this step fills.
     *
     * @maxItems 20
     *
     * Items: Field name.
     */
    fills: string[];
    /**
     * Templated sentence: evidence and price.
     */
    summary: string;
    /**
     * The ten highest-ranked candidates not chosen, with the templated reason.
     *
     * @maxItems 10
     *
     * Items: Loser.
     */
    alternativesLost: {
      /**
       * Service.
       */
      serviceId: string;
      /**
       * Why it lost.
       */
      reason:
        | "lower-score"
        | "price-over-budget"
        | "unverified"
        | "network"
        | "rail"
        | "output-format"
        | "probe-failed"
        | "payee-changed"
        | "not-in-top-k"
        | "unrated"
        | "health-blocked";
    }[];
    /**
     * Retrieved candidates not chosen beyond the ten listed.
     */
    othersNotShown?: number;
    /**
     * Personal lessons that changed or confirmed this step's choice within the ranking margin (SCR-164 §3.13.2). Plan 1.4. Not in planHash.
     *
     * @maxItems 4
     *
     * Items: Lesson.
     */
    lessons?: {
      /**
       * Lesson id.
       */
      lessonId: string;
      /**
       * Handle of the representative whose post taught it.
       */
      handle: string;
      /**
       * Prefer or avoid.
       */
      proposition: "prefer" | "avoid";
      /**
       * The supplier the lesson is about (social_lessons.service_id). For an avoid lesson it is the supplier passed over, never the step's chosen supplier (SCR-165 §2).
       */
      serviceId: string;
      /**
       * Task class.
       */
      taskClass: string;
    }[];
  };
}
/**
 * The TaskSpec this plan was built from, including approval-screen edits (D84).
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
