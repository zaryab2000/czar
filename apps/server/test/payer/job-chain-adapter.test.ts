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

  it("treats only submissions before their recorded decision cutoff as pending", async () => {
    const readContract = vi.fn(async ({ address }: { address: string }) =>
      address === "0x0000000000000000000000000000000000000001"
        ? { state: 3, jobId: 7n, expiredAt: 3_000 }
        : { status: 2, budget: 900n },
    );
    const query = vi.fn(async () => ({ rows: [{ brief: { decisionCutoff: 2_000 } }] }));
    const adapter = createJobChainAdapter({
      client: { readContract } as never,
      pool: { query } as never,
      config: loadConfig(),
      vault: "0x0000000000000000000000000000000000000001",
      jobEscrow: "0x0000000000000000000000000000000000000002",
      usdc: "0x0000000000000000000000000000000000000003",
      now: () => new Date(1_999_000),
    });
    const jobKey = `0x${"11".repeat(32)}` as `0x${string}`;

    await expect(adapter.hasDecisionPending(jobKey)).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(
      "SELECT brief FROM payer_job_briefs WHERE lower(job_key)=lower($1)",
      [jobKey],
    );
  });

  it("allows refund after the decision cutoff when no decision has completed", async () => {
    const readContract = vi.fn(async ({ address }: { address: string }) =>
      address === "0x0000000000000000000000000000000000000001"
        ? { state: 3, jobId: 7n, expiredAt: 3_000 }
        : { status: 2, budget: 900n },
    );
    const adapter = createJobChainAdapter({
      client: { readContract } as never,
      pool: {
        query: vi.fn(async () => ({ rows: [{ brief: { decisionCutoff: 2_000 } }] })),
      } as never,
      config: loadConfig(),
      vault: "0x0000000000000000000000000000000000000001",
      jobEscrow: "0x0000000000000000000000000000000000000002",
      usdc: "0x0000000000000000000000000000000000000003",
      now: () => new Date(2_001_000),
    });

    await expect(adapter.hasDecisionPending(`0x${"22".repeat(32)}` as `0x${string}`)).resolves.toBe(
      false,
    );
  });
});
