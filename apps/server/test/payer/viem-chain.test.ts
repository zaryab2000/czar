// SCR-153 §2: the vault-direct chain adapter reports a status-0 `reserve` with the timestamp of the block that
// mined it, read from the receipt and that block's header only. It never replays the transaction with
// `eth_call` and block overrides (the Arc testnet RPC may not support them).
// SCR-155 §2: "now" for a fresh reserve is the latest block timestamp from a fresh read on every call.
import { describe, expect, it } from "vitest";
import { createPublicClient, custom, type Address, type Hex } from "viem";
import { createViemVaultDirectChain } from "#src/payer/viem-chain";
import { ReserveReverted } from "#src/payer/vault-direct";

const VAULT = "0x0000000000000000000000000000000000000001" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const SENDER = "0x0000000000000000000000000000000000000003" as Address;
const TX_HASH = `0x${"0a".repeat(32)}` as Hex;
const BLOCK_HASH = `0x${"0b".repeat(32)}` as Hex;
const SIGNED_RESERVE = "0xdead01" as Hex;
const MINED_BLOCK = 77n;
const MINED_AT = 1_790_000_123n;
const REVERTED = "0x0";
const LATER_BY_SECONDS = 12n;

describe("viem vault-direct chain: reverted reserve", () => {
  it("reports a reverted saved reserve with its mined block's timestamp", async () => {
    const node = fakeNode();
    const chain = createViemVaultDirectChain({ client: node.client, vault: VAULT, usdc: USDC });

    await expect(chain.reserveOutcome?.(TX_HASH)).resolves.toEqual({
      status: "reverted",
      blockTimestamp: MINED_AT,
    });

    expect(node.blockRequests).toEqual([MINED_BLOCK]);
    expect(node.methods).not.toContain("eth_call");
    expect(node.methods).not.toContain("eth_getTransactionByHash");
  });

  it("throws ReserveReverted with the mined block's timestamp when a sent reserve reverts", async () => {
    const node = fakeNode();
    const chain = createViemVaultDirectChain({ client: node.client, vault: VAULT, usdc: USDC });

    const error = await chain
      .reserve({ signedTransaction: SIGNED_RESERVE } as Parameters<typeof chain.reserve>[0])
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ReserveReverted);
    expect(error).toMatchObject({ txHash: TX_HASH, blockTimestamp: MINED_AT });
    expect(node.blockRequests).toEqual([MINED_BLOCK]);
    expect(node.methods).not.toContain("eth_call");
  });

  it("reports no outcome while the saved reserve has no receipt", async () => {
    const node = fakeNode({ mined: false });
    const chain = createViemVaultDirectChain({ client: node.client, vault: VAULT, usdc: USDC });

    await expect(chain.reserveOutcome?.(TX_HASH)).resolves.toBeUndefined();
    expect(node.methods).not.toContain("eth_getBlockByNumber");
  });
});

describe("viem vault-direct chain: chain time", () => {
  it("reads the latest block's timestamp fresh on every call", async () => {
    const node = fakeNode();
    const chain = createViemVaultDirectChain({ client: node.client, vault: VAULT, usdc: USDC });

    await expect(chain.latestBlockTimestamp()).resolves.toBe(MINED_AT);
    node.advance(LATER_BY_SECONDS);
    await expect(chain.latestBlockTimestamp()).resolves.toBe(MINED_AT + LATER_BY_SECONDS);

    expect(node.blockRequests).toEqual(["latest", "latest"]);
  });
});

/** A JSON-RPC node at the transport boundary: one reverted `reserve` mined in `MINED_BLOCK`. */
function fakeNode(options: { mined: boolean } = { mined: true }) {
  const methods: string[] = [];
  const blockRequests: (bigint | string)[] = [];
  let timestamp = MINED_AT;
  const receipt = {
    transactionHash: TX_HASH,
    transactionIndex: "0x0",
    blockHash: BLOCK_HASH,
    blockNumber: hex(MINED_BLOCK),
    from: SENDER,
    to: VAULT,
    cumulativeGasUsed: "0x5208",
    gasUsed: "0x5208",
    effectiveGasPrice: "0x1",
    contractAddress: null,
    logs: [],
    logsBloom: `0x${"00".repeat(256)}`,
    status: REVERTED,
    type: "0x2",
  };
  const client = createPublicClient({
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        methods.push(method);
        const list = (Array.isArray(params) ? params : []) as unknown[];
        switch (method) {
          case "eth_chainId":
            return hex(5_042_002n);
          case "eth_sendRawTransaction":
            return TX_HASH;
          case "eth_blockNumber":
            return hex(MINED_BLOCK);
          case "eth_getTransactionReceipt":
            return options.mined ? receipt : null;
          case "eth_getBlockByNumber": {
            const tag = String(list[0]);
            blockRequests.push(tag === "latest" ? tag : BigInt(tag));
            return blockHeader(tag === "latest" ? MINED_BLOCK : BigInt(tag), timestamp);
          }
          default:
            throw new Error(`unexpected RPC method ${method}`);
        }
      },
    }),
  });
  return {
    client,
    methods,
    blockRequests,
    advance: (seconds: bigint) => {
      timestamp += seconds;
    },
  };
}

function blockHeader(number: bigint, timestamp: bigint) {
  return {
    number: hex(number),
    hash: BLOCK_HASH,
    parentHash: `0x${"0c".repeat(32)}`,
    timestamp: hex(timestamp),
    baseFeePerGas: "0x1",
    gasLimit: "0x1c9c380",
    gasUsed: "0x5208",
    miner: SENDER,
    nonce: "0x0000000000000000",
    difficulty: "0x0",
    extraData: "0x",
    logsBloom: `0x${"00".repeat(256)}`,
    transactionsRoot: `0x${"00".repeat(32)}`,
    stateRoot: `0x${"00".repeat(32)}`,
    receiptsRoot: `0x${"00".repeat(32)}`,
    sha3Uncles: `0x${"00".repeat(32)}`,
    mixHash: `0x${"00".repeat(32)}`,
    size: "0x0",
    transactions: [],
    uncles: [],
  };
}

function hex(value: bigint): Hex {
  return `0x${value.toString(16)}`;
}
