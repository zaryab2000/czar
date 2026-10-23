import {
  decodeEventLog,
  keccak256,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { czarGatewayMinterReplayAbi, czarVaultAbi } from "@czar/vault-client";
import type { Hash32 } from "@czar/hashing";
import type { Pool } from "pg";
import type { PullbackChain, PullbackRecord } from "#src/payer/pullback";

const PENDING_PULLBACK = 1;
const CONFIRMED_PULLBACK = 2;
const CANCELLED_PULLBACK = 3;

export function createPullbackExecutionChain(input: {
  readonly client: PublicClient;
  readonly pool: Pool;
  readonly vault: Address;
  readonly gatewayMinter: Address;
}): PullbackChain {
  async function send(transaction: Hex): Promise<string> {
    const hash = await input.client.sendRawTransaction({ serializedTransaction: transaction });
    const receipt = await input.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`Pullback transaction reverted: ${hash}`);
    return hash;
  }

  async function readPullback(pullbackId: bigint): Promise<PullbackRecord | undefined> {
    const row = await input.client.readContract({
      address: input.vault,
      abi: czarVaultAbi,
      functionName: "getPullback",
      args: [pullbackId],
    });
    const state = Number(row.state);
    if (state === 0) return undefined;
    return {
      pullbackId,
      value: BigInt(row.value),
      maxFee: BigInt(row.maxFee),
      maxBlockHeight: BigInt(row.maxBlockHeight),
      salt: row.salt,
      transferSpecHash: row.transferSpecHash,
      state:
        state === PENDING_PULLBACK
          ? "Pending"
          : state === CONFIRMED_PULLBACK
            ? "Confirmed"
            : state === CANCELLED_PULLBACK
              ? "Cancelled"
              : (() => {
                  throw new Error(`Unknown pullback state ${state}.`);
                })(),
    };
  }

  return {
    async maxPullbackFee() {
      return input.client.readContract({
        address: input.vault,
        abi: czarVaultAbi,
        functionName: "maxPullbackFee",
      });
    },
    writeOffPocket: (_pocket, transaction) => send(transaction),
    async findPendingPullback(pocket) {
      const sentRows = await input.pool.query<{ readonly payload: Record<string, unknown> }>(
        `SELECT payload FROM step_executions
         WHERE phase='pullback.request.sent' AND payload->>'pocket'=$1
         ORDER BY execution_id DESC LIMIT 1`,
        [pocket],
      );
      const transaction = sentRows.rows[0]?.payload["transaction"];
      if (typeof transaction === "string") {
        const recovered = await pendingPullbackFromTransaction({
          client: input.client,
          vault: input.vault,
          transaction: transaction as Hex,
          readPullback,
        });
        if (recovered?.state === "Pending") return recovered;
      }
      const rows = await input.pool.query<{ readonly payload: Record<string, unknown> }>(
        `SELECT payload FROM step_executions
         WHERE phase='pullback.requested' AND payload->>'pocket'=$1
         ORDER BY execution_id DESC LIMIT 1`,
        [pocket],
      );
      const payload = rows.rows[0]?.payload;
      if (!payload || typeof payload["pullbackId"] !== "string") return undefined;
      const result = await readPullback(BigInt(payload["pullbackId"]));
      return result?.state === "Pending" ? result : undefined;
    },
    async requestPullback(args) {
      const txHash = await send(args.transaction);
      const receipt = await input.client.getTransactionReceipt({ hash: txHash as Hex });
      const event = receipt.logs
        .filter((log) => log.address.toLowerCase() === input.vault.toLowerCase())
        .map((log) => {
          try {
            return decodeEventLog({
              abi: czarVaultAbi,
              eventName: "PullbackRequested",
              data: log.data,
              topics: log.topics,
            });
          } catch {
            return undefined;
          }
        })
        .find((decoded) => decoded !== undefined);
      if (!event) throw new Error("Mined requestPullback did not emit PullbackRequested.");
      const record = await readPullback(BigInt(event.args.pullbackId));
      if (!record) throw new Error("Mined requestPullback has no vault record.");
      return record;
    },
    isTransferSpecHashUsed: (hash: Hash32) =>
      input.client.readContract({
        address: input.gatewayMinter,
        abi: czarGatewayMinterReplayAbi,
        functionName: "isTransferSpecHashUsed",
        args: [hash],
      }),
    mintAttestation: (transaction) => send(transaction),
    confirmPullback: async (args) => send(args.transaction),
    cancelPullback: async (args) => send(args.transaction),
    readPullback,
    getBlockNumber: () => input.client.getBlockNumber(),
  };
}

async function pendingPullbackFromTransaction(input: {
  readonly client: PublicClient;
  readonly vault: Address;
  readonly transaction: Hex;
  readonly readPullback: (pullbackId: bigint) => Promise<PullbackRecord | undefined>;
}): Promise<PullbackRecord | undefined> {
  let receipt;
  try {
    receipt = await input.client.getTransactionReceipt({ hash: keccak256(input.transaction) });
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) return undefined;
    throw error;
  }
  if (receipt.status !== "success")
    throw new Error("Stored requestPullback transaction mined but reverted.");
  const event = receipt.logs
    .filter((log) => log.address.toLowerCase() === input.vault.toLowerCase())
    .map((log) => {
      try {
        return decodeEventLog({
          abi: czarVaultAbi,
          eventName: "PullbackRequested",
          data: log.data,
          topics: log.topics,
        });
      } catch {
        return undefined;
      }
    })
    .find((decoded) => decoded !== undefined);
  if (!event) return undefined;
  return input.readPullback(BigInt(event.args.pullbackId));
}
