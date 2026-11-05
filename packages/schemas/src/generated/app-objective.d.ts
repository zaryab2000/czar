// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * One of the owner's tasks as the web app lists it, whether started in the browser or on a paired device (SCR-181 §2).
 */
export interface AppObjective {
  /**
   * The objective's id.
   */
  objectiveId: string;
  /**
   * The task's taskSpec.topic, after layer 1.
   */
  title: string;
  /**
   * smart-contract-audit for a code-review task; otherwise the task's taskSpec.kind.
   */
  kind: string;
  /**
   * The objective status (RV-027).
   */
  state:
    | "received"
    | "planning"
    | "no-supplier"
    | "awaiting-approval"
    | "opening"
    | "executing"
    | "replanning"
    | "delivered"
    | "failed"
    | "expired"
    | "dismissed";
  /**
   * The objective's plan, once one exists.
   */
  planId?: string;
  /**
   * When the objective was received.
   */
  createdAt: string;
  /**
   * When its state last changed.
   */
  updatedAt: string;
  /**
   * web for a task started in the browser, device for one from a paired device.
   */
  origin: "web" | "device";
}
