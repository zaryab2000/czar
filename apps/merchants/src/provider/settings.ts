// The instances' settings from `@czar/config` and the CZ-20 §5.11 safety rule: never on a mainnet.
import { ARC_TESTNET_CHAIN_ID, type Config, type ParameterKey } from "@czar/config";
import { PROVIDER_INSTANCES, type ProviderInstanceId } from "#src/provider/modes";

/** The local arc-anvil chain the job tests use; `@czar/config` and the signer's `provider-call` also accept it. */
export const LOCAL_ARC_ANVIL_CHAIN_ID = 31337;

/** Chains a test provider runs on. Every other chain id counts as a mainnet (fail closed). */
export const PROVIDER_TEST_CHAIN_IDS: readonly number[] = [
  ARC_TESTNET_CHAIN_ID,
  LOCAL_ARC_ANVIL_CHAIN_ID,
];

export const PROVIDER_INSTANCE_IDS = Object.keys(PROVIDER_INSTANCES) as ProviderInstanceId[];

export interface ProviderSettings {
  readonly instance: ProviderInstanceId;
  readonly modes: readonly string[];
  readonly minWorkSeconds: number;
  readonly pollMs: number;
}

/** `merchants.provider.enabled`, forced false on any chain that is not a test chain (CZ-20 §5.11 Limits). */
export function providerEnabled(config: Pick<Config, "get">, chainId: number): boolean {
  if (!PROVIDER_TEST_CHAIN_IDS.includes(chainId)) return false;
  return config.get("merchants.provider.enabled") === true;
}

export function providerSettings(
  config: Pick<Config, "get">,
  instance: ProviderInstanceId,
): ProviderSettings {
  const modes = config.get(`merchants.provider.${instance}.modes` as ParameterKey);
  if (!Array.isArray(modes) || !modes.every((mode) => typeof mode === "string"))
    throw new Error(`merchants.provider.${instance}.modes must be a list of mode names`);
  return {
    instance,
    modes: modes as readonly string[],
    minWorkSeconds: Number(
      config.get(`merchants.provider.${instance}.minWorkSeconds` as ParameterKey),
    ),
    pollMs: Number(config.get("merchants.provider.pollMs")),
  };
}
