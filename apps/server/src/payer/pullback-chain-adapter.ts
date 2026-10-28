import { loadConfig, type Config } from "@czar/config";
import { createLogger, type Logger } from "@czar/logging";
import {
  decodeEventLog,
  parseAbi,
  TransactionReceiptNotFoundError,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  createRpcTransactionPreparer,
  pocketReturnGasReserve,
  returnableAtomic,
  type TransactionPreparer,
} from "@czar/signer";
import type { SlowPullbackDependencies } from "#src/payer/pullback";
import type { SlowPullbackReceipt } from "#src/payer/pullback";

const USDC_ABI = parseAbi(["function balanceOf(address account) view returns (uint256)"]);
const gatewayWalletWithdrawalAbi = [
  {
    type: "function",
    name: "withdrawalBlock",
    inputs: [
      { name: "token", type: "address" },
      { name: "depositor", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;
const gatewayWalletWithdrawingBalanceAbi = [
  {
    type: "function",
    name: "withdrawingBalance",
    inputs: [
      { name: "token", type: "address" },
      { name: "depositor", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;
const usdcTransferAbi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export interface PullbackChainAdapterOptions {
  readonly config?: Config;
  readonly logger?: Logger;
  /**
   * Prepares the `pocket-return` transfers the SCR-152 returnable value is computed from; defaults to the RPC
   * preparer the signer process signs with, so both sides derive `gasReserve` the same way.
   */
  readonly transactionPreparer?: TransactionPreparer;
}

const CAIP2_EIP155 = /^eip155:(\d+)$/;

function paymentChainId(config: Config): number {
  const network = String(config.get("selection.paymentNetwork"));
  const match = CAIP2_EIP155.exec(network);
  if (match?.[1] === undefined)
    throw new Error(`selection.paymentNetwork ${network} is not eip155`);
  return Number(match[1]);
}

export function createPullbackChainAdapter(
  client: PublicClient,
  walletClient: WalletClient,
  gatewayWalletAddress: Address,
  options: PullbackChainAdapterOptions = {},
): SlowPullbackDependencies["chain"] {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? createLogger({ service: "server", component: "CZ-15" });
  const usdc = config.get("chain.usdcAddress") as Address;
  let prepare = options.transactionPreparer;
  const preparer = (): TransactionPreparer => {
    prepare ??= createRpcTransactionPreparer({ chainId: paymentChainId(config), client });
    return prepare;
  };
  return {
    getBlockNumber: () => client.getBlockNumber(),
    withdrawalBlock: (pocket) =>
      client.readContract({
        address: gatewayWalletAddress,
        abi: gatewayWalletWithdrawalAbi,
        functionName: "withdrawalBlock",
        args: [usdc, pocket],
      }),
    withdrawingBalance: (pocket) =>
      client.readContract({
        address: gatewayWalletAddress,
        abi: gatewayWalletWithdrawingBalanceAbi,
        functionName: "withdrawingBalance",
        args: [usdc, pocket],
      }),
    async pocketReturnable(pocket, vault) {
      const balance = await client.readContract({
        address: usdc,
        abi: USDC_ABI,
        functionName: "balanceOf",
        args: [pocket],
      });
      const { returnable } = await returnableAtomic(balance, (amount) =>
        pocketReturnGasReserve(preparer(), { usdc, pocket, vault, amount }),
      );
      return returnable;
    },
    async sendPocketTransaction(transaction, kind) {
      const hash = await walletClient.sendRawTransaction({ serializedTransaction: transaction });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success")
        throw new Error(`Pocket transaction failed for kind ${kind}.`);
      logger.info("pocket_transaction_submitted", { kind, hash });
      return hash;
    },
    async transactionReceipt(hash): Promise<SlowPullbackReceipt | null> {
      try {
        const receipt = await client.getTransactionReceipt({ hash: hash as `0x${string}` });
        const logs = [];
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== usdc.toLowerCase()) continue;
          try {
            const decoded = decodeEventLog({
              abi: usdcTransferAbi,
              data: log.data,
              topics: log.topics,
            });
            if (decoded.eventName !== "Transfer") continue;
            logs.push({
              address: log.address,
              from: decoded.args.from,
              to: decoded.args.to,
              value: decoded.args.value,
              logIndex: log.logIndex,
            });
          } catch {
            continue;
          }
        }
        return { status: receipt.status, blockNumber: receipt.blockNumber, logs };
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      }
    },
  };
}
