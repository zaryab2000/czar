import {
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  TransactionReceiptNotFoundError,
  type Hex,
  type PublicClient,
} from "viem";

/** The chain reads that decide whether a saved signed transaction can still land (SCR-159 §2). */
export interface SavedTransactionChain {
  /** The sender's account nonce at the latest block: `getTransactionCount(sender, "latest")`. */
  transactionCount(address: `0x${string}`): Promise<number>;
  /** The mined status of `txHash`; `undefined` while it has no receipt. */
  transactionStatus(txHash: `0x${string}`): Promise<"success" | "reverted" | undefined>;
}

/**
 * Where a saved transaction stands:
 * - `mined` / `reverted`: it has a receipt with that status
 * - `pending`: no receipt and the account nonce has not passed its nonce, so the same bytes can still land
 * - `replaced`: no receipt and another transaction took its nonce, so the bytes can never land
 */
export type SavedTransactionState = "mined" | "reverted" | "pending" | "replaced";

/** The sender and nonce of a saved signed transaction, decoded from its bytes. */
export async function decodeSavedTransaction(
  signedTransaction: Hex,
): Promise<{ readonly sender: `0x${string}`; readonly nonce: number }> {
  const nonce = parseTransaction(signedTransaction).nonce;
  if (nonce === undefined) throw new Error("Saved signed transaction has no nonce.");
  const sender = await recoverTransactionAddress({
    serializedTransaction: signedTransaction as Parameters<
      typeof recoverTransactionAddress
    >[0]["serializedTransaction"],
  });
  return { sender, nonce };
}

/**
 * Whether the account nonce has passed the saved transaction's nonce. Read it before the receipt: a
 * transaction that lands between the two reads then shows its receipt, and is never taken as replaced.
 */
export async function savedNonceSpent(
  chain: Pick<SavedTransactionChain, "transactionCount">,
  signedTransaction: Hex,
): Promise<boolean> {
  const { sender, nonce } = await decodeSavedTransaction(signedTransaction);
  return (await chain.transactionCount(sender)) > nonce;
}

export async function savedTransactionState(
  chain: SavedTransactionChain,
  signedTransaction: Hex,
): Promise<SavedTransactionState> {
  const spent = await savedNonceSpent(chain, signedTransaction);
  const status = await chain.transactionStatus(keccak256(signedTransaction));
  if (status === "success") return "mined";
  if (status === "reverted") return "reverted";
  return spent ? "replaced" : "pending";
}

/** The `SavedTransactionChain` reads over a viem public client. */
export function savedTransactionReads(
  client: Pick<PublicClient, "getTransactionCount" | "getTransactionReceipt">,
): SavedTransactionChain {
  return {
    transactionCount: (address) => client.getTransactionCount({ address, blockTag: "latest" }),
    async transactionStatus(txHash) {
      try {
        return (await client.getTransactionReceipt({ hash: txHash })).status;
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return undefined;
        throw error;
      }
    },
  };
}
