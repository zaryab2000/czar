import type { PaymentRef } from "@czar/schemas";
import { decodeEventLog, type Hex, type PublicClient } from "viem";

const ERC20_TRANSFER_ABI = [
  {
    type: "event",
    name: "Transfer",
    anonymous: false,
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;
const ERC3009_AUTHORIZATION_ABI = [
  {
    type: "event",
    name: "AuthorizationUsed",
    anonymous: false,
    inputs: [
      { name: "authorizer", type: "address", indexed: true },
      { name: "nonce", type: "bytes32", indexed: true },
    ],
  },
] as const;

interface SettlementFact {
  readonly rail?: unknown;
  readonly payer?: unknown;
  readonly payee?: unknown;
  readonly nonce?: unknown;
  readonly amount?: unknown;
  readonly settlementTx?: unknown;
  readonly transferId?: unknown;
  readonly status?: unknown;
}

interface SettlementPage {
  readonly items: readonly SettlementFact[];
  readonly nextCursor: string | null;
}

export function createIndexerSettlement(
  indexerUrl: string,
  pageLimit: number,
  timeoutMs: number,
  verifyTransfer: (payment: Extract<PaymentRef, { rail: "x402-exact" }>) => Promise<boolean>,
  fetcher: typeof fetch = fetch,
): { isSettled(payment: PaymentRef): Promise<boolean> } {
  const query = createLedgerQuery(indexerUrl, pageLimit, timeoutMs, fetcher);

  return {
    async isSettled(payment) {
      if (payment.rail !== "x402-exact") return false;
      const indexed = await query(payment.payer, (fact) => matches(payment, fact));
      return indexed && (await verifyTransfer(payment));
    },
  };
}

export async function verifyX402Transfer(
  client: Pick<PublicClient, "getTransactionReceipt">,
  payment: Extract<PaymentRef, { rail: "x402-exact" }>,
): Promise<boolean> {
  if (!payment.settlementTx || !/^0x[\da-fA-F]{64}$/.test(payment.settlementTx)) return false;
  const receipt = await client.getTransactionReceipt({ hash: payment.settlementTx as Hex });
  if (receipt.status !== "success") return false;
  const tokenLogs = receipt.logs.filter(
    (log) => log.address.toLowerCase() === payment.asset.toLowerCase(),
  );
  const authorizationUsed = tokenLogs.some((log) => {
    try {
      const event = decodeEventLog({
        abi: ERC3009_AUTHORIZATION_ABI,
        eventName: "AuthorizationUsed",
        data: log.data,
        topics: log.topics,
      });
      return (
        event.args.authorizer.toLowerCase() === payment.payer.toLowerCase() &&
        event.args.nonce.toLowerCase() === payment.nonce.toLowerCase()
      );
    } catch {
      return false;
    }
  });
  const transfer = tokenLogs.some((log) => {
    try {
      const event = decodeEventLog({
        abi: ERC20_TRANSFER_ABI,
        eventName: "Transfer",
        data: log.data,
        topics: log.topics,
      });
      return (
        event.args.from.toLowerCase() === payment.payer.toLowerCase() &&
        event.args.to.toLowerCase() === payment.payTo.toLowerCase() &&
        event.args.value === BigInt(payment.amount)
      );
    } catch {
      return false;
    }
  });
  return authorizationUsed && transfer;
}

export function createIndexerGatewayStatus(
  indexerUrl: string,
  vault: string,
  pageLimit: number,
  timeoutMs: number,
  fetcher: typeof fetch = fetch,
): (input: {
  readonly pocket: string;
  readonly nonce: string;
  readonly transferId?: string;
}) => Promise<"pending" | "completed" | "failed"> {
  const query = createLedgerQuery(indexerUrl, pageLimit, timeoutMs, fetcher);
  return async (input) => {
    let status: "pending" | "completed" | "failed" = "pending";
    await query(vault, (fact) => {
      const match =
        fact.rail === "gateway-batched" &&
        typeof fact.payer === "string" &&
        fact.payer.toLowerCase() === input.pocket.toLowerCase() &&
        typeof fact.nonce === "string" &&
        fact.nonce.toLowerCase() === input.nonce.toLowerCase() &&
        (input.transferId === undefined || fact.transferId === input.transferId);
      if (!match) return false;
      status = fact.status === "completed" || fact.status === "failed" ? fact.status : "pending";
      return true;
    });
    return status;
  };
}

function createLedgerQuery(
  indexerUrl: string,
  pageLimit: number,
  timeoutMs: number,
  fetcher: typeof fetch,
): (vault: string, match: (fact: SettlementFact) => boolean) => Promise<boolean> {
  const baseUrl = new URL(indexerUrl);
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:")
    throw new TypeError("Indexer URL must use HTTP or HTTPS.");
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1)
    throw new RangeError("Indexer page limit must be a positive integer.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new RangeError("Indexer timeout must be a positive integer.");
  return async (vault, match) => {
    const visited = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await readPage(baseUrl, vault, cursor, pageLimit, timeoutMs, fetcher);
      if (page.items.some(match)) return true;
      cursor = page.nextCursor;
      if (cursor !== null && visited.has(cursor))
        throw new Error("Indexer repeated a settlement cursor.");
      if (cursor !== null) visited.add(cursor);
    } while (cursor !== null);
    return false;
  };
}

async function readPage(
  baseUrl: URL,
  vault: string,
  cursor: string | null,
  pageLimit: number,
  timeoutMs: number,
  fetcher: typeof fetch,
): Promise<SettlementPage> {
  const url = new URL("/receipts", baseUrl);
  url.searchParams.set("vault", vault);
  url.searchParams.set("limit", String(pageLimit));
  if (cursor !== null) url.searchParams.set("cursor", cursor);
  const response = await fetcher(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Indexer receipt lookup returned HTTP ${response.status}.`);
  return parsePage(await response.json());
}

function parsePage(value: unknown): SettlementPage {
  if (!isRecord(value) || !Array.isArray(value["items"]))
    throw new TypeError("Indexer receipt lookup returned an invalid page.");
  const nextCursor = value["nextCursor"];
  if (nextCursor !== null && typeof nextCursor !== "string")
    throw new TypeError("Indexer receipt lookup returned an invalid cursor.");
  return { items: value["items"] as SettlementFact[], nextCursor };
}

function matches(
  payment: Extract<PaymentRef, { rail: "x402-exact" }>,
  fact: SettlementFact,
): boolean {
  return (
    fact.rail === "x402-exact" &&
    typeof fact.payer === "string" &&
    fact.payer.toLowerCase() === payment.payer.toLowerCase() &&
    typeof fact.payee === "string" &&
    fact.payee.toLowerCase() === payment.payTo.toLowerCase() &&
    typeof fact.nonce === "string" &&
    fact.nonce.toLowerCase() === payment.nonce.toLowerCase() &&
    fact.amount === payment.amount &&
    fact.status === "settled"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
