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
