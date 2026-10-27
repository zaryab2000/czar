// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * One bounded, consented read of a selected project root (spec 02 §4.26, D90). Local only.
 */
export interface SourceScan {
  /**
   * Schema version, major.minor; this file is 1.0.
   */
  schemaVersion: "1.0";
  /**
   * Scan id.
   */
  scanId: string;
  /**
   * Lowercase hex of the root projectRef (spec 02 §4.26); local only.
   */
  rootId: string;
  /**
   * Read CLAUDE.md, CLAUDE.local.md and AGENTS.md in the root.
   */
  includeAgentFiles: boolean;
  /**
   * Also read the person's global ~/.claude/CLAUDE.md; only on its own selection.
   */
  includeGlobalAgentFile?: boolean;
  /**
   * Read tracked TODO markers and recent commit subjects.
   */
  includeGit: boolean;
  /**
   * Consent record for this scope.
   */
  consentId: string;
  /**
   * Scan state.
   */
  status: "running" | "done" | "failed" | "cancelled";
  /**
   * Files read.
   */
  fileCount: number;
  /**
   * Bytes read.
   */
  byteCount: number;
  /**
   * Skipped items by reason (counts only).
   */
  skipped: {
    /**
     * Sensitive or denied paths.
     */
    sensitivePath: number;
    /**
     * Symlinks or paths outside the root.
     */
    outsideRoot: number;
    /**
     * Files above soulInput.scanMaxBytesPerFile.
     */
    oversized: number;
    /**
     * Untracked or ignored files not selected by name.
     */
    untracked: number;
    /**
     * Binary or non-UTF-8 files.
     */
    nonText: number;
  };
  /**
   * Proposals created.
   */
  proposalCount: number;
  /**
   * Paragraphs P-01 flagged and removed before P-07.
   */
  suspiciousSkipped: number;
  /**
   * Start time.
   */
  startedAt: string;
  /**
   * End time.
   */
  endedAt?: string;
}
