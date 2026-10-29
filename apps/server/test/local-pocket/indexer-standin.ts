// Stand-in for the four CZ-19 pocket routes the payer reads (`createIndexerPocketReader`), answered from the
// local chain instead of a running Ponder indexer. The Gateway API figure is the Gateway double's
// `availableBalance` (what the D92 `/v1/balances` stand-in returns on a chain with the doubles placed); a test
// switches a pocket's API between `fresh` (observed now) and `down` (the last good figure is kept, the failure
// count rises), which is how SCR-127 trigger (a) and the SCR-145 stale-figure exception are reached.
import { createServer, type Server } from "node:http";
import { parseAbi, type Address, type PublicClient } from "viem";
import { czarVaultAbi } from "@czar/vault-client";
import { ARC_USDC, GATEWAY_WALLET } from "#test/local-pocket/arc-chain";

const gatewayWalletAbi = parseAbi([
  "function availableBalance(address token, address depositor) view returns (uint256)",
  "function withdrawingBalance(address token, address depositor) view returns (uint256)",
]);
// ICzarVault.PocketState order: None, Registered, Funded, Draining, Closed.
const POCKET_STATES = ["None", "Registered", "Funded", "Draining", "Closed"] as const;

export type PocketState = (typeof POCKET_STATES)[number];

export interface GatewayObservation {
  readonly available: bigint;
  readonly observedAt: Date | null;
  readonly consecutiveFailures: number;
}

export interface RegisteredPocket {
  readonly pocket: Address;
  readonly vault: Address;
  readonly envelopeRef: string;
}

export interface IndexerStandin {
  readonly url: string;
  register(pocket: RegisteredPocket): void;
  vaultOf(pocket: Address): Address | undefined;
  /** `fresh`: every read observes the double now. `down`: the API fails; the last good figure stays. */
  setGatewayApi(pocket: Address, mode: "fresh" | "down"): void;
  observe(pocket: Address): Promise<GatewayObservation>;
  pocketState(pocket: Address): Promise<{
    readonly state: PocketState;
    readonly envelopeId: bigint;
    readonly funded: bigint;
    readonly outstanding: bigint;
    readonly pendingPullback: bigint;
  }>;
  withdrawing(pocket: Address): Promise<bigint>;
  stop(): Promise<void>;
}

