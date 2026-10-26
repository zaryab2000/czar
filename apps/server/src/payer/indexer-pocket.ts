import type { Address } from "viem";

export interface PocketBalanceSnapshot {
  readonly gatewayAvailableAtomic: bigint;
  readonly gatewayWithdrawingAtomic: bigint;
  readonly apiObservedAt: Date | null;
  readonly apiConsecutiveFailures: number;
}

export interface FundedPocketProjection {
  readonly pocket: Address;
  readonly vault: Address;
  readonly state: "Registered" | "DelegateReady" | "Funded" | "Draining";
  readonly outstanding: bigint;
  readonly pendingPullback: bigint;
  readonly envelopeRef: string;
}

export interface ClosedPocketProjection {
  readonly pocket: Address;
  readonly vault: Address;
}

export interface IndexerPocketReader {
  pocketBalance(pocket: Address): Promise<PocketBalanceSnapshot>;
  fundedPocketsForVault(vault: Address): Promise<readonly FundedPocketProjection[]>;
  closedPocketsWithBalance(): Promise<readonly ClosedPocketProjection[]>;
}

export function createIndexerPocketReader(
  indexerUrl: string,
  timeoutMs: number,
  fetcher: typeof fetch = fetch,
): IndexerPocketReader {
  const baseUrl = new URL(indexerUrl);
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:")
    throw new TypeError("Indexer URL must use HTTP or HTTPS.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new RangeError("Indexer timeout must be a positive integer.");

  return {
    async pocketBalance(pocket) {
      const row = await requestRecord(
        `${baseUrl.origin}/pocket-balances/${encodeURIComponent(pocket)}`,
        timeoutMs,
        fetcher,
      );
      const observed = row["apiObservedAt"];
      if (observed !== null && typeof observed !== "string")
        throw new Error("Indexer returned a malformed pocket balance observation.");
      const apiObservedAt = observed === null ? null : new Date(observed);
      if (apiObservedAt && Number.isNaN(apiObservedAt.getTime()))
        throw new Error("Indexer returned a malformed pocket balance observation.");
      return {
        gatewayAvailableAtomic: parseAtomic(row["gatewayAvailableAtomic"]),
        gatewayWithdrawingAtomic: parseAtomic(row["gatewayWithdrawingAtomic"]),
        apiObservedAt,
        apiConsecutiveFailures: parseFailureCount(row["apiConsecutiveFailures"]),
      };
    },
    async fundedPocketsForVault(vault) {
      const url = new URL(`${baseUrl.origin}/pockets/funded`);
      url.searchParams.set("vault", vault);
      const body = await requestRecord(url.toString(), timeoutMs, fetcher);
      if (!Array.isArray(body["items"]))
        throw new Error("Indexer returned malformed funded pockets.");
      return body["items"].map(parseFundedPocket);
    },
    async closedPocketsWithBalance() {
      const body = await requestRecord(
        `${baseUrl.origin}/pockets/closed-with-balance`,
        timeoutMs,
        fetcher,
      );
      if (!Array.isArray(body["items"]))
        throw new Error("Indexer returned malformed closed pockets.");
      return body["items"].map(parseClosedPocket);
    },
  };
}

async function requestRecord(
  url: string,
  timeoutMs: number,
  fetcher: typeof fetch,
): Promise<Record<string, unknown>> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Indexer pocket query failed with HTTP ${response.status}.`);
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new Error("Indexer returned a malformed pocket response.");
  return body as Record<string, unknown>;
}

function parseFundedPocket(value: unknown): FundedPocketProjection {
  const row = requireRecord(value, "funded pocket");
  const state = row["state"];
  if (
    state !== "Registered" &&
    state !== "DelegateReady" &&
    state !== "Funded" &&
    state !== "Draining"
  )
    throw new Error("Indexer returned a malformed funded pocket state.");
  const envelopeRef = requireString(row["envelopeRef"], "funded pocket envelope reference");
  return {
    pocket: parseAddress(row["pocket"]),
    vault: parseAddress(row["vault"]),
    state,
    outstanding: parseAtomic(row["outstanding"]),
    pendingPullback: parseAtomic(row["pendingPullback"]),
    envelopeRef,
  };
}

function parseClosedPocket(value: unknown): ClosedPocketProjection {
  const row = requireRecord(value, "closed pocket");
  const pocketRecord = requireRecord(row["pocketRecord"], "closed pocket record");
  return { pocket: parseAddress(row["pocket"]), vault: parseAddress(pocketRecord["vault"]) };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`Indexer returned a malformed ${label}.`);
  return value as Record<string, unknown>;
}

function parseAddress(value: unknown): Address {
  if (typeof value !== "string" || !/^0x[\da-fA-F]{40}$/.test(value))
    throw new Error("Indexer returned a malformed pocket address.");
  return value as Address;
}

function parseAtomic(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value))
    throw new Error("Indexer returned a malformed pocket balance.");
  return BigInt(value);
}

function parseFailureCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Indexer returned a malformed Gateway API failure count.");
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Indexer returned a malformed ${label}.`);
  return value;
}
