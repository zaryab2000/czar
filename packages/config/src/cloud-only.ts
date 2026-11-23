// Cloud startup guard (SCR-170 §3). The mirror of local-only.ts: every cloud entry point calls
// validateCloudConfig before it builds anything, and refuses to start when any rule fails.
// Messages name keys only, never values.
import { ConfigError } from "./errors.ts";
import type { Config } from "./loader.ts";

/** Arc testnet: the only chain any Czar process may use (CLAUDE.md). */
export const ARC_TESTNET_CHAIN_ID = 5042002;

/** Chain ids that are test chains. Anything else counts as mainnet, so the check fails closed. */
const TEST_CHAIN_IDS: readonly number[] = [ARC_TESTNET_CHAIN_ID, 31337];

export type CloudRole = "server" | "signer" | "merchants" | "indexer";

export interface CloudGuardOptions {
  readonly config: Config;
  /** Which process is starting; only `signer` reads `signer.backend`. */
  readonly role: CloudRole;
  /** From the deployment file, confirmed by `eth_chainId`. The registry has no chain-id key. */
  readonly chainId: number;
  /** Every RPC URL this process will use. Some arrive as pointers, not config. */
  readonly rpcUrls: readonly string[];
}

/** Refuses to start unless every SCR-170 §3 rule holds. Throws ConfigError, never returns false. */
export function validateCloudConfig(options: CloudGuardOptions): void {
  const { config, role, chainId, rpcUrls } = options;

  if (config.get("deploy.environment") !== "cloud-testnet")
    throw refuse("deploy.environment", "deploy.environment must be cloud-testnet in the cloud");

  if (chainId !== ARC_TESTNET_CHAIN_ID)
    throw refuse("chainId", `the chain id must be Arc testnet ${ARC_TESTNET_CHAIN_ID}`);

  const paymentNetwork = config.get("selection.paymentNetwork");
  if (typeof paymentNetwork !== "string")
    throw refuse("selection.paymentNetwork", "selection.paymentNetwork must be a CAIP-2 string");
  const paymentChainId = caip2ChainId(paymentNetwork);
  if (paymentChainId === undefined)
    throw refuse(
      "selection.paymentNetwork",
      "selection.paymentNetwork must be an eip155 CAIP-2 chain",
    );
  // Checked before the agreement rule below, so a mainnet payment network with the lab on is
  // refused for the lab, which is the dangerous half of that pair (CZ-20).
  if (config.get("merchants.lab.enabled") === true && !TEST_CHAIN_IDS.includes(paymentChainId))
    throw refuse(
      "merchants.lab.enabled",
      "merchants.lab.enabled must be false unless the payment network is a test chain (CZ-20)",
    );

  if (paymentChainId !== chainId)
    throw refuse(
      "selection.paymentNetwork",
      "selection.paymentNetwork must name the same chain as the deployment",
    );

  const allowedHosts = config.get("deploy.allowedRpcHosts");
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0)
    throw refuse("deploy.allowedRpcHosts", "deploy.allowedRpcHosts must list at least one host");
  if (rpcUrls.length === 0)
    throw refuse("deploy.allowedRpcHosts", "a cloud process must be given at least one RPC URL");
  for (const candidate of rpcUrls) {
    const host = httpsHost(candidate);
    if (host === undefined || !allowedHosts.includes(host))
      throw refuse(
        "deploy.allowedRpcHosts",
        "every RPC URL must be https with a host in deploy.allowedRpcHosts",
      );
  }

  requireHttpsOrigin(config, "app.origin");
  requireHttpsOrigin(config, "merchants.publicOrigin");

  // The key has no default, so check has() before get().
  if (config.has("fetch.localStandinOrigins")) {
    const standins = config.get("fetch.localStandinOrigins");
    if (!Array.isArray(standins))
      throw refuse("fetch.localStandinOrigins", "fetch.localStandinOrigins must be a list");
    if (standins.length > 0)
      throw refuse(
        "fetch.localStandinOrigins",
        "fetch.localStandinOrigins must be empty in the cloud: it names local-only stand-ins",
      );
  }

  if (role === "signer" && config.get("signer.backend") !== "gcp-kms")
    throw refuse("signer.backend", "the cloud signer must use the gcp-kms backend (D70)");
}

function requireHttpsOrigin(config: Config, key: "app.origin" | "merchants.publicOrigin"): void {
  const value = config.has(key) ? config.get(key) : undefined;
  if (typeof value !== "string" || httpsHost(value) === undefined)
    throw refuse(key, `${key} must be an https origin in the cloud`);
}

/** The host of an https URL with no credentials, query or fragment; undefined when it is not one. */
function httpsHost(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return undefined;
    if (url.username !== "" || url.password !== "") return undefined;
    if (url.search !== "" || url.hash !== "") return undefined;
    if (url.hostname === "") return undefined;
    return url.hostname;
  } catch {
    return undefined;
  }
}

/** The numeric chain id of an `eip155:<id>` namespace key, or undefined. */
function caip2ChainId(value: string): number | undefined {
  const match = /^eip155:([0-9]{1,19})$/.exec(value);
  if (match === null) return undefined;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : undefined;
}

function refuse(key: string, message: string): ConfigError {
  return new ConfigError("invalid-value", key, `refusing to start: ${message}`);
}
