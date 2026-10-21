// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * One normalized observation from a work tool (spec 02 §4.1). Written by the daemon after redaction layer 1; never leaves the machine.
 */
export interface ActivityEvent {
  /**
   * Schema version, major.minor; this file is 1.0.
   */
  schemaVersion: "1.0";
  /**
   * ULID assigned at intake.
   */
  eventId: string;
  /**
   * Detected host (spec 02 §8.1).
   */
  host: "claude-code" | "codex" | "cursor" | "chrome";
  /**
   * Host version string (cursor_version, Codex cli_version, Claude Code SessionStart version) if present.
   */
  hostVersion?: string;
  /**
   * keccak256 of the host session id; never the raw id.
   */
  sessionRef: string;
  /**
   * keccak256 of the absolute project root path.
   */
  projectRef: string;
  /**
   * Normalized event type.
   */
  eventType:
    | "tool-call"
    | "tool-result"
    | "tool-failure"
    | "file-read"
    | "file-write"
    | "command"
    | "search"
    | "prompt"
    | "skill-use"
    | "mcp-call"
    | "agent-refusal"
    | "subagent"
    | "session-start"
    | "session-end"
    | "page-visit"
    | "error";
  /**
   * Host time if present, else intake time.
   */
  occurredAt: string;
  /**
   * Host tool name; MCP tool names parsed per spec 02 §8.5.
   */
  toolName?: string;
  /**
   * Parsed MCP tool reference.
   */
  mcp?: {
    /**
     * MCP server name parsed from the tool name.
     */
    server: string;
    /**
     * MCP tool name.
     */
    tool: string;
    /**
     * Plugin name for mcp__plugin_ tools (B1-25).
     */
    plugin?: string;
  };
  /**
   * Short redacted summary of inputs and outputs; redaction markers per spec 02 §3.1.
   */
  summary: string;
  /**
   * Hashed file paths touched.
   *
   * @maxItems 20
   *
   * Items: keccak256 of an absolute file path.
   */
  fileRefs?: string[];
  /**
   * Normalized error class for the repeated-error detector.
   */
  errorClass?: string;
  /**
   * Duration from duration_ms (Claude Code) or duration (Cursor).
   */
  durationMs?: number;
  /**
   * keccak256 of agent_id when inside a subagent (B1-26).
   */
  agentRef?: string;
  /**
   * Where the event came from.
   */
  provenance: {
    /**
     * Host hook event name.
     */
    hookEvent: string;
    /**
     * Source hint such as command_source for skill expansions.
     */
    hookSource?: string;
    /**
     * False when the text came from tool output, pages or last_assistant_message (ASI06 gate).
     */
    trusted: boolean;
    /**
     * Screen flags on the event text (ASI06 gate).
     *
     * Items: Flag set by the screen at intake.
     */
    flags?: "injection-suspect"[];
  };
  /**
   * What redaction removed; counts and rule ids only.
   */
  redaction: {
    /**
     * Layer-1 (secrets) redaction stats.
     */
    layer1: {
      /**
       * Number of layer-1 replacements.
       */
      hits: number;
      /**
       * Rule ids that fired.
       *
       * Items: gitleaks rule id.
       */
      rules: string[];
    };
  };
  /**
   * How many identical events this record merges (memory dedupe rule, CZ-03).
   */
  repeatCount?: number;
}
