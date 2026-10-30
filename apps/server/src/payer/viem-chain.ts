import {
  parseAbi,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { decodeEventLog } from "viem";
import { derivedNonce } from "@czar/hashing";
import { czarVaultAbi, getVault } from "@czar/vault-client";
import { ReserveReverted, type VaultDirectChain } from "#src/payer/vault-direct";

const USDC_ABI = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);
const RESERVED_EVENT = "Reserved";
const RESERVATION_FINAL_STATE = 3;

export function createViemVaultDirectChain(input: {
  readonly client: PublicClient;
  readonly vault: Address;
  readonly usdc: Address;
}): VaultDirectChain {
  const vault = getVault(input.vault, input.client);

  async function send(raw: Hex): Promise<Hex> {
    const hash = await input.client.sendRawTransaction({ serializedTransaction: raw });
    const receipt = await input.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("Vault transaction reverted: " + hash);
    return hash;
  }

  async function readReservation(reservationId: bigint) {
    return vault.read.getReservation([reservationId]);
  }

  /** The timestamp of the block that mined `receipt`, from that block's header (SCR-153 §2). */
  async function minedAt(receipt: TransactionReceipt): Promise<bigint> {
    const block = await input.client.getBlock({ blockNumber: receipt.blockNumber });
    return block.timestamp;
  }

  function reservedId(receipt: TransactionReceipt): bigint | undefined {
    const event = receipt.logs
      .filter((log) => log.address.toLowerCase() === input.vault.toLowerCase())
      .map((log) => {
        try {
          return decodeEventLog({
            abi: czarVaultAbi,
            eventName: RESERVED_EVENT,
            data: log.data,
            topics: log.topics,
          });
        } catch {
          return undefined;
        }
      })
      .find((decoded) => decoded !== undefined);
    return event ? BigInt(event.args.reservationId) : undefined;
  }

  return {
    async stepUsed(envelopeId, stepIndex) {
      return BigInt(await vault.read.stepUsed([envelopeId, stepIndex]));
    },
    async envelopeCapacity(envelopeId) {
      const envelope = await vault.read.getEnvelope([envelopeId]);
      const exposure =
        envelope.spent +
        envelope.reserved +
        envelope.pocketOutstanding +
        envelope.jobEscrowed +
        envelope.shortfall;
      return { cap: envelope.cap, exposure };
    },
    async reserve(args) {
      const txHash = await input.client.sendRawTransaction({
        serializedTransaction: args.signedTransaction,
      });
      const receipt = await input.client.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") throw new ReserveReverted(txHash, await minedAt(receipt));
      const reservationId = reservedId(receipt);
      if (reservationId === undefined)
        throw new Error("Mined reserve transaction did not emit Reserved.");
      return { reservationId, txHash };
    },
    async settle(args) {
      return send(args.signedTransaction);
    },
    async authorizationState(args) {
      const reservation = await readReservation(args.reservationId);
      if (BigInt(reservation.count) <= BigInt(args.index)) return false;
      return input.client.readContract({
        address: input.usdc,
        abi: USDC_ABI,
        functionName: "authorizationState",
        args: [input.vault, derivedNonce(input.vault, args.reservationId, args.index)],
      });
    },
    async isSettled(args) {
      const reservation = await readReservation(args.reservationId);
      const bit = 1n << BigInt(args.index);
      return (BigInt(reservation.settledMask) & bit) !== 0n;
    },
    async finalize(args) {
      const txHash = await send(args.signedTransaction);
      const reservation = await readReservation(args.reservationId);
      return { txHash, final: Number(reservation.state) === RESERVATION_FINAL_STATE };
    },
    async reservationFinal(reservationId) {
      const reservation = await readReservation(reservationId);
      return Number(reservation.state) === RESERVATION_FINAL_STATE;
    },
    async reserveOutcome(txHash) {
      let receipt: TransactionReceipt;
      try {
        receipt = await input.client.getTransactionReceipt({ hash: txHash as Hex });
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return undefined;
        throw error;
      }
      if (receipt.status !== "success")
        return { status: "reverted", blockTimestamp: await minedAt(receipt) };
      const reservationId = reservedId(receipt);
      return reservationId === undefined ? undefined : { status: "reserved", reservationId };
    },
  };
}
