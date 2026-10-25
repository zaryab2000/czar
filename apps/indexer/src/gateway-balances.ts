import { parseAbi, type Address, type PublicClient } from "viem";

const GATEWAY_WITHDRAWAL_ABI = parseAbi([
  "function withdrawingBalance(address token, address depositor) view returns (uint256)",
  "function withdrawalBlock(address token, address depositor) view returns (uint256)",
]);
const USDC_BALANCE_ABI = parseAbi(["function balanceOf(address account) view returns (uint256)"]);

export type PocketBalanceRow = {
  pocket: string;
  vault: string;
  gatewayAvailableAtomic: string | null;
  gatewayPendingBatchAtomic: string | null;
  gatewayWithdrawingAtomic: string | null;
  withdrawalBlock: bigint | null;
  pocketUsdcAtomic: string | null;
  apiObservedAt: string | null;
  chainObservedBlock: bigint | null;
  apiConsecutiveFailures: number;
  apiLastError: GatewayBalanceError | null;
  closedZeroSince: string | null;
};

export type PocketBalanceStore = {
  find(pocket: string): Promise<PocketBalanceRow | null>;
  save(row: PocketBalanceRow): Promise<void>;
};

type BalanceChain = Pick<PublicClient, "getBlockNumber" | "readContract">;

export type PocketBalancePollInput = {
  pocket: Address;
  vault: Address;
  state: string;
  domain: number;
  gatewayWallet: Address;
  usdc: Address;
  apiBase: string;
  timeoutMs: number;
  quietMs: number;
};

export type PocketBalancePollDependencies = {
  fetch: typeof fetch;
  chain: BalanceChain;
  store: PocketBalanceStore;
  now?: () => number;
};

export async function pollPocketBalance(
  input: PocketBalancePollInput,
  dependencies: PocketBalancePollDependencies,
): Promise<{ apiError: boolean; chainError: boolean; row: PocketBalanceRow }> {
  const pocket = input.pocket.toLowerCase();
  const now = dependencies.now?.() ?? Date.now();
  const previous = await dependencies.store.find(pocket);
  const row = previous ?? emptyPocketBalance(input.pocket, input.vault);
  let apiError = false;
  let chainError = false;
  let apiSucceeded = false;
  let chainSucceeded = false;

  try {
    const result = await fetchPocketBalance(input, dependencies.fetch);
    row.gatewayAvailableAtomic = result.available.toString();
    row.gatewayPendingBatchAtomic = result.pendingBatch.toString();
    row.apiObservedAt = new Date(now).toISOString();
    row.apiConsecutiveFailures = 0;
    row.apiLastError = null;
    apiSucceeded = true;
  } catch (error) {
    apiError = true;
    row.apiConsecutiveFailures += 1;
    row.apiLastError = classifyBalanceFailure(error);
  }

  try {
    const block = await dependencies.chain.getBlockNumber();
    const [withdrawing, withdrawalBlock, usdcBalance] = await Promise.all([
      dependencies.chain.readContract({
        address: input.gatewayWallet,
        abi: GATEWAY_WITHDRAWAL_ABI,
        functionName: "withdrawingBalance",
        args: [input.usdc, input.pocket],
        blockNumber: block,
      }),
      dependencies.chain.readContract({
        address: input.gatewayWallet,
        abi: GATEWAY_WITHDRAWAL_ABI,
        functionName: "withdrawalBlock",
        args: [input.usdc, input.pocket],
        blockNumber: block,
      }),
      dependencies.chain.readContract({
        address: input.usdc,
        abi: USDC_BALANCE_ABI,
        functionName: "balanceOf",
        args: [input.pocket],
        blockNumber: block,
      }),
    ]);
    row.gatewayWithdrawingAtomic = withdrawing.toString();
    row.withdrawalBlock = withdrawalBlock;
    row.pocketUsdcAtomic = usdcBalance.toString();
    row.chainObservedBlock = block;
    chainSucceeded = true;
  } catch {
    chainError = true;
  }

  row.closedZeroSince = closedZeroSince(input, row, previous, now, apiSucceeded, chainSucceeded);
  await dependencies.store.save(row);
  return { apiError, chainError, row };
}

