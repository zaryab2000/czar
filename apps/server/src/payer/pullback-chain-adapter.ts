import { loadConfig, type Config } from "@czar/config";
import { createLogger, type Logger } from "@czar/logging";
import { parseAbi, type Address, type PublicClient, type WalletClient } from "viem";
import type { SlowPullbackDependencies } from "#src/payer/pullback";

const USDC_ABI = parseAbi(["function balanceOf(address account) view returns (uint256)"]);

export interface PullbackChainAdapterOptions {
  readonly config?: Config;
  readonly logger?: Logger;
  readonly withdrawalBlock?: (pocket: Address) => Promise<bigint>;
}

export function createPullbackChainAdapter(
  client: PublicClient,
  walletClient: WalletClient,
  options: PullbackChainAdapterOptions = {},
): SlowPullbackDependencies["chain"] {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? createLogger({ service: "server", component: "CZ-15" });
  const usdc = config.get("chain.usdcAddress") as Address;
  return {
    getBlockNumber: () => client.getBlockNumber(),
    withdrawalBlock: (pocket) => {
      if (!options.withdrawalBlock)
        throw new Error("Withdrawal block reader is unavailable for the registered pocket EOA.");
      return options.withdrawalBlock(pocket);
    },
    async pocketUsdcBalance(pocket) {
      return client.readContract({
        address: usdc,
        abi: USDC_ABI,
        functionName: "balanceOf",
        args: [pocket],
      });
    },
    async sendPocketTransaction(transaction, kind) {
      const hash = await walletClient.sendRawTransaction({ serializedTransaction: transaction });
      logger.info("pocket_transaction_submitted", { kind, hash });
      return hash;
    },
  };
}
