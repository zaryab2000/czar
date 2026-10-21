// Generated from docs/specs/02-data-and-protocol/schemas. Do not edit.

/**
 * Lane A of D83: real services on the market network, checked by unpaid 402 probes only. Never payable in Phase 1, never a quality ranking (spec 02 §4.22).
 */
export interface MarketView {
  /**
   * Schema version.
   */
  schemaVersion: "1.0";
  /**
   * View id.
   */
  viewId: string;
  /**
   * Capability queried.
   */
  capability: string;
  /**
   * selection.marketNetwork.
   */
  network: string;
  /**
   * selection.paymentNetwork, shown so readers see the split.
   */
  paymentNetwork: string;
  /**
   * When the view was built.
   */
  generatedAt: string;
  /**
   * Freshness of the live catalog page (cached ≤ 3,600 s, p1-D2).
   */
  catalogFetchedAt?: string;
  /**
   * Totals for this capability.
   */
  counts: {
    /**
     * Listings matched.
     */
    listed: number;
    /**
     * Probed in this view.
     */
    probed: number;
    /**
     * Tier ready.
     */
    ready: number;
  };
  /**
   * Over tier-ready rows only.
   */
  priceSummary?: {
    /**
     * Lowest live price.
     */
    low?: string;
    /**
     * Median live price.
     */
    median?: string;
  };
  /**
   * Ordered by tier (ready first), then live price ascending.
   *
   * @maxItems 50
   *
   * Items: One real-market service.
   */
  services: {
    /**
     * Selection Layer service id.
     */
    serviceId: string;
    /**
     * Endpoint URL as listed (allowed field, p1-D8).
     */
    resource: string;
    /**
     * Always selection.marketNetwork in Phase 1.
     */
    network: string;
    /**
     * Always false in Phase 1 (D83 point 3).
     */
    payable: false;
    /**
     * Readiness tier from the unpaid probe; not a quality score.
     */
    tier: "ready" | "listing-mismatch" | "unreachable" | "not-probed";
    /**
     * Rail from the live 402.
     */
    rail?: "x402-exact" | "gateway-batched" | "erc8183-job";
    /**
     * Price from the live 402; absent if not reachable.
     */
    livePrice?: string;
    /**
     * Price in the catalog listing.
     */
    listedPrice?: string;
    /**
     * Payee from the live 402.
     */
    payTo?: string;
    /**
     * Czar's own unpaid probe outcome.
     */
    probe: {
      /**
       * When Czar probed.
       */
      probedAt: string;
      /**
       * A 402 came back within selection.probeTimeoutMs.
       */
      reachable: boolean;
      /**
       * The 402 parsed as x402 v2 (02 §11.2).
       */
      wellFormed?: boolean;
      /**
       * Live amount equals the listed amount.
       */
      priceMatchesListing?: boolean;
      /**
       * Live payTo equals the listed payTo.
       */
      payToMatchesListing?: boolean;
      /**
       * Time to the 402 response.
       */
      latencyMs?: number;
      /**
       * Share of Czar's unpaid probes in 7 days that were reachable and well-formed.
       */
      successRate7d?: number;
      /**
       * Number of probes behind successRate7d.
       */
      probes7d?: number;
    };
    /**
     * Fixed wording (CZ-18 §12).
     */
    label: string;
  }[];
  /**
   * Always the fixed notice text (CZ-18 §12).
   */
  notice: string;
}
