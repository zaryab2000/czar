// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * One belief with receipts.
 *
 * This interface was referenced by `Soul`'s JSON-Schema
 * via the `definition` "Belief".
 */
export type Belief = {
  /**
   * Stable id across versions while the belief lives.
   */
  beliefId: string;
  /**
   * The belief in plain words; markers allowed. Only becomes redacted-to-server when selected as a compilation excerpt (D31).
   */
  text: string;
  /**
   * Confidence 0 to 1. For confidenceBasis user-confirmed it is 1 and means the person attested the belief, not statistical certainty (D90).
   */
  confidence: number;
  /**
   * First observation, or the confirmation time for a user-confirmed belief.
   */
  firstSeen: string;
  /**
   * Last observation, or the last confirmation or edit for a user-confirmed belief; observed beliefs fade when not seen, user-confirmed ones do not (D90).
   */
  lastSeen: string;
  /**
   * Observations or source receipts behind the belief (D90).
   *
   * @maxItems 50
   *
   * Items: An event id (observed) or a source receipt id (D90).
   */
  receipts: string[];
  /**
   * True after the person edits or pins it.
   */
  userEdited: boolean;
  /**
   * Belief lifecycle state (CZ-04). Only active and faded beliefs render to SOUL.md.
   */
  state?: "candidate" | "active" | "faded" | "archived";
  /**
   * Normalized dedupe key used to merge repeated observations into one belief. Never leaves the machine.
   */
  key?: string;
  /**
   * The source class that created the belief (D90). A supporting receipt never changes it.
   */
  sourceClass: "observed" | "declared" | "local-file" | "imported";
  /**
   * observation-score: CZ-04 §5.2 formula. user-confirmed: the person declared or accepted it in the local viewer (D90).
   */
  confidenceBasis: "observation-score" | "user-confirmed";
  /**
   * True when the person declared or accepted the belief in the local viewer (D90).
   */
  userConfirmed: boolean;
  /**
   * When the person declared or accepted the belief (D90).
   */
  confirmedAt?: string;
};

/**
 * The machine-readable Work Soul (spec 02 §4.2): eight sections of beliefs with receipts. Local only.
 */
export interface Soul {
  /**
   * Schema version, major.minor; this file is 1.2 (2026-10-20: Belief source fields and typed receipts, D90). 1.1 files migrate by setting sourceClass observed, confidenceBasis observation-score, userConfirmed false.
   */
  schemaVersion: "1.2";
  /**
   * Monotonically increasing per compile.
   */
  version: number;
  /**
   * Compile time.
   */
  compiledAt: string;
  /**
   * soulVersionHash of version minus 1.
   */
  previousHash?: string;
  /**
   * The eight soul sections.
   */
  sections: {
    /**
     * Beliefs in the place section.
     */
    place: Belief[];
    /**
     * Beliefs in the mission section.
     */
    mission: Belief[];
    /**
     * Beliefs in the rituals section.
     */
    rituals: Belief[];
    /**
     * Beliefs in the friction section.
     */
    friction: Belief[];
    /**
     * Beliefs in the drives section.
     */
    drives: Belief[];
    /**
     * Beliefs in the taste section.
     */
    taste: Belief[];
    /**
     * Beliefs in the constraints section.
     */
    constraints: Belief[];
    /**
     * Beliefs in the spendingPosture section.
     */
    spendingPosture: Belief[];
  };
  /**
   * Hourly value of the person's time; only the band leaves the machine.
   */
  hourlyValue?: {
    /**
     * Hourly value in USDC atomic units.
     */
    amount: string;
    /**
     * Always USD in Phase 1 (D51; RV-047). Kept for forward compatibility.
     */
    currency: "USD";
    /**
     * True when the person set it.
     */
    setByUser: boolean;
  };
  /**
   * What may be sent to the hosted model for compilation.
   */
  excerptPolicy: {
    /**
     * Maximum characters of redacted excerpt sent to the hosted model (D31).
     */
    maxChars: number;
    /**
     * Sections eligible for excerpts.
     *
     * Items: Section name.
     */
    allowSections: (
      "place" | "mission" | "rituals" | "friction" | "drives" | "taste" | "constraints" | "spendingPosture"
    )[];
  };
}
