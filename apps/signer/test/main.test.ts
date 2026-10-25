import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@czar/config";
import type { Hash32 } from "@czar/hashing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startSignerProcess } from "../src/main.ts";
import type { Projection } from "../src/projection.ts";
import { NETWORK, CALLERS } from "./helpers.ts";

describe("signer process bootstrap", () => {
  afterEach(() => vi.useRealTimers());

  it("loads service tokens, opens the keystore, and starts the refill loop", async () => {
    vi.useFakeTimers();
    const dir = await mkdtemp(join(tmpdir(), "czar-signer-main-"));
    const config = loadConfig({
      envFile: {
        "signer.keystorePath": join(dir, "keystore"),
        "signer.socketPath": join(dir, "signer.sock"),
      },
    });
    const opened: string[] = [];
    const running = await startSignerProcess({
      config,
      projection: emptyProjection(),
      network: NETWORK,
      callers: CALLERS,
      allowedCallers: { server: ["cz-15"] },
      prepareTransaction: async () => {
        throw new Error("unexpected transaction preparation");
      },
      auditExecutor: { async query() {} },
      keychainOpen: async (service, account) => {
        opened.push(`${service}:${account}`);
        return { getPassword: () => "a".repeat(64), setPassword() {} };
      },
      env: {},
      argv: ["node", "main.ts"],
      refill: {
        getNativeBalance: async () => 10_000_000n,
        submitTransaction: async () => undefined,
        alert: async () => undefined,
      },
    });

    try {
      expect(opened).toContain("dev.czar.signer.keystore:keystore");
      expect(opened).toContain("dev.czar.signer.keystore.token.server:server");
      expect(opened).toContain("dev.czar.signer.keystore.token.merchants:merchants");
      expect(opened).toContain("dev.czar.signer.keystore.token.relayer-jobs:relayer-jobs");
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      await running.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function emptyProjection(): Projection {
  return {
    freezeState: async () => undefined,
    isVault: async () => false,
    reservation: async () => undefined,
    pullback: async () => undefined,
    blockNumber: async () => 0n,
    storedPlan: async () => undefined,
    envelope: async () => undefined,
    pocket: async () => undefined,
    pocketBalances: async () => ({
      gatewayApi: 0n,
      gatewayAvailable: 0n,
      gatewayApiObservedAt: null,
      gatewayWithdrawing: 0n,
      withdrawalBlock: 0n,
      currentBlock: 0n,
      usdc: 0n,
      native: 0n,
      pendingPullback: false,
      gatewayApiFresh: true,
    }),
    nanoSpent: async () => ({ step: 0n, pocket: 0n }),
    settledPayment: async () => false,
    autonomy: async () => undefined,
    job: async () => undefined,
    reportExists: async () => false,
    checksCommitExists: async () => false,
    latestEvidenceRoot: async () => `0x${"00".repeat(32)}` as Hash32,
    evidenceBatchExists: async () => false,
    nativeBalance: async () => 0n,
    slowWithdrawAllowed: async () => false,
    pocketSpendAfterObservation: async () => false,
  };
}
