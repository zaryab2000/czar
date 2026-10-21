export const HALT_PATHS = {
  usdc: ["x402-exact", "gateway-nano", "erc8183-job"],
  gatewayWallet: ["gateway-nano"],
  gatewayMinter: ["gateway-nano"],
  erc8183: ["erc8183-job"],
} as const;

export type HaltPath = (typeof HALT_PATHS)[keyof typeof HALT_PATHS][number];
export type PinnedProxy = keyof typeof HALT_PATHS;

export function lagAlert(head: bigint, indexed: bigint, maxLagBlocks: number): bigint | null {
  const lag = head - indexed;
  return lag > BigInt(maxLagBlocks) ? lag : null;
}

export function reserveRateAlert(count: number, limit: number): boolean {
  return count > limit;
}

export function haltPaths(proxy: PinnedProxy, event: string): readonly HaltPath[] {
  if (event === "Upgraded") return HALT_PATHS[proxy];
  if (
    proxy === "erc8183" &&
    ["RoleGranted", "HookWhitelistUpdated", "PlatformFeeUpdated", "EvaluatorFeeUpdated"].includes(
      event,
    )
  ) {
    return HALT_PATHS.erc8183;
  }
  return [];
}

/**
 * Lag monitor: checks at most once per `intervalMs` of wall time and pages once per episode
 * (when the indexer first falls behind), so a backfill does not issue one RPC call and one page
 * per historical block.
 */
export function createLagMonitor(intervalMs: number) {
  let lastCheckMs = Number.NEGATIVE_INFINITY;
  let lagging = false;
  return {
    shouldCheck(nowMs: number): boolean {
      if (nowMs - lastCheckMs < intervalMs) return false;
      lastCheckMs = nowMs;
      return true;
    },
    /** Returns true when this observation should page. */
    observe(lag: bigint | null): boolean {
      if (lag === null) {
        lagging = false;
        return false;
      }
      if (lagging) return false;
      lagging = true;
      return true;
    },
  };
}

/** A rate bucket older than its own width in wall time is history (backfill, re-index), not a
 * live anomaly; it is still counted but never pages. */
export function isLiveBucket(nowSeconds: bigint, bucketTimestamp: bigint, widthSeconds: bigint) {
  return nowSeconds - bucketTimestamp <= widthSeconds;
}
