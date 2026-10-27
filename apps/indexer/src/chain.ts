// Arc testnet chain settings for the indexer (CZ-19 §5.1, cross-cutting §3.1).
export const ARC_TESTNET_CHAIN_ID = 5042002;
/** A9-08: the only Arc testnet RPC host in the Arc docs. `rpc.testnet.arc.network` does not resolve. */
export const ARC_TESTNET_PUBLIC_RPC = "https://rpc.testnet.arc.io";

/** Resolve the RPC endpoint Ponder actually uses for indexing. */
export function resolveIndexerRpcUrl(configuredUrl: string | undefined): string {
  return configuredUrl ?? ARC_TESTNET_PUBLIC_RPC;
}
