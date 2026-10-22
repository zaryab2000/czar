import { describe, expect, it, vi } from "vitest";
import { createLogger } from "@czar/logging";
import { loadConfig } from "@czar/config";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { createPullbackChainAdapter } from "#src/payer/pullback-chain-adapter";

const POCKET = "0x0000000000000000000000000000000000000001" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const TRANSACTION = `0x${"ab".repeat(64)}` as Hex;
const TX_HASH = `0x${"cd".repeat(32)}` as Hex;

describe("createPullbackChainAdapter", () => {
  it("reads the current block and pocket USDC balance through viem", async () => {
    const getBlockNumber = vi.fn(async () => 42n);
    const readContract = vi.fn(async () => 123_456n);
    const adapter = createPullbackChainAdapter(
      { getBlockNumber, readContract } as unknown as PublicClient,
      { sendRawTransaction: vi.fn() } as unknown as WalletClient,
      { config: loadConfig() },
    );

    await expect(adapter.getBlockNumber()).resolves.toBe(42n);
    await expect(adapter.pocketUsdcBalance(POCKET)).resolves.toBe(123_456n);
    expect(getBlockNumber).toHaveBeenCalledOnce();
    expect(readContract).toHaveBeenCalledWith({
      address: USDC,
      abi: expect.any(Array),
      functionName: "balanceOf",
      args: [POCKET],
    });
  });

  it("submits the signed transaction and logs its kind and hash only", async () => {
    const sink: string[] = [];
    const sendRawTransaction = vi.fn(async () => TX_HASH);
    const wallet = { sendRawTransaction } as unknown as WalletClient;
    const adapter = createPullbackChainAdapter({} as PublicClient, wallet, {
      config: loadConfig(),
      logger: createLogger({
        service: "server",
        component: "CZ-15",
        sink: (line) => sink.push(line),
      }),
    });

    await expect(adapter.sendPocketTransaction(TRANSACTION, "pocket-return")).resolves.toBe(
      TX_HASH,
    );
    expect(sendRawTransaction).toHaveBeenCalledWith({ serializedTransaction: TRANSACTION });
    expect(sink.join("\n")).toContain("pocket-return");
    expect(sink.join("\n")).toContain(TX_HASH);
    expect(sink.join("\n")).not.toContain(TRANSACTION);
  });

  it("uses an explicit withdrawal-block reader for the pocket EOA", async () => {
    const withdrawalBlock = vi.fn(async () => 1_209_600n);
    const adapter = createPullbackChainAdapter({} as PublicClient, {} as WalletClient, {
      withdrawalBlock,
    });

    await expect(adapter.withdrawalBlock(POCKET)).resolves.toBe(1_209_600n);
    expect(withdrawalBlock).toHaveBeenCalledWith(POCKET);
  });
});
