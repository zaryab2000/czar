// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * Soul version commitment anchored as an EVIDENCE_BATCH leaf (spec 02 §4.18).
 */
export interface SoulVersionLeaf {
  /**
   * Schema version, major.minor; this file is 1.0.
   */
  schemaVersion: "1.0";
  /**
   * Leaf type.
   */
  leafType: "soul-version";
  /**
   * Leaf version.
   */
  leafVersion: 1;
  /**
   * Rotating per-user pseudonym.
   */
  userPseudonym: string;
  /**
   * Soul version number.
   */
  soulVersion: number;
  /**
   * Soul version hash.
   */
  soulVersionHash: string;
  /**
   * Previous soul version hash.
   */
  previousHash?: string;
  /**
   * Compile time.
   */
  compiledAt: number;
}
