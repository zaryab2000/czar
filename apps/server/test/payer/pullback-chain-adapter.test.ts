import { describe, expect, it, vi } from "vitest";
import { createLogger } from "@czar/logging";
import { loadConfig } from "@czar/config";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { createPullbackChainAdapter } from "#src/payer/pullback-chain-adapter";

const POCKET = "0x0000000000000000000000000000000000000001" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" as Address;
const VAULT = "0x0000000000000000000000000000000000000002" as Address;
const TRANSACTION = `0x${"ab".repeat(64)}` as Hex;
const TX_HASH = `0x${"cd".repeat(32)}` as Hex;
const TRANSFER_ABI = parseAbi(["function transfer(address to, uint256 value) returns (bool)"]);

describe("createPullbackChainAdapter", () => {
  it("reads the current block, USDC balance, and withdrawal block through viem", async () => {
    const getBlockNumber = vi.fn(async () => 42n);
    const readContract = vi.fn(async () => 123_456n);
    const adapter = createPullbackChainAdapter(
      { getBlockNumber, readContract } as unknown as PublicClient,
      { sendRawTransaction: vi.fn() } as unknown as WalletClient,
      GATEWAY_WALLET,
      { config: loadConfig() },
    );

    await expect(adapter.getBlockNumber()).resolves.toBe(42n);
    await expect(adapter.withdrawalBlock(POCKET)).resolves.toBe(123_456n);
    await expect(adapter.withdrawingBalance(POCKET)).resolves.toBe(123_456n);
    expect(getBlockNumber).toHaveBeenCalledOnce();
    expect(readContract).toHaveBeenCalledWith({
      address: GATEWAY_WALLET,
      abi: [
        {
          type: "function",
          name: "withdrawalBlock",
          inputs: [
            { name: "token", type: "address" },
            { name: "depositor", type: "address" },
          ],
          outputs: [{ name: "", type: "uint256" }],
          stateMutability: "view",
        },
      ],
      functionName: "withdrawalBlock",
      args: [USDC, POCKET],
    });
    expect(readContract).toHaveBeenCalledWith({
      address: GATEWAY_WALLET,
      abi: [
        {
          type: "function",
          name: "withdrawingBalance",
          inputs: [
            { name: "token", type: "address" },
            { name: "depositor", type: "address" },
          ],
          outputs: [{ name: "", type: "uint256" }],
          stateMutability: "view",
        },
      ],
      functionName: "withdrawingBalance",
      args: [USDC, POCKET],
    });
  });

  it("returns balance - gasReserve from the signer's preparer, probing with a one-unit transfer (SCR-152)", async () => {
    const readContract = vi.fn(async () => 10_000n);
    const prepared: { from: Address; data: Hex }[] = [];
    const adapter = createPullbackChainAdapter(
      { readContract } as unknown as PublicClient,
      { sendRawTransaction: vi.fn() } as unknown as WalletClient,
      GATEWAY_WALLET,
      {
        config: loadConfig(),
        transactionPreparer: async (from, call) => {
          prepared.push({ from, data: call.data });
          return {
            type: "eip1559",
            chainId: 5042002,
            to: call.to,
            data: call.data,
            gas: 200_000n,
            maxFeePerGas: 20_000_000_000n,
          };
        },
      },
    );

    // 200,000 gas × 20 gwei = 4,000 USDC atomic units of gas reserve.
    await expect(adapter.pocketReturnable(POCKET, VAULT)).resolves.toBe(6_000n);
    expect(readContract).toHaveBeenCalledWith({
      address: USDC,
      abi: expect.any(Array),
      functionName: "balanceOf",
      args: [POCKET],
    });
    expect(prepared.map((call) => call.from)).toEqual([POCKET, POCKET]);
    expect(
      prepared.map((call) => decodeFunctionData({ abi: TRANSFER_ABI, data: call.data }).args),
    ).toEqual([
      [VAULT, 1n],
      [VAULT, 6_000n],
    ]);
  });

  it("reports nothing returnable for an empty pocket without preparing a transfer", async () => {
    const transactionPreparer = vi.fn();
    const adapter = createPullbackChainAdapter(
      { readContract: vi.fn(async () => 0n) } as unknown as PublicClient,
      { sendRawTransaction: vi.fn() } as unknown as WalletClient,
      GATEWAY_WALLET,
      { config: loadConfig(), transactionPreparer },
    );

    await expect(adapter.pocketReturnable(POCKET, VAULT)).resolves.toBe(0n);
    expect(transactionPreparer).not.toHaveBeenCalled();
  });

  it("submits the signed transaction and logs its kind and hash only", async () => {
    const sink: string[] = [];
    const sendRawTransaction = vi.fn(async () => TX_HASH);
    const waitForTransactionReceipt = vi.fn(async () => ({ status: "success" as const }));
    const wallet = { sendRawTransaction } as unknown as WalletClient;
    const adapter = createPullbackChainAdapter(
      { waitForTransactionReceipt } as unknown as PublicClient,
      wallet,
      GATEWAY_WALLET,
      {
        config: loadConfig(),
        logger: createLogger({
          service: "server",
          component: "CZ-15",
          sink: (line) => sink.push(line),
        }),
      },
    );

    await expect(adapter.sendPocketTransaction(TRANSACTION, "pocket-return")).resolves.toBe(
      TX_HASH,
    );
    expect(sendRawTransaction).toHaveBeenCalledWith({ serializedTransaction: TRANSACTION });
    expect(waitForTransactionReceipt).toHaveBeenCalledWith({ hash: TX_HASH });
    expect(sink.join("\n")).toContain("pocket-return");
    expect(sink.join("\n")).toContain(TX_HASH);
    expect(sink.join("\n")).not.toContain(TRANSACTION);
  });

  it("reads the mined USDC Transfer receipt used to prove a vault return", async () => {
    const abi = parseAbi([
      "event Transfer(address indexed from, address indexed to, uint256 value)",
    ]);
    const topics = encodeEventTopics({
      abi,
      eventName: "Transfer",
      args: { from: POCKET, to: VAULT },
    });
    const getTransactionReceipt = vi.fn(async () => ({
      status: "success" as const,
      blockNumber: 84n,
      logs: [
        {
          address: USDC,
          data: encodeAbiParameters([{ type: "uint256" }], [12_000n]),
          topics,
          logIndex: 7,
        },
      ],
    }));
    const adapter = createPullbackChainAdapter(
      { getTransactionReceipt } as unknown as PublicClient,
      {} as WalletClient,
      GATEWAY_WALLET,
      { config: loadConfig() },
    );

    await expect(adapter.transactionReceipt(TX_HASH)).resolves.toMatchObject({
      status: "success",
      blockNumber: 84n,
      logs: [{ address: USDC, from: POCKET, to: VAULT, value: 12_000n, logIndex: 7 }],
    });
    expect(getTransactionReceipt).toHaveBeenCalledWith({ hash: TX_HASH });
  });
});
