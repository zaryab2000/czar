import { afterEach, describe, expect, it, vi } from "vitest";
import { startPayerRuntime, type VaultHaltEventSource } from "#src/payer/runtime";

afterEach(() => vi.useRealTimers());

describe("payer runtime wiring", () => {
  it("drains funded pockets for Frozen and GuardianPaused events", async () => {
    const listeners: ((event: { name: string; vault: `0x${string}` }) => Promise<void>)[] = [];
    const source: VaultHaltEventSource = {
      subscribe: (listener) => {
        listeners.push(listener);
        return () => undefined;
      },
    };
    const pocket = "0x0000000000000000000000000000000000000001" as const;
    const listFundedPockets = vi.fn(async () => [pocket]);
    const pullback = vi.fn(async () => undefined);
    const runtime = startPayerRuntime({
      events: source,
      pocketHalt: { listFundedPockets, pullback },
      fallbackPollSeconds: 60,
      runFallbacks: async () => undefined,
    });
    await listeners[0]?.({
      name: "Frozen",
      vault: "0x0000000000000000000000000000000000000001",
    });
    await listeners[0]?.({
      name: "GuardianPaused",
      vault: "0x0000000000000000000000000000000000000002",
    });
    expect(listFundedPockets).toHaveBeenCalledTimes(2);
    expect(pullback).toHaveBeenCalledTimes(2);
    expect(pullback).toHaveBeenCalledWith(pocket);
    runtime.stop();
  });

  it("runs the slow-pullback scan on the configured interval", async () => {
    vi.useFakeTimers();
    const runFallbacks = vi.fn(async () => undefined);
    const runtime = startPayerRuntime({ fallbackPollSeconds: 5, runFallbacks });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runFallbacks).toHaveBeenCalledTimes(1);
    runtime.stop();
  });

  it("runs closed-pocket recovery on its separate configured interval", async () => {
    vi.useFakeTimers();
    const runClosedRecovery = vi.fn(async () => undefined);
    const runtime = startPayerRuntime({
      recoveryPollSeconds: 60,
      runClosedRecovery,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runClosedRecovery).toHaveBeenCalledOnce();
    runtime.stop();
  });

  it("propagates a failed halt drain after logging so its source can retry", async () => {
    let listener: ((event: { name: string; vault: `0x${string}` }) => Promise<void>) | undefined;
    const source: VaultHaltEventSource = {
      subscribe: (next) => {
        listener = next;
        return () => undefined;
      },
    };
    const onError = vi.fn();
    const runtime = startPayerRuntime({
      events: source,
      pocketHalt: {
        listFundedPockets: async () => ["0x0000000000000000000000000000000000000001"],
        pullback: async () => {
          throw new Error("temporary signer failure");
        },
      },
      onError,
    });

    await expect(
      listener?.({
        name: "Frozen",
        vault: "0x0000000000000000000000000000000000000002",
      }),
    ).rejects.toThrow("failed for 1 funded pocket(s)");
    expect(onError).toHaveBeenCalledWith("halt-drain", expect.any(Error));
    runtime.stop();
  });
});
