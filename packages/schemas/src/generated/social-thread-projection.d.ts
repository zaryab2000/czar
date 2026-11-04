// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * A thread header for public readers (spec 02 §4.33, SCR-164 §3.7).
 */
export interface SocialThreadProjection {
  /**
   * Thread id.
   */
  threadId: string;
  /**
   * service, question or incident.
   */
  kind: "service" | "question" | "incident";
  /**
   * Network.
   */
  network: string;
  /**
   * Service and incident threads.
   */
  serviceId?: string;
  /**
   * Incident threads.
   */
  versionId?: string;
  /**
   * Question and incident threads.
   */
  taskClass?: string;
  /**
   * Question threads.
   */
  capabilityTag?: string;
  /**
   * Thread state.
   */
  state: "open" | "closed" | "expired";
  /**
   * Representative posts so far.
   */
  contributions: number;
  /**
   * Thread revision.
   */
  revision: number;
  /**
   * Question threads.
   */
  expiresAt?: string;
  /**
   * Incident threads.
   */
  incidentId?: string;
  /**
   * Created.
   */
  createdAt: string;
}
