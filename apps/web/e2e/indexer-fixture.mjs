import { createServer } from "node:http";
import { createIndexerApi } from "../../indexer/src/api/router.ts";
import { createPublicClient, defineChain, http, parseAbiItem } from "viem";
import { E2E_VAULT_FACTORY } from "./e2e-deployment.mjs";

const rpcUrl = process.env["CZAR_ARC_RPC_URL"] ?? "http://127.0.0.1:8549";
const port = Number(process.env["CZAR_TEST_INDEXER_PORT"] ?? 42070);
const startBlock = 68383625n;
const factoryAddress = E2E_VAULT_FACTORY;
const factoryEvent = parseAbiItem(
  "event VaultCreated(address indexed ownerAccount, address indexed vault, uint32 indexed version, address agentSigner, address autonomySigner, address evaluator)",
);
const limitsEvent = parseAbiItem(
  "event LimitsSet(bytes32 indexed categoryId, uint256 userMax, uint256 autoLimit)",
);
const client = createPublicClient({
  chain: defineChain({
    id: 5042002,
    name: "Arc Testnet Fork",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
    rpcUrls: { default: { http: [rpcUrl] } },
  }),
  transport: http(rpcUrl),
});
for (const name of Object.keys(process.env)) {
  if (name.startsWith("CZAR_")) delete process.env[name];
}

const store = {
  async vaultByOwner(owner) {
    const logs = await client.getLogs({
      address: factoryAddress,
      event: factoryEvent,
      args: { ownerAccount: owner },
      fromBlock: startBlock,
      toBlock: "latest",
    });
    const event = logs.at(-1);
    if (!event?.args.vault || !event.args.version) return null;
    return {
      id: event.args.vault.toLowerCase(),
      vault: event.args.vault.toLowerCase(),
      owner: owner.toLowerCase(),
      version: Number(event.args.version),
      agentSigner: event.args.agentSigner,
      autonomySigner: event.args.autonomySigner,
      evaluator: event.args.evaluator,
      createdBlock: event.blockNumber ?? startBlock,
    };
  },
  async envelopesForVault() {
    return [];
  },
  async envelopeByRef() {
    return null;
  },
  async reservationsNeedingSettle() {
    return [];
  },
  async reservationsNeedingFinalize() {
    return [];
  },
  async pullbacksToConfirm() {
    return [];
  },
  async pullbacksToCancel() {
    return [];
  },
  async jobsToSync() {
    return [];
  },
  async jobsAwaitingEvaluation() {
    return [];
  },
  async receiptsForLedger() {
    return [];
  },
  async latestAnchor() {
    return null;
  },
  async anchorByBatch() {
    return null;
  },
  async dependencyState() {
    return [];
  },
};
const app = createIndexerApi(store);
app.get("/health", (context) => context.json({ ready: true }));
app.get("/__e2e/events", async (context) => {
  const vault = context.req.query("vault");
  if (!vault || !/^0x[\da-fA-F]{40}$/.test(vault)) return context.json({ limitsSet: 0 }, 400);
  const logs = await client.getLogs({
    address: vault,
    event: limitsEvent,
    fromBlock: startBlock,
    toBlock: "latest",
  });
  return context.json({ limitsSet: logs.length });
});

const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (typeof value === "string") headers.set(name, value);
    }
    const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
    const request = new Request(`http://127.0.0.1:${port}${incoming.url ?? "/"}`, {
      method: incoming.method ?? "GET",
      headers,
      ...(body === undefined ? {} : { body, duplex: "half" }),
    });
    const response = await app.fetch(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.writeHead(500, { "Content-Type": "application/problem+json" });
    outgoing.end('{"title":"Internal Server Error","status":500}');
  }
});
server.listen(port, "127.0.0.1");