async function fetchPocketBalance(
  input: PocketBalancePollInput,
  fetcher: typeof fetch,
): Promise<{ available: bigint; pendingBatch: bigint }> {
  const response = await fetcher(new URL("/v1/balances", input.apiBase), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: "USDC",
      balances: [{ domain: input.domain, depositor: input.pocket }],
    }),
    signal: AbortSignal.timeout(input.timeoutMs),
  });
  if (!response.ok) throw new Error(`Gateway HTTP ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Malformed Gateway balance response");
  }
  return parseGatewayBalance(body, input.domain, input.pocket);
}

function emptyPocketBalance(pocket: Address, vault: Address): PocketBalanceRow {
  return {
    pocket: pocket.toLowerCase(),
    vault: vault.toLowerCase(),
    gatewayAvailableAtomic: null,
    gatewayPendingBatchAtomic: null,
    gatewayWithdrawingAtomic: null,
    withdrawalBlock: null,
    pocketUsdcAtomic: null,
    apiObservedAt: null,
    chainObservedBlock: null,
    apiConsecutiveFailures: 0,
    apiLastError: null,
    closedZeroSince: null,
  };
}

function closedZeroSince(
  input: PocketBalancePollInput,
  row: PocketBalanceRow,
  previous: PocketBalanceRow | null,
  now: number,
  apiSucceeded: boolean,
  chainSucceeded: boolean,
): string | null {
  if (input.state !== "Closed") return null;
  const available = row.gatewayAvailableAtomic;
  const pendingBatch = row.gatewayPendingBatchAtomic;
  const withdrawing = row.gatewayWithdrawingAtomic;
  const usdc = row.pocketUsdcAtomic;
  const allObserved = apiSucceeded && chainSucceeded;
  if (
    !allObserved ||
    available === null ||
    pendingBatch === null ||
    withdrawing === null ||
    usdc === null
  )
    return previous?.closedZeroSince ?? null;
  if (
    BigInt(available) > 0n ||
    BigInt(pendingBatch) > 0n ||
    BigInt(withdrawing) > 0n ||
    BigInt(usdc) > 0n
  )
    return null;
  return previous?.closedZeroSince ?? new Date(now).toISOString();
}

export type GatewayBalanceError = "timeout" | "http-4xx" | "http-5xx" | "malformed" | "network";

export function amount6FromDecimal(value: string): bigint {
  if (!/^(0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) {
    throw new Error("Gateway balance must be a non-negative decimal with at most 6 places");
  }
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

export function classifyBalanceFailure(error: unknown): GatewayBalanceError {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/timeout|abort/i.test(message)) return "timeout";
  if (/http\s+4\d\d/i.test(message)) return "http-4xx";
  if (/http\s+5\d\d/i.test(message)) return "http-5xx";
  if (/malformed|invalid Gateway balance/i.test(message)) return "malformed";
  return "network";
}

export function isClosedPocketQuiet(input: {
  now: number;
  quietMs: number;
  zeroSince: string | null;
  gatewayAvailable: bigint;
  gatewayPendingBatch: bigint;
  gatewayWithdrawing: bigint;
  usdc: bigint;
  apiObservedAt: string | null;
  apiMaxAgeMs: number;
  chainReadSucceeded: boolean;
}): boolean {
  const apiObservedAt = input.apiObservedAt === null ? Number.NaN : Date.parse(input.apiObservedAt);
  const apiAge = input.now - apiObservedAt;
  if (
    input.zeroSince === null ||
    input.gatewayAvailable !== 0n ||
    input.gatewayPendingBatch !== 0n ||
    input.gatewayWithdrawing !== 0n ||
    input.usdc !== 0n ||
    !input.chainReadSucceeded ||
    !Number.isFinite(apiObservedAt) ||
    apiAge < 0 ||
    apiAge > input.apiMaxAgeMs
  ) {
    return false;
  }
  const since = Date.parse(input.zeroSince);
  return Number.isFinite(since) && input.now - since >= input.quietMs;
}

export function isPocketStale(input: {
  pocketState: string;
  envelopeState: string | null;
  envelopeClosedAt: number | null;
  now: number;
  staleMs: number;
}): boolean {
  return (
    (input.pocketState === "Funded" || input.pocketState === "Draining") &&
    input.envelopeState === "Closed" &&
    input.envelopeClosedAt !== null &&
    input.now - input.envelopeClosedAt > input.staleMs
  );
}

export function advanceGatewayApiFailures(
  previous: number,
  outcomes: readonly { apiError: boolean; chainError: boolean }[],
): number {
  let consecutive = previous;
  for (const outcome of outcomes) consecutive = outcome.apiError ? consecutive + 1 : 0;
  return consecutive;
}

export function parseGatewayBalance(
  body: unknown,
  domain: number,
  depositor: string,
): { available: bigint; pendingBatch: bigint } {
  if (!isRecord(body) || body["token"] !== "USDC" || !Array.isArray(body["balances"])) {
    throw new Error("Malformed Gateway balance response");
  }
  const match = body["balances"].find(
    (entry) =>
      isRecord(entry) &&
      entry["domain"] === domain &&
      typeof entry["depositor"] === "string" &&
      entry["depositor"].toLowerCase() === depositor.toLowerCase(),
  );
  if (
    !isRecord(match) ||
    typeof match["balance"] !== "string" ||
    typeof match["pendingBatch"] !== "string"
  ) {
    throw new Error("Malformed Gateway balance response");
  }
  return {
    available: amount6FromDecimal(match["balance"]),
    pendingBatch: amount6FromDecimal(match["pendingBatch"]),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
