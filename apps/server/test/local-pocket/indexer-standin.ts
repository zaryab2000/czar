// Stand-in for the CZ-19 pocket routes the payer's pocket recovery reads (`createIndexerPocketReader`), answered from the
// local chain instead of a running Ponder indexer. The Gateway API figure is the Gateway double's
// `availableBalance` (what the D92 `/v1/balances` stand-in returns on a chain with the doubles placed),
// observed fresh on every read.
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
  async function observe(pocket: Address): Promise<GatewayObservation> {
    const available = await input.reader.readContract({
      address: GATEWAY_WALLET,
      abi: gatewayWalletAbi,
      functionName: "availableBalance",
      args: [ARC_USDC, pocket],
    });
    return { available, observedAt: input.now(), consecutiveFailures: 0 };
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

  const routes = createRoutes({ pockets, observe, pocketState, withdrawing });
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

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}
