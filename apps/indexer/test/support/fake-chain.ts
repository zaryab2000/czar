// In-process JSON-RPC upstream with a deterministic chain, used when no `arc-anvil` URL is given
// (ARC_ANVIL_URL). It answers the calls Ponder makes during a backfill: chain id, head, blocks and logs.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { keccak256, numberToHex, padHex, toHex } from "viem";

export const FAKE_CHAIN_ID = 5042002;
export const EMITTER = "0x00000000000000000000000000000000000c2a5e";
/** keccak256("Ping(uint256)") */
export const PING_TOPIC = keccak256(toHex("Ping(uint256)"));

export interface FakeChain {
  readonly url: string;
  readonly head: bigint;
  /** Blocks carrying one Ping log each. */
  readonly logBlocks: readonly bigint[];
  close(): Promise<void>;
}

const blockHash = (n: bigint) => keccak256(toHex(`czar-fake-block-${n}`));
const ZERO_HASH = padHex("0x0", { size: 32 });
const GENESIS_TIME = 1_760_000_000n;

const txHash = (n: bigint) => keccak256(toHex(`czar-fake-tx-${n}`));

function transaction(n: bigint) {
  return {
    hash: txHash(n),
    nonce: numberToHex(n),
    blockHash: blockHash(n),
    blockNumber: numberToHex(n),
    transactionIndex: "0x0",
    from: "0x0000000000000000000000000000000000000f01",
    to: EMITTER,
    value: "0x0",
    gas: numberToHex(50_000n),
    gasPrice: numberToHex(20_000_000_000n),
    input: "0x",
    type: "0x0",
    chainId: numberToHex(FAKE_CHAIN_ID),
    v: "0x1b",
    r: padHex("0x1", { size: 32 }),
    s: padHex("0x1", { size: 32 }),
  };
}

function block(n: bigint, hasLog: boolean, full: boolean) {
  return {
    number: numberToHex(n),
    hash: blockHash(n),
    parentHash: n === 0n ? ZERO_HASH : blockHash(n - 1n),
    timestamp: numberToHex(GENESIS_TIME + n / 2n),
    nonce: "0x0000000000000000",
    difficulty: "0x0",
    totalDifficulty: "0x0",
    gasLimit: numberToHex(30_000_000n),
    gasUsed: "0x0",
    miner: "0x0000000000000000000000000000000000000000",
    extraData: "0x",
    logsBloom: padHex("0x0", { size: 256 }),
    mixHash: ZERO_HASH,
    receiptsRoot: ZERO_HASH,
    sha3Uncles: ZERO_HASH,
    stateRoot: ZERO_HASH,
    transactionsRoot: ZERO_HASH,
    baseFeePerGas: numberToHex(20_000_000_000n),
    size: "0x200",
    transactions: hasLog ? [full ? transaction(n) : txHash(n)] : ([] as unknown[]),
    uncles: [] as unknown[],
  };
}

const log = (n: bigint) => ({
  address: EMITTER,
  topics: [PING_TOPIC],
  data: padHex(numberToHex(n), { size: 32 }),
  blockNumber: numberToHex(n),
  blockHash: blockHash(n),
  transactionHash: txHash(n),
  transactionIndex: "0x0",
  logIndex: "0x0",
  removed: false,
});

export async function startFakeChain(head: bigint, logEvery: bigint): Promise<FakeChain> {
  const logBlocks: bigint[] = [];
  for (let n = logEvery; n <= head; n += logEvery) logBlocks.push(n);
  const hasLog = (n: bigint) => n > 0n && n % logEvery === 0n;

  const resolveTag = (tag: unknown): bigint =>
    tag === "latest" || tag === "finalized" || tag === "safe" || tag === "pending"
      ? head
      : BigInt(tag as string);

  const handle = (method: string, params: unknown[]): unknown => {
    switch (method) {
      case "eth_chainId":
        return numberToHex(FAKE_CHAIN_ID);
      case "net_version":
        return String(FAKE_CHAIN_ID);
      case "eth_blockNumber":
        return numberToHex(head);
      case "eth_getBlockByNumber": {
        const n = resolveTag(params[0]);
        return n > head ? null : block(n, hasLog(n), params[1] === true);
      }
      case "eth_getBlockByHash": {
        const wanted = params[0];
        for (let n = 0n; n <= head; n += 1n)
          if (blockHash(n) === wanted) return block(n, hasLog(n), params[1] === true);
        return null;
      }
      case "eth_getTransactionReceipt": {
        const n = logBlocks.find((candidate) => txHash(candidate) === params[0]);
        if (n === undefined) return null;
        return {
          transactionHash: txHash(n),
          transactionIndex: "0x0",
          blockHash: blockHash(n),
          blockNumber: numberToHex(n),
          from: "0x0000000000000000000000000000000000000f01",
          to: EMITTER,
          cumulativeGasUsed: numberToHex(30_000n),
          gasUsed: numberToHex(30_000n),
          effectiveGasPrice: numberToHex(20_000_000_000n),
          contractAddress: null,
          logs: [log(n)],
          logsBloom: padHex("0x0", { size: 256 }),
          status: "0x1",
          type: "0x0",
        };
      }
      case "eth_getLogs": {
        const filter = params[0] as { fromBlock?: string; toBlock?: string; blockHash?: string };
        if (filter.blockHash !== undefined)
          return logBlocks.filter((n) => blockHash(n) === filter.blockHash).map(log);
        const from = resolveTag(filter.fromBlock ?? "latest");
        const to = resolveTag(filter.toBlock ?? "latest");
        return logBlocks.filter((n) => n >= from && n <= to).map(log);
      }
      default:
        throw Object.assign(new Error(`method ${method} not supported by the fake chain`), {
          code: -32601,
        });
    }
  };

  const one = (call: { id: unknown; method: string; params?: unknown[] }) => {
    try {
      return { jsonrpc: "2.0", id: call.id, result: handle(call.method, call.params ?? []) };
    } catch (error) {
      const code = (error as { code?: number }).code ?? -32603;
      return {
        jsonrpc: "2.0",
        id: call.id,
        error: { code, message: (error as Error).message },
      };
    }
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as
        | { id: unknown; method: string; params?: unknown[] }
        | { id: unknown; method: string; params?: unknown[] }[];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    head,
    logBlocks,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
