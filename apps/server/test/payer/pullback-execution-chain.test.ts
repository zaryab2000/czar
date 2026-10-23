import { describe, expect, it, vi } from "vitest";
import type { Address, PublicClient } from "viem";
import type { Pool } from "pg";
import { createPullbackExecutionChain } from "#src/payer/pullback-execution-chain";

const VAULT = "0x0000000000000000000000000000000000000001" as Address;
const MINTER = "0x0000000000000000000000000000000000000002" as Address;
const HASH = `0x${"ab".repeat(32)}` as const;

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
});
