import { describe, expect, it, vi } from "vitest";
import {
  createLocalSignerPolicy,
  createRpcGasRefillAdapters,
  createRpcTransactionPreparer,
} from "../src/runtime-adapters.ts";

describe("local signer runtime adapters", () => {
  it("binds each service identity to the policy callers it may present", () => {
    const policy = createLocalSignerPolicy();

    expect(policy.allowedCallers).toEqual({
      server: ["cz-15", "cz-16", "cz-17", "cz-24"],
      merchants: ["cz-20"],
      "relayer-jobs": ["relayer"],
    });
    expect(policy.callers["cz-15"]).toEqual(["K3", "K4"]);
    expect(policy.callers["cz-17"]).toEqual(["K8"]);
    expect(policy.callers["cz-20"]).toEqual(["K10"]);
  });

  it("prepares an EIP-1559 transaction from the RPC account and call", async () => {
    const prepareTransactionRequest = vi.fn(async (request: unknown) => ({
      ...((request ?? {}) as object),
      nonce: 4,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
      gas: 21_000n,
    }));
    const getChainId = vi.fn(async () => 5042002);
    const estimateGas = vi.fn(async () => 21_000n);
    const prepare = createRpcTransactionPreparer({
      chainId: 5042002,
      rpcUrl: "http://127.0.0.1:18545",
      client: { getChainId, estimateGas, prepareTransactionRequest } as never,
    });

    await expect(
      prepare("0x0000000000000000000000000000000000000001", {
        to: "0x0000000000000000000000000000000000000002",
        data: "0x1234",
        value: 3n,
      }),
    ).resolves.toMatchObject({
      chainId: 5042002,
      type: "eip1559",
      nonce: 4,
      gas: 21_000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    });
    expect(prepareTransactionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        account: "0x0000000000000000000000000000000000000001",
        to: "0x0000000000000000000000000000000000000002",
        data: "0x1234",
        value: 3n,
        chain: expect.objectContaining({
          id: 5042002,
          rpcUrls: { default: { http: ["http://127.0.0.1:18545"] } },
        }),
      }),
    );
  });

  it("estimates gas without a fee cap, then prepares the transaction with that gas (SCR-152)", async () => {
    // On Arc a fee-capped estimate pre-charges gas × fee from the same USDC balance the call moves, so a
    // pocket-return of balance − gasReserve would revert in estimation.
    const estimateGas = vi.fn(async () => 74_409n);
    const prepareTransactionRequest = vi.fn(async (request: Record<string, unknown>) => ({
      ...request,
      nonce: 0,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    }));
    const prepare = createRpcTransactionPreparer({
      chainId: 5042002,
      rpcUrl: "http://127.0.0.1:18545",
      client: { getChainId: async () => 5042002, estimateGas, prepareTransactionRequest } as never,
    });
    const call = {
      to: "0x0000000000000000000000000000000000000002",
      data: "0x1234",
      value: 0n,
    } as const;

    await expect(
      prepare("0x0000000000000000000000000000000000000001", call),
    ).resolves.toMatchObject({ gas: 74_409n });
    expect(estimateGas).toHaveBeenCalledWith({
      account: "0x0000000000000000000000000000000000000001",
      ...call,
    });
    expect(prepareTransactionRequest).toHaveBeenCalledWith(
      expect.objectContaining({ gas: 74_409n }),
    );
  });

  it("refuses to prepare transactions when the RPC is on another chain", async () => {
    const prepareTransactionRequest = vi.fn();
    const prepare = createRpcTransactionPreparer({
      chainId: 5042002,
      rpcUrl: "http://127.0.0.1:8545",
      client: {
        getChainId: async () => 31337,
        prepareTransactionRequest,
      } as never,
    });

    await expect(
      prepare("0x0000000000000000000000000000000000000001", {
        to: "0x0000000000000000000000000000000000000002",
        data: "0x",
        value: 0n,
      }),
    ).rejects.toThrow("RPC chain 31337; expected 5042002");
    expect(prepareTransactionRequest).not.toHaveBeenCalled();
  });

  it("submits refill transactions and rejects reverted receipts", async () => {
    const sendRawTransaction = vi.fn(async () => `0x${"ab".repeat(32)}` as `0x${string}`);
    const waitForTransactionReceipt = vi.fn(async () => ({ status: "reverted" as const }));
    const adapters = createRpcGasRefillAdapters({
      client: {
        getBalance: async () => 0n,
        sendRawTransaction,
        waitForTransactionReceipt,
      } as never,
    });

    await expect(adapters.submitTransaction(`0x${"01".repeat(32)}`)).rejects.toThrow("reverted");
    expect(waitForTransactionReceipt).toHaveBeenCalledWith({
      hash: `0x${"ab".repeat(32)}`,
    });
  });
});
