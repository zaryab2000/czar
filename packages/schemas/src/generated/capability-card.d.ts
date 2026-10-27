// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * What a service or job provider really does (spec 02 §4.27, D91). Built by Czar from the seller's own 402 (extensions.bazaar), Czar's probes, Czar's receipts and registrations. Never copied from Circle's catalog. Retrieval-only: a card never changes a score.
 */
export interface CapabilityCard {
  /**
   * Schema version, major.minor; this file is 1.0.
   */
  schemaVersion: "1.0";
  /**
   * Service.
   */
  serviceId: string;
  /**
   * Network the card was observed on; payment-network and market-network cards are separate.
   */
  network: string;
  /**
   * Payment path the card describes.
   */
  rail: "x402-exact" | "gateway-batched" | "erc8183-job";
  /**
   * Seller-declared name, sanitized (A3-36); retrieval text only.
   */
  serviceName?: string;
  /**
   * Input field names and types from the sanitized bazaar schema; descriptions dropped.
   *
   * @maxItems 50
   *
   * Items: Field.
   */
  inputFields: {
    /**
     * Name.
     */
    name: string;
    /**
     * JSON type.
     */
    type: "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";
  }[];
  /**
   * Output field names and types; same rules.
   *
   * @maxItems 50
   *
   * Items: Field.
   */
  outputFields: {
    /**
     * Name.
     */
    name: string;
    /**
     * JSON type.
     */
    type: "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";
  }[];
  /**
   * Declared output media type.
   */
  mimeType?: string;
  /**
   * Result formats the service itself returns, when its output is delivered as-is (jobs, agent-assist); empty for JSON data services whose output Czar assembles locally.
   *
   * @maxItems 5
   *
   * Items: Format.
   */
  outputFormats?: ("markdown-table" | "csv" | "json" | "markdown-list" | "prose")[];
  /**
   * Task classes the service is retrievable for.
   *
   * @maxItems 10
   *
   * Items: Task class.
   */
  taskClasses: string[];
  /**
   * Capability tags it matched or was registered with.
   *
   * @maxItems 10
   *
   * Items: Tag.
   */
  capabilities: string[];
  /**
   * Czar's own measurements.
   */
  observed?: {
    /**
     * Last live 402 price.
     */
    livePrice?: string;
    /**
     * Median probe or call latency.
     */
    latencyP50Ms?: number;
    /**
     * Last probe.
     */
    lastProbedAt?: string;
  };
  /**
   * Needs it delivered before, as counts by TaskSpec kind and capability. No field names, subjects or other user text (they would move one user's task text into a shared record).
   *
   * @maxItems 20
   *
   * Items: Need.
   */
  solvedNeeds?: {
    /**
     * TaskSpec kind.
     */
    kind: string;
    /**
     * Capability the step served.
     */
    capability: string;
    /**
     * Accepted deliveries.
     */
    count: number;
  }[];
  /**
   * True when the live 402 carried extensions.bazaar.
   */
  bazaarDeclared: boolean;
  /**
   * keccak256 of the sanitized bazaar schema (jcs); a change makes a new service version (SL-C1).
   */
  schemaHash?: string;
  /**
   * Where the card's data came from.
   *
   * @minItems 1
   * @maxItems 4
   *
   * Items: Source.
   */
  sources: ("seller-402" | "czar-probe" | "czar-receipt" | "registration")[];
  /**
   * Last update.
   */
  updatedAt: string;
}
