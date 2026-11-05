// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * Body of POST /v1/app/objectives: a task a signed-in owner starts in the browser (SCR-181 §2). Exactly one of contractSource or contractAddress is present; an empty contractSource counts as absent.
 */
export type AppObjectiveRequest = {
  /**
   * What the task is; one value for Demo v1, extended by SCR.
   */
  kind: "smart-contract-audit";
  /**
   * Short name of the task; becomes taskSpec.topic and the subject label after layer 1.
   */
  title: string;
  /**
   * What the owner wants; becomes the goal after layer 1.
   */
  description: string;
  /**
   * Contract source; becomes taskSpec.context after layer 1. At most app.objectiveMaxSourceChars (2000) characters.
   */
  contractSource?: string;
  /**
   * A verified contract's address, instead of its source.
   */
  contractAddress?: string;
  /**
   * Optional budget for the whole task; becomes constraints.maxTotal.
   */
  maxTotal?: string;
} & {
  [k: string]: unknown;
};
