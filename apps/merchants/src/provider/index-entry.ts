// The labelling a test-provider instance's `erc8183-job` index entry carries (CZ-20 §5.11 Instances): Czar's
// test-merchant source and flag, and the "Czar test provider" label, like the D83 lab.
//
// Only the fields CZ-20 §5.11 and 02 §12.2 name are built here. 02 §12.2 has no item shape for an `erc8183-job`
// service (no `resource` or `accepts[]` apply), and registering the entry in the index is selection code; both
// are left to the spec change and PM-045 (see the PM-046 report).
import { serviceId, type Address } from "@czar/hashing";
import type { ProviderInstanceId } from "#src/provider/modes";
import type { WorkMode } from "#src/provider/work";

export const TEST_PROVIDER_LABEL = "Czar test provider";
/** `extensions.czar.source` of every Czar test merchant (CZ-20 §5.8a, §5.11). */
export const SOURCE_CZAR_TEST_MERCHANT = "czar-test-merchant";

export interface ProviderIndexEntry {
  readonly serviceName: ProviderInstanceId;
  readonly description: string;
  readonly tags: readonly string[];
  readonly extensions: {
    readonly czar: {
      readonly serviceId: string;
      readonly source: typeof SOURCE_CZAR_TEST_MERCHANT;
      readonly testMerchant: true;
    };
  };
  readonly metadata: { readonly provider: { readonly name: typeof TEST_PROVIDER_LABEL } };
}

export function providerIndexEntry(input: {
  readonly instance: ProviderInstanceId;
  /** CAIP-2 network, `eip155:<chainId>`. */
  readonly network: string;
  readonly providerAddress: Address;
  readonly escrow: Address;
  /** The instance's enabled work modes; their capabilities are the entry's tags. */
  readonly workModes: readonly WorkMode[];
}): ProviderIndexEntry {
  return {
    serviceName: input.instance,
    description: `${TEST_PROVIDER_LABEL} (${input.instance}): an ERC-8183 provider Czar runs for testing`,
    tags: [...new Set(input.workModes.flatMap((mode) => mode.capabilities))],
    extensions: {
      czar: {
        serviceId: serviceId(input.network, input.providerAddress, input.escrow),
        source: SOURCE_CZAR_TEST_MERCHANT,
        testMerchant: true,
      },
    },
    metadata: { provider: { name: TEST_PROVIDER_LABEL } },
  };
}
