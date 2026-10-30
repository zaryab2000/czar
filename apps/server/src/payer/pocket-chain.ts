import { parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { czarVaultAbi } from "@czar/vault-client";
import type { PocketPreparationChain } from "#src/payer/pocket";
import { savedTransactionReads } from "#src/payer/saved-transaction";

const gatewayWalletDelegateAbi = parseAbi([
  "function isAuthorizedForBalance(address token,address depositor,address delegate) view returns (bool)",
]);

export function createPocketPreparationChain(input: {
  readonly client: PublicClient;
  readonly vault: Address;
  readonly usdc: Address;
  readonly gatewayWallet: Address;
}): PocketPreparationChain {
  async function send(transaction: Hex): Promise<string> {
    const hash = await input.client.sendRawTransaction({ serializedTransaction: transaction });
    const receipt = await input.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`Pocket transaction reverted: ${hash}`);
    return hash;
  }

  async function pocketRecord(pocket: Address) {
    return input.client.readContract({
      address: input.vault,
      abi: czarVaultAbi,
      functionName: "getPocket",
      args: [pocket],
    });
  }

  return {
    ...savedTransactionReads(input.client),
    async isRegistered(pocket) {
      return Number((await pocketRecord(pocket)).state) !== 0;
    },
    registerPocket: (args) => send(args.transaction),
    async pocketGasGranted(pocket) {
      return BigInt((await pocketRecord(pocket)).gasGranted);
    },
    grantPocketGas: (args) => send(args.transaction),
    isDelegateReady: ({ pocket }) =>
      input.client.readContract({
        address: input.gatewayWallet,
        abi: gatewayWalletDelegateAbi,
        functionName: "isAuthorizedForBalance",
        args: [input.usdc, pocket, input.vault],
      }),
    addDelegate: (args) => send(args.transaction),
    async isFunded(pocket) {
      const record = await pocketRecord(pocket);
      return BigInt(record.funded) > 0n;
    },
    fundPocket: (args) => send(args.transaction),
  };
}
