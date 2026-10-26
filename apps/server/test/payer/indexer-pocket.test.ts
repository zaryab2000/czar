import { describe, expect, it, vi } from "vitest";
import { createIndexerPocketReader } from "#src/payer/indexer-pocket";

describe("indexer pocket reader", () => {
  it("reads the authoritative Gateway balance and observation time", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        pocket: "0x0000000000000000000000000000000000000002",
        gatewayAvailableAtomic: "850000",
        gatewayWithdrawingAtomic: "0",
        apiObservedAt: "2026-10-22T00:00:00.000Z",
        apiConsecutiveFailures: 2,
        apiAgeSeconds: 1,
        slowWithdrawalOpen: false,
      }),
    );
    const reader = createIndexerPocketReader("http://127.0.0.1:42069", 2_000, fetcher);

    await expect(
      reader.pocketBalance("0x0000000000000000000000000000000000000002"),
    ).resolves.toEqual({
      gatewayAvailableAtomic: 850_000n,
      gatewayWithdrawingAtomic: 0n,
      apiObservedAt: new Date("2026-10-22T00:00:00.000Z"),
      apiConsecutiveFailures: 2,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:42069/pocket-balances/0x0000000000000000000000000000000000000002",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("does not treat missing observations or malformed amounts as balances", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ gatewayAvailableAtomic: "1.5", gatewayWithdrawingAtomic: "0" }),
    );
    const reader = createIndexerPocketReader("http://127.0.0.1:42069", 2_000, fetcher);

    await expect(
      reader.pocketBalance("0x0000000000000000000000000000000000000002"),
    ).rejects.toThrow("malformed pocket balance");
  });

  it("reads manual-return events with their same-block log positions", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        items: [
          {
            pocket: "0x0000000000000000000000000000000000000002",
            credit: "7000",
            txHash: `0x${"44".repeat(32)}`,
            block: "50",
            logIndex: 6,
          },
        ],
      }),
    );
    const reader = createIndexerPocketReader("http://127.0.0.1:42069", 2_000, fetcher);

    await expect(
      reader.manualReturnsForVault("0x0000000000000000000000000000000000000003"),
    ).resolves.toEqual([
      {
        pocket: "0x0000000000000000000000000000000000000002",
        credit: "7000",
        txHash: `0x${"44".repeat(32)}`,
        block: "50",
        logIndex: 6,
      },
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:42069/pockets/manual-returns?vault=0x0000000000000000000000000000000000000003",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
