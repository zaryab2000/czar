import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "@czar/config";
import { createJobChainAdapter } from "#src/payer/job-chain-adapter";

describe("job chain adapter", () => {
  it("treats Circle's zero budget as not set while the provider waits", async () => {
    const readContract = vi
      .fn()
      .mockResolvedValueOnce({ state: 1, jobId: 7n, expiredAt: 100 })
      .mockResolvedValueOnce({ status: 0, budget: 0n });
    const adapter = createJobChainAdapter({
      client: { readContract } as never,
      pool: { query: vi.fn() } as never,
      config: loadConfig(),
      vault: "0x0000000000000000000000000000000000000001",
      jobEscrow: "0x0000000000000000000000000000000000000002",
      usdc: "0x0000000000000000000000000000000000000003",
      now: () => new Date("2026-10-23T00:00:00Z"),
    });

    const job = await adapter.getJob(`0x${"11".repeat(32)}` as `0x${string}`);

    expect(job).toMatchObject({ vaultState: "Opened", escrowState: "Open" });
    expect(job.budget).toBeUndefined();
  });
});
