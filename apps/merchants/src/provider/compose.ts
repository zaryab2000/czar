// The provider's own composition (not a merchant route): both instances from config, or none when the provider
// is disabled or the chain is not a test chain.
import type { Config } from "@czar/config";
import type { Address } from "@czar/hashing";
import type { Logger } from "@czar/logging";
import { createProviderInstance, type JobOutcome, type ProviderInstance } from "#src/provider/loop";
import type { JobServer, ProviderChain, ProviderSigner } from "#src/provider/ports";
import { PROVIDER_INSTANCE_IDS, providerEnabled, providerSettings } from "#src/provider/settings";
import type { WorkMode } from "#src/provider/work";

export interface ProviderCompositionInput {
  readonly config: Pick<Config, "get">;
  readonly chainId: number;
  readonly evaluator: Address;
  readonly signer: ProviderSigner;
  readonly chain: ProviderChain;
  readonly server: JobServer;
  readonly workModes?: readonly WorkMode[];
  readonly logger?: Pick<Logger, "info" | "warn">;
  readonly onOutcome?: (outcome: JobOutcome) => void;
}

export interface ComposedProviders {
  /** Empty when `merchants.provider.enabled` is false or the chain is a mainnet. */
  readonly instances: readonly ProviderInstance[];
}

export function composeProviders(input: ProviderCompositionInput): ComposedProviders {
  if (!providerEnabled(input.config, input.chainId)) return { instances: [] };
  return {
    instances: PROVIDER_INSTANCE_IDS.map((instance) => {
      const settings = providerSettings(input.config, instance);
      return createProviderInstance({
        ...settings,
        chainId: input.chainId,
        evaluator: input.evaluator,
        signer: input.signer,
        chain: input.chain,
        server: input.server,
        ...(input.workModes === undefined ? {} : { workModes: input.workModes }),
        ...(input.logger === undefined ? {} : { logger: input.logger }),
        ...(input.onOutcome === undefined ? {} : { onOutcome: input.onOutcome }),
      });
    }),
  };
}
