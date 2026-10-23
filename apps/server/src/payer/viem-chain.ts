import { parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { decodeEventLog } from "viem";
import { derivedNonce } from "@czar/hashing";
import { czarVaultAbi, getVault } from "@czar/vault-client";
import type { VaultDirectChain } from "#src/payer/vault-direct";

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
      const txHash = await send(args.signedTransaction);
      const receipt = await input.client.getTransactionReceipt({ hash: txHash });
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
      if (!event) throw new Error("Mined reserve transaction did not emit Reserved.");
      return { reservationId: BigInt(event.args.reservationId), txHash };
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
    async reservationFromTransaction(txHash) {
      try {
        const receipt = await input.client.getTransactionReceipt({ hash: txHash as Hex });
        if (receipt.status !== "success") return undefined;
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
      } catch {
        return undefined;
      }
    },
  };
}
