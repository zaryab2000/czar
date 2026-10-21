import type { Amount6 } from "@czar/schemas";
import type { gatewayTransfers } from "ponder:schema";

export const GATEWAY_API_BASE = "https://gateway-api-testnet.circle.com";
export const GATEWAY_STATUSES = [
  "received",
  "batched",
  "confirmed",
  "completed",
  "failed",
] as const;

export type GatewayStatus = (typeof GATEWAY_STATUSES)[number];
export type GatewayTransferRecord = typeof gatewayTransfers.$inferSelect;
export type GatewayTransferInsert = typeof gatewayTransfers.$inferInsert;
export type GatewayTransferStore = {
  find(transferId: string): Promise<GatewayTransferRecord | null>;
  save(transfer: GatewayTransferInsert): Promise<void>;
};
export type GatewayPollTarget = { kind: "pocket" | "merchant"; address: string };
export type GatewayPollOptions = {
  pageSize: number;
  timeoutMs: number;
  pocketAddresses: ReadonlySet<string>;
};
export type GatewayPollDependencies = {
  fetch: typeof fetch;
  log: (event: "gateway_status_regression") => void;
  apiBase?: string;
};

const STATUS_RANK: Record<Exclude<GatewayStatus, "failed">, number> = {
  received: 0,
  batched: 1,
  confirmed: 2,
  completed: 3,
};

export function shouldApplyGatewayStatus(
  current: GatewayStatus | undefined,
  incoming: GatewayStatus,
): boolean {
  if (current === undefined) return true;
  if (current === "completed" || current === "failed") return false;
  if (incoming === current) return false;
  if (incoming === "failed") return true;
  if (incoming === "completed") return true;
  return STATUS_RANK[incoming] >= STATUS_RANK[current];
}

export async function pollGatewayTransfers(
  target: GatewayPollTarget,
  options: GatewayPollOptions,
  store: GatewayTransferStore,
  dependencies: GatewayPollDependencies,
): Promise<{ error: boolean }> {
  if (!Number.isInteger(options.pageSize) || options.pageSize < 1) {
    return { error: true };
  }
  const base = new URL(dependencies.apiBase ?? GATEWAY_API_BASE);
  let nextUrl: URL | undefined = new URL("/v1/x402/transfers", base);
  nextUrl.searchParams.set(target.kind === "pocket" ? "from" : "to", target.address.toLowerCase());
  nextUrl.searchParams.set("pageSize", String(options.pageSize));
  const seenCursors = new Set<string>();

  while (nextUrl !== undefined) {
    if (seenCursors.has(nextUrl.href)) return { error: true };
    seenCursors.add(nextUrl.href);
    const response = await fetchPage(nextUrl, options.timeoutMs, dependencies.fetch);
    if (!response) return { error: true };
    const page = await readPage(response);
    if (!page) return { error: true };
    for (const transfer of page.transfers) {
      await applyTransfer(transfer, options.pocketAddresses, store, dependencies.log);
    }
    const cursor = nextLink(response.headers.get("link"));
    if (cursor === null) return { error: true };
    if (cursor === undefined) return { error: false };
    try {
      const cursorUrl: URL = new URL(cursor, nextUrl);
      if (cursorUrl.origin !== base.origin) return { error: true };
      if (!cursorUrl.searchParams.has("pageSize")) {
        cursorUrl.searchParams.set("pageSize", String(options.pageSize));
      }
      nextUrl = cursorUrl;
    } catch {
      return { error: true };
    }
  }
  return { error: false };
}

async function fetchPage(
  url: URL,
  timeoutMs: number,
  fetcher: typeof fetch,
): Promise<Response | null> {
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok ? response : null;
  } catch {
    return null;
  }
}

async function readPage(
  response: Response,
): Promise<{ transfers: GatewayTransferInsert[] } | null> {
  try {
    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body["transfers"])) return null;
    const transfers: GatewayTransferInsert[] = [];
    for (const candidate of body["transfers"]) {
      const transfer = parseTransfer(candidate);
      if (!transfer) return null;
      transfers.push(transfer);
    }
    return { transfers };
  } catch {
    return null;
  }
}

async function applyTransfer(
  incoming: GatewayTransferInsert,
  pocketAddresses: ReadonlySet<string>,
  store: GatewayTransferStore,
  log: GatewayPollDependencies["log"],
): Promise<void> {
  const previous = await store.find(incoming.transferId);
  const previousStatus = previous?.status as GatewayStatus | undefined;
  const incomingStatus = incoming.status as GatewayStatus;
  if (!shouldApplyGatewayStatus(previousStatus, incomingStatus)) {
    if (isStatusRegression(previousStatus, incomingStatus)) {
      log("gateway_status_regression");
    }
    return;
  }
  await store.save({
    ...incoming,
    pocketAddress: pocketAddresses.has(incoming.fromAddress.toLowerCase())
      ? incoming.fromAddress.toLowerCase()
      : null,
  });
}

function parseTransfer(value: unknown): GatewayTransferInsert | null {
  if (!isRecord(value)) return null;
  const id = value["id"];
  const status = value["status"];
  const fromAddress = value["fromAddress"];
  const toAddress = value["toAddress"];
  const amount = value["amount"];
  const nonce = value["nonce"];
  const txHash = value["txHash"];
  const createdAt = value["createdAt"];
  const updatedAt = value["updatedAt"];
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof status !== "string" ||
    !GATEWAY_STATUSES.includes(status as GatewayStatus) ||
    !isAddress(fromAddress) ||
    !isAddress(toAddress) ||
    typeof amount !== "string" ||
    !/^\d+$/.test(amount) ||
    typeof nonce !== "string" ||
    nonce.length === 0 ||
    !(txHash === null || (typeof txHash === "string" && /^0x[\da-fA-F]{64}$/.test(txHash))) ||
    !isTimestamp(createdAt) ||
    !isTimestamp(updatedAt)
  )
    return null;
  return {
    transferId: id,
    status,
    fromAddress: fromAddress.toLowerCase(),
    toAddress: toAddress.toLowerCase(),
    amount: amount as Amount6,
    nonce,
    txHash,
    createdAt,
    updatedAt,
    pocketAddress: null,
  };
}

function nextLink(header: string | null): string | null | undefined {
  if (header === null) return undefined;
  let malformedNext = false;
  for (const part of header.split(",")) {
    const relation = /(?:^|;)\s*rel\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(part);
    if (!relation || !(relation[1] ?? relation[2] ?? "").split(/\s+/).includes("next")) {
      continue;
    }
    const target = /^\s*<([^>]+)>/.exec(part)?.[1];
    if (target) return target;
    malformedNext = true;
  }
  return malformedNext ? null : undefined;
}

function isStatusRegression(current: GatewayStatus | undefined, incoming: GatewayStatus): boolean {
  if (current === undefined || current === incoming) return false;
  if (current === "completed" || current === "failed") return true;
  if (incoming === "failed" || incoming === "completed") return false;
  return STATUS_RANK[incoming] < STATUS_RANK[current];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAddress(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[\da-fA-F]{40}$/.test(value);
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
