// Whether the lab runs in this process, and with what (CZ-20 §5.8a "Never on mainnet", T-106).
//
// The lab is registered only through `createAlphaMerchantServer`, and only when the caller asks for it
// (`lab` option) or the seed key is set. `local-main.ts` never asks, so the local merchant process still
// serves `czar-search` alone even though `merchants.lab.enabled` defaults to `true`.
import type { Config } from "@czar/config";
import type { Logger } from "@czar/logging";
import type { SafeFetch } from "@czar/x402";
import type { MerchantServerOptions, MerchantServiceSpec } from "@czar/merchants/runtime";
import { isTestNetwork } from "./profiles.ts";
import { labServiceSpecs } from "./services.ts";

/** What a caller passes to ask for the lab. */
export interface LabRegistration {
  /**
   * The seed every profile is drawn from. `merchants.lab.seed` is the spec's key for it, but the config
   * loader refuses any key whose name contains `seed` (D78), so that key cannot be set; the caller passes the
   * seed here until a spec change fixes the name. A value set under the key is used when this is left out.
   */
  readonly seed?: number;
  /**
   * The signer key reference of the second Czar-owned payee `lab-spot-payee-swap` names (CZ-20 §5.8a). The
   * specs do not name it yet; left out, that one service is not registered.
   */
  readonly payeeSwapKeyRef?: string;
  /** Test seam for `lab-search-slow`'s delay. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test seam for the clock `lab-spot-payee-swap` reads. */
  readonly now?: () => number;
}

export async function resolveLabServices(options: {
  readonly config: Config;
  readonly signer: MerchantServerOptions["signer"];
  readonly logger: Logger;
  readonly safeFetch: SafeFetch;
  readonly lab: LabRegistration | undefined;
}): Promise<readonly MerchantServiceSpec[]> {
  const { config, lab } = options;
  // Not asked for: today's behaviour, no lab key is looked up and no lab route exists.
  if (lab === undefined && !config.has("merchants.lab.seed")) return [];

  if (config.get("merchants.lab.enabled") !== true) {
    options.logger.info("merchant_lab_off", {});
    return [];
  }
  // Forced off on any network that is not a known test chain, whatever `merchants.lab.enabled` says.
  if (!isTestNetwork(String(config.get("selection.paymentNetwork")))) {
    options.logger.warn("merchant_lab_forced_off", {});
    return [];
  }

  const seed =
    lab?.seed ??
    (config.has("merchants.lab.seed") ? Number(config.get("merchants.lab.seed")) : undefined);
  if (seed === undefined) throw new Error("merchant_lab_seed_missing");
  // Throws a ConfigError naming the key when no price is set: an asked-for lab does not start unpriced.
  config.get("merchants.lab.priceAtomic");

  let swapPayTo: string | undefined;
  if (lab?.payeeSwapKeyRef !== undefined) {
    try {
      swapPayTo = await options.signer.keyAddress("cz-20", lab.payeeSwapKeyRef);
    } catch (error) {
      throw new Error("merchant_signer_unavailable", { cause: error });
    }
  }

  return labServiceSpecs({
    config,
    safeFetch: options.safeFetch,
    seed,
    swapPayTo,
    ...(lab?.sleep === undefined ? {} : { sleep: lab.sleep }),
    ...(lab?.now === undefined ? {} : { now: lab.now }),
  });
}
