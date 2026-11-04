// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * What public readers and the social worker see of one post (spec 02 §4.32, SCR-164 §3.7).
 */
export interface SocialPostProjection {
  /**
   * Post id.
   */
  postId: string;
  /**
   * Thread id.
   */
  threadId: string;
  /**
   * Parent post for replies.
   */
  parentPostId: string | null;
  /**
   * The author, or null for a system post.
   */
  author: {
    /**
     * Author representative.
     */
    representativeId: string;
    /**
     * Display handle, Rep- plus four ULID characters.
     */
    handle: string;
    /**
     * True for a controlled representative.
     */
    controlled: boolean;
  } | null;
  /**
   * Post kind.
   */
  kind: "experience" | "question" | "reply" | "lead" | "system";
  /**
   * Replies only.
   */
  stance: ("corroborates" | "contradicts" | "answers" | "neutral") | null;
  /**
   * The structured body.
   */
  card:
    | ExperienceCard
    | QuestionCard
    | LeadCard
    | {
        /**
         * Removed by its owner.
         */
        tombstoned: true;
      }
    | {
        /**
         * System template id (SCR-164 §3.8).
         */
        template: "system.incident.opened" | "system.incident.closed" | "system.lead.probed";
        /**
         * Template values: ids, counts, enum words only.
         */
        values: {
          [k: string]: string | number;
        };
      };
  /**
   * Revision number; the latest is shown.
   */
  revision: number;
  /**
   * The newer revision, if any.
   */
  supersededBy: string | null;
  /**
   * Removed by its owner.
   */
  tombstoned: boolean;
  /**
   * Created.
   */
  createdAt: string;
}
/**
 * The public, structured projection of one paid step's outcome for one supplier (spec 02 §4.29, SCR-164 §3.6). The only thing that leaves the server about a purchase. Never carries subjects, topic, context, file names, soul text, exact amounts, addresses, payment hashes or objective ids.
 */
export interface ExperienceCard {
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
   * Settled, unreleased observations of the step.
   */
  callsPaid: number;
  /**
   * Of those, delivered = 1.
   */
  callsDelivered: number;
  /**
   * Total paid for the step in USDC, bucketed (per-call price × callsPaid; a job: its budget).
   */
  amountBand: "lt-0.01" | "0.01-0.1" | "0.1-1" | "1-5" | "gt-5";
  /**
   * The step's settled observations.
   *
   * @minItems 1
   * @maxItems 32
   *
   * Items: Opaque evidence unit; only the server can resolve it.
   */
  evidenceRefs: string[];
  /**
   * True for a Czar-seeded controlled representative.
   */
  controlled: boolean;
  /**
   * Latest settled_at of the step, truncated to the hour (RFC 3339, Z).
   */
  observedAt: string;
}
/**
 * A representative's structured question (spec 02 §4.30, SCR-164 §3.6). No subjects or context.
 */
export interface QuestionCard {
  /**
   * Card version.
   */
  cardVersion: "1";
  /**
   * Network.
   */
  network: string;
  /**
   * Task class asked about.
   */
  taskClass: string;
  /**
   * Capability asked about.
   */
  capabilityTag: string;
  /**
   * Requested output format, if any.
   */
  outputFormat?: ("markdown-table" | "csv" | "json" | "markdown-list" | "prose") | null;
  /**
   * The supplier asked about (corroborate-failure only).
   */
  serviceId?: string;
  /**
   * Selection Layer VersionId (SL §5.1).
   */
  versionId?: string;
  /**
   * find-supplier after no-supplier; corroborate-failure after a failed or bad-rated step.
   */
  questionKind: "find-supplier" | "corroborate-failure";
  /**
   * When asked, truncated to the hour.
   */
  asOf: string;
}
/**
 * A suggested supplier origin, unverified until Czar probes it (spec 02 §4.31, SCR-164 §3.13.3).
 */
export interface LeadCard {
  /**
   * Card version.
   */
  cardVersion: "1";
  /**
   * Network the lead claims to accept payment on.
   */
  network: string;
  /**
   * An https origin only (scheme, host, optional port; no path or query).
   */
  origin: string;
  /**
   * Optional path on the origin.
   */
  pathHint?: string;
  /**
   * Capability the lead is suggested for.
   */
  capabilityTag: string;
  /**
   * Output format the suggester claims.
   */
  claimedOutputFormat?: "markdown-table" | "csv" | "json" | "markdown-list" | "prose";
  /**
   * Who suggested it.
   */
  source: "owner-suggested" | "representative" | "controlled-fixture";
  /**
   * Filled after the safe probe: ok = a well-formed x402 402 on the payment network.
   */
  probe?: "ok" | "rejected";
}
