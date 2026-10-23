import { describe, expect, it, vi } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  type Address,
  type PublicClient,
} from "viem";
import { czarVaultAbi } from "@czar/vault-client";
import type { Pool } from "pg";
import { createPullbackExecutionChain } from "#src/payer/pullback-execution-chain";

const VAULT = "0x0000000000000000000000000000000000000001" as Address;
const MINTER = "0x0000000000000000000000000000000000000002" as Address;
const HASH = `0x${"ab".repeat(32)}` as const;
const POCKET = "0x0000000000000000000000000000000000000003" as Address;
const REQUEST_TX = "0x1234" as const;

describe("createPullbackExecutionChain", () => {
  it("reads the vault fee ceiling and maps the vault pullback view", async () => {
    const readContract = vi.fn(async (request: { functionName: string }) => {
      if (request.functionName === "maxPullbackFee") return 20_000n;
      return {
        pocket: "0x0000000000000000000000000000000000000003",
        requestedAtBlock: 4_000n,
        state: 1,
        recovery: false,
        value: 900_000n,
        maxFee: 10_000n,
        maxBlockHeight: 8_000n,
        salt: HASH,
        transferSpecHash: HASH,
      };
    });
    const chain = createPullbackExecutionChain({
      client: { readContract } as unknown as PublicClient,
      pool: { query: vi.fn() } as unknown as Pool,
      vault: VAULT,
      gatewayMinter: MINTER,
    });

    await expect(chain.maxPullbackFee()).resolves.toBe(20_000n);
    await expect(chain.readPullback(9n)).resolves.toMatchObject({
      pullbackId: 9n,
      value: 900_000n,
      state: "Pending",
      transferSpecHash: HASH,
    });
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: VAULT,
        functionName: "getPullback",
        args: [9n],
      }),
    );
  });

  it("recovers a mined pullback request from its stored signed transaction", async () => {
    const topics = encodeEventTopics({
      abi: czarVaultAbi,
      eventName: "PullbackRequested",
      args: { pullbackId: 10n, pocket: POCKET, transferSpecHash: HASH },
    });
    const data = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
      [900_000n, 10_000n, 8_000n, HASH],
    );
    const getTransactionReceipt = vi.fn(async ({ hash }: { hash: `0x${string}` }) => {
      expect(hash).toBe(keccak256(REQUEST_TX));
      return {
        status: "success",
        logs: [{ address: VAULT, data, topics }],
      };
    });
    const readContract = vi.fn(async () => ({
      state: 1,
      value: 900_000n,
      maxFee: 10_000n,
      maxBlockHeight: 8_000n,
      salt: HASH,
      transferSpecHash: HASH,
    }));
    const query = vi.fn(async () => ({
      rows: [{ payload: { pocket: POCKET, transaction: REQUEST_TX } }],
    }));
    const chain = createPullbackExecutionChain({
      client: { readContract, getTransactionReceipt } as unknown as PublicClient,
      pool: { query } as unknown as Pool,
      vault: VAULT,
      gatewayMinter: MINTER,
    });

    await expect(chain.findPendingPullback(POCKET)).resolves.toMatchObject({
      pullbackId: 10n,
      value: 900_000n,
      state: "Pending",
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("phase='pullback.request.sent'"), [
      POCKET,
    ]);
    expect(getTransactionReceipt).toHaveBeenCalledOnce();
  });
});
