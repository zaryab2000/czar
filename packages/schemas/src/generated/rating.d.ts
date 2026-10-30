// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * The paying owner's good or bad on one producing step of one delivered objective, bound to every settled receipt of that step (spec 02 §4.28, SCR-160). The only supplier quality signal.
 */
export interface Rating {
  /**
   * Schema version, major.minor; this file is 1.0.
   */
  schemaVersion: "1.0";
  /**
   * Server-minted id.
   */
  ratingId: string;
  /**
   * The owner who rated.
   */
  userId: string;
  /**
   * The vault that paid every bound receipt.
   */
  vault: string;
  /**
   * The delivered objective.
   */
  objectiveId: string;
  /**
   * The producing step (Result.provenance entry with accepted = true).
   */
  stepIndex: number;
  /**
   * From the bound receipts.
   */
  network: string;
  /**
   * The supplier, from the bound receipts.
   */
  serviceId: string;
  /**
   * The service version at call time, or ver_unknown.
   */
  versionId: string;
  /**
   * Task class of the step.
   */
  taskClass: string;
  /**
   * The owner's judgement. Binary; never a number.
   */
  value: "good" | "bad";
  /**
   * Every eligible receipt of the step at write time; resolved by the server, never trusted from the client.
   *
   * @minItems 1
   * @maxItems 4096
   *
   * Items: A bound receipt.
   */
  obsIds: string[];
  /**
   * Set by the route that accepted the rating.
   */
  surface: "cli" | "web";
  /**
   * The owner's earlier rating for the same objective and step that this one corrects; at most one correction per step.
   */
  supersedes: string | null;
  /**
   * Server time.
   */
  createdAt: string;
}