export async function startIndexerStandin(input: {
  readonly port: number;
  readonly reader: PublicClient;
  readonly now: () => Date;
}): Promise<IndexerStandin> {
  const pockets = new Map<string, RegisteredPocket>();
  const modes = new Map<string, "fresh" | "down">();
  const lastGood = new Map<string, { available: bigint; observedAt: Date }>();
  const failures = new Map<string, number>();

  async function observe(pocket: Address): Promise<GatewayObservation> {
    const key = pocket.toLowerCase();
    if ((modes.get(key) ?? "fresh") === "fresh") {
      const available = await input.reader.readContract({
        address: GATEWAY_WALLET,
        abi: gatewayWalletAbi,
        functionName: "availableBalance",
        args: [ARC_USDC, pocket],
      });
      const observedAt = input.now();
      lastGood.set(key, { available, observedAt });
      failures.set(key, 0);
      return { available, observedAt, consecutiveFailures: 0 };
    }
    const count = (failures.get(key) ?? 0) + 1;
    failures.set(key, count);
    const good = lastGood.get(key);
    return {
      available: good?.available ?? 0n,
      observedAt: good?.observedAt ?? null,
      consecutiveFailures: count,
    };
  }

  async function pocketState(pocket: Address) {
    const vault = pockets.get(pocket.toLowerCase())?.vault;
    if (!vault) throw new Error("Indexer stand-in has no vault for this pocket.");
    const record = await input.reader.readContract({
      address: vault,
      abi: czarVaultAbi,
      functionName: "getPocket",
      args: [pocket],
    });
    const state = POCKET_STATES[Number(record.state)];
    if (!state) throw new Error("Indexer stand-in read an unknown pocket state.");
    return {
      state,
      envelopeId: BigInt(record.envelopeId),
      funded: BigInt(record.funded),
      outstanding: BigInt(record.outstanding),
      pendingPullback: BigInt(record.pendingPullback),
    };
  }

  const withdrawing = (pocket: Address) =>
    input.reader.readContract({
      address: GATEWAY_WALLET,
      abi: gatewayWalletAbi,
      functionName: "withdrawingBalance",
      args: [ARC_USDC, pocket],
    });

  const routes = createRoutes({ pockets, observe, pocketState, withdrawing, reader: input.reader });
  const server = createServer((request, response) => {
    routes(new URL(request.url ?? "/", `http://127.0.0.1:${input.port}`))
      .then(([status, body]) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      })
      .catch(() => {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "standin_failure" }));
      });
  });
  await listen(server, input.port);
  return {
    url: `http://127.0.0.1:${input.port}`,
    register(pocket) {
      pockets.set(pocket.pocket.toLowerCase(), pocket);
    },
    vaultOf: (pocket) => pockets.get(pocket.toLowerCase())?.vault,
    setGatewayApi(pocket, mode) {
      modes.set(pocket.toLowerCase(), mode);
    },
    observe,
    pocketState,
    withdrawing,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function createRoutes(input: {
  readonly pockets: Map<string, RegisteredPocket>;
  readonly observe: IndexerStandin["observe"];
  readonly pocketState: IndexerStandin["pocketState"];
  readonly withdrawing: IndexerStandin["withdrawing"];
  readonly reader: PublicClient;
}) {
  return async (url: URL): Promise<[number, unknown]> => {
    const balance = /^\/pocket-balances\/(0x[\da-fA-F]{40})$/.exec(url.pathname);
    if (balance?.[1]) {
      const pocket = balance[1] as Address;
      const observation = await input.observe(pocket);
      return [
        200,
        {
          gatewayAvailableAtomic: observation.available.toString(),
          gatewayWithdrawingAtomic: (await input.withdrawing(pocket)).toString(),
          apiObservedAt: observation.observedAt?.toISOString() ?? null,
          apiConsecutiveFailures: observation.consecutiveFailures,
        },
      ];
    }
    if (url.pathname === "/pockets/funded") return [200, { items: await funded(input, url) }];
    if (url.pathname === "/pockets/closed-with-balance")
      return [200, { items: await closedWithBalance(input) }];
    if (url.pathname === "/pockets/manual-returns")
      return [200, { items: await manualReturns(input.reader, url) }];
    return [404, { error: "not_found" }];
  };
}

async function funded(input: Parameters<typeof createRoutes>[0], url: URL) {
  const vault = url.searchParams.get("vault")?.toLowerCase();
  const items = [];
  for (const entry of input.pockets.values()) {
    if (entry.vault.toLowerCase() !== vault) continue;
    const record = await input.pocketState(entry.pocket);
    if (!["Registered", "Funded", "Draining"].includes(record.state)) continue;
    items.push({
      pocket: entry.pocket,
      vault: entry.vault,
      state: record.state,
      outstanding: record.outstanding.toString(),
      pendingPullback: record.pendingPullback.toString(),
      envelopeRef: entry.envelopeRef,
    });
  }
  return items;
}

async function closedWithBalance(input: Parameters<typeof createRoutes>[0]) {
  const items = [];
  for (const entry of input.pockets.values()) {
    const record = await input.pocketState(entry.pocket);
    if (record.state !== "Closed") continue;
    const observation = await input.observe(entry.pocket);
    const withdrawing = await input.withdrawing(entry.pocket);
    if (observation.available === 0n && withdrawing === 0n) continue;
    items.push({
      pocket: entry.pocket,
      pocketRecord: { pocket: entry.pocket, vault: entry.vault, state: record.state },
      balance: {
        gatewayAvailableAtomic: observation.available.toString(),
        gatewayWithdrawingAtomic: withdrawing.toString(),
      },
    });
  }
  return items;
}

async function manualReturns(reader: PublicClient, url: URL) {
  const vault = url.searchParams.get("vault") as Address | null;
  if (!vault) return [];
  const events = await reader.getContractEvents({
    address: vault,
    abi: czarVaultAbi,
    eventName: "ManualReturnRecorded",
    fromBlock: 0n,
  });
  return events
    .map((event) => ({
      pocket: event.args.pocket,
      credit: (event.args.amount ?? 0n).toString(),
      txHash: event.transactionHash,
      block: event.blockNumber.toString(),
      logIndex: event.logIndex,
    }))
    .toSorted((left, right) =>
      BigInt(left.block) === BigInt(right.block)
        ? left.logIndex - right.logIndex
        : BigInt(left.block) < BigInt(right.block)
          ? -1
          : 1,
    );
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}
