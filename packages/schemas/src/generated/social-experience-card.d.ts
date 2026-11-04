// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * The public, structured projection of one paid step's outcome for one supplier (spec 02 §4.29, SCR-164 §3.6). The only thing that leaves the server about a purchase. Never carries evidence ids (obs_ ids are derivable from public chain data and would link a handle to a vault; the server keeps the mapping in social_evidence_links), subjects, topic, context, file names, soul text, exact amounts, addresses, payment hashes or objective ids.
 */
export interface SocialExperienceCard {
  /**
   * Card version.
   */
  cardVersion: "1";
  /**
   * The step's network.
   */
  network: string;
  /**
   * x402-exact and gateway-batched rails → x402; erc8183-job → erc8183.
   */
  supplierKind: "x402" | "erc8183";
  /**
   * Czar's service id (not a URL).
   */
  serviceId: string;
  /**
   * The observations' version id; ver_unknown is published as null.
   */
  versionId: string | null;
  /**
   * The observations' task class (SCR-160 §9.1).
   */
  taskClass: string;
  /**
   * The step's capability.
   */
  capabilityTag: string;
  /**
   * The objective's requested output format; format only.
   */
  outputFormat: ("markdown-table" | "csv" | "json" | "markdown-list" | "prose") | null;
  /**
   * Over the step's settled, unreleased calls: all known delivered → delivered; all known undelivered → not-delivered; a mix → partial; no known facts → unknown.
   */
  deliveryOutcome: "delivered" | "partial" | "not-delivered" | "unknown";
  /**
   * The owner's effective rating for this step (ratings_effective), or none. The only quality judgement on the card.
   */
  rating: "good" | "bad" | "none";
  /**
   * Settled, unreleased observations of the step (jobs in Refunded or Expired are not counted; such a step gets no card).
   */
  callsPaid: number;
  /**
   * Of those, delivered = 1.
   */
  callsDelivered: number;
  /**
   * Total paid for the step in USDC, bucketed: the step's unitAmount × callsPaid (a job: unitAmount, its listed price).
   */
  amountBand: "lt-0.01" | "0.01-0.1" | "0.1-1" | "1-5" | "gt-5";
  /**
   * True for a Czar-seeded controlled representative.
   */
  controlled: boolean;
  /**
   * Latest settled_at of the step, truncated to the UTC day (RFC 3339, T00:00:00Z).
   */
  observedAt: string;
}
