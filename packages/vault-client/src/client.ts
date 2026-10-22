// T-026: typed contract handles over the compiled interfaces (viem 2.57.x). Every call and its arguments are typed
// from the ABI, so a renamed function or a wrong argument fails at compile time.
import { getContract, type Address, type Client, type PublicClient } from "viem";
import { czarVaultAbi, czarVaultFactoryAbi } from "./abi.ts";

export const usdcBalanceAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
] as const;

export interface PinnedVaultReads {
  readonly vaultBalance: bigint;
  readonly free: bigint;
  readonly committed: bigint;
  readonly frozen: boolean;
  readonly paused: boolean;
  readonly limits: readonly {
    readonly categoryId: `0x${string}`;
    readonly userMax: bigint;
    readonly autoLimit: bigint;
    readonly usedInPeriod: bigint;
    readonly periodId: bigint;
  }[];
}

export const getVault = (address: Address, client: Client | { public: Client; wallet?: Client }) =>
  getContract({ address, abi: czarVaultAbi, client });

/** Reads the next envelope counter from a Czar vault. */
export async function readEnvelopeCount(input: {
  readonly client: PublicClient;
  readonly vault: Address;
}): Promise<bigint> {
  return getVault(input.vault, input.client).read.envelopeCount();
}

export const getVaultFactory = (
  address: Address,
  client: Client | { public: Client; wallet?: Client },
) => getContract({ address, abi: czarVaultFactoryAbi, client });

/** Reads the owner-facing vault state at one already selected block. */
export async function readPinnedVaultState(input: {
  readonly client: PublicClient;
  readonly factory: Address;
  readonly usdc: Address;
  readonly msca: Address;
  readonly vault: Address;
  readonly categoryIds: readonly `0x${string}`[];
  readonly blockNumber: bigint;
}): Promise<PinnedVaultReads> {
  const vault = getVault(input.vault, input.client);
  const factory = getVaultFactory(input.factory, input.client);
  const options = { blockNumber: input.blockNumber };
  const [vaultBalance, free, committed, frozen, paused, limits] = await Promise.all([
    input.client.readContract({
      abi: usdcBalanceAbi,
      address: input.usdc,
      functionName: "balanceOf",
      args: [input.vault],
      ...options,
    }),
    vault.read.freeBalance(options),
    vault.read.committedTotal(options),
    vault.read.frozen(options),
    factory.read.guardianPaused(options),
    Promise.all(
      input.categoryIds.map(async (categoryId) => {
        const limit = await vault.read.getLimits([categoryId], options);
        return {
          categoryId,
          userMax: limit.userMax,
          autoLimit: limit.autoLimit,
          usedInPeriod: limit.usedInPeriod,
          periodId: limit.periodId,
        };
      }),
    ),
  ]);
  return { vaultBalance, free, committed, frozen, paused, limits };
}
