import { afterEach, describe, expect, it, vi } from "vitest";
import { startPayerRuntime, type VaultHaltEventSource } from "#src/payer/runtime";

afterEach(() => vi.useRealTimers());

describe("payer runtime wiring", () => {
  it("drains funded pockets for Frozen and GuardianPaused events", async () => {
    const listeners: ((event: { name: string; vault: `0x${string}` }) => Promise<void>)[] = [];
    const source: VaultHaltEventSource = {
      subscribe: (listener) => {
        listeners.push(listener);
        return Object.assign(() => undefined, { ready: Promise.resolve() });
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
        return Object.assign(() => undefined, { ready: Promise.resolve() });
      },
    };
    const onError = vi.fn();
    const lowerAutoLimits = vi.fn(async () => undefined);
    const runtime = startPayerRuntime({
      events: source,
      pocketHalt: {
        listFundedPockets: async () => ["0x0000000000000000000000000000000000000001"],
        pullback: async () => {
          throw new Error("temporary signer failure");
        },
      },
      lowerAutoLimits,
      onError,
    });

    await expect(
      listener?.({
        name: "Frozen",
        vault: "0x0000000000000000000000000000000000000002",
      }),
    ).rejects.toThrow("failed for 1 funded pocket(s)");
    expect(onError).toHaveBeenCalledWith("halt-drain", expect.any(Error));
    expect(lowerAutoLimits).toHaveBeenCalledOnce();
    runtime.stop();
  });

  it("propagates GuardianPaused drain failure so the source can retry", async () => {
    let listener: ((event: { name: string; vault: `0x${string}` }) => Promise<void>) | undefined;
    const onError = vi.fn();
    const lowerAutoLimits = vi.fn(async () => undefined);
    const runtime = startPayerRuntime({
      events: {
        subscribe(next) {
          listener = next;
          return Object.assign(() => undefined, { ready: Promise.resolve() });
        },
      },
      pocketHalt: {
        listFundedPockets: async () => ["0x0000000000000000000000000000000000000001"],
        pullback: async () => {
          throw new Error("temporary pullback failure");
        },
      },
      lowerAutoLimits,
      onError,
    });

    await expect(
      listener?.({
        name: "GuardianPaused",
        vault: "0x0000000000000000000000000000000000000002",
      }),
    ).rejects.toThrow("failed for 1 funded pocket(s)");
    expect(onError).toHaveBeenCalledWith("halt-drain", expect.any(Error));
    expect(lowerAutoLimits).not.toHaveBeenCalled();
    runtime.stop();
  });

  it("lowers category auto limits after Frozen but not GuardianPaused", async () => {
    const listeners: ((event: { name: string; vault: `0x${string}` }) => Promise<void>)[] = [];
    const lowerAutoLimits = vi.fn(async () => undefined);
    const runtime = startPayerRuntime({
      events: {
        subscribe(listener) {
          listeners.push(listener);
          return Object.assign(() => undefined, { ready: Promise.resolve() });
        },
      },
      pocketHalt: { listFundedPockets: async () => [], pullback: async () => undefined },
      lowerAutoLimits,
    });
    const vault = "0x0000000000000000000000000000000000000001";
    await listeners[0]?.({ name: "GuardianPaused", vault });
    await listeners[0]?.({ name: "Frozen", vault });
    expect(lowerAutoLimits).toHaveBeenCalledOnce();
    expect(lowerAutoLimits).toHaveBeenCalledWith(vault);
    runtime.stop();
  });

  it("propagates auto-limit lowering failure for event-source retry", async () => {
    let listener: ((event: { name: string; vault: `0x${string}` }) => Promise<void>) | undefined;
    const onError = vi.fn();
    const runtime = startPayerRuntime({
      events: {
        subscribe(next) {
          listener = next;
          return Object.assign(() => undefined, { ready: Promise.resolve() });
        },
      },
      pocketHalt: { listFundedPockets: async () => [], pullback: async () => undefined },
      lowerAutoLimits: async () => {
        throw new Error("temporary signer refusal");
      },
      onError,
    });
    await expect(
      listener?.({ name: "Frozen", vault: "0x0000000000000000000000000000000000000001" }),
    ).rejects.toThrow("temporary signer refusal");
    expect(onError).toHaveBeenCalledWith("freeze-auto-limit", expect.any(Error));
    runtime.stop();
  });

  it("skips completed lowering during a drain retry", async () => {
    let listener:
      | ((
          event: { name: string; vault: `0x${string}`; autoLimitsLowered: boolean },
          markLowered: () => Promise<void>,
        ) => Promise<void>)
      | undefined;
    const lowerAutoLimits = vi.fn(async () => undefined);
    const pullback = vi.fn(async () => undefined);
    const runtime = startPayerRuntime({
      events: {
        subscribe(next) {
          listener = next as typeof listener;
          return Object.assign(() => undefined, { ready: Promise.resolve() });
        },
      },
      pocketHalt: {
        listFundedPockets: async () => ["0x0000000000000000000000000000000000000001"],
        pullback,
      },
      lowerAutoLimits,
    });
    const markLowered = vi.fn(async () => undefined);
    await listener?.(
      {
        name: "Frozen",
        vault: "0x0000000000000000000000000000000000000002",
        autoLimitsLowered: true,
      },
      markLowered,
    );
    expect(lowerAutoLimits).not.toHaveBeenCalled();
    expect(markLowered).not.toHaveBeenCalled();
    expect(pullback).toHaveBeenCalledOnce();
    runtime.stop();
  });

  it("shares one in-flight freeze operation for duplicate events", async () => {
    let listener: ((event: { name: string; vault: `0x${string}` }) => Promise<void>) | undefined;
    let completeLowering: (() => void) | undefined;
    const lowerAutoLimits = vi.fn(
      () => new Promise<void>((resolve) => (completeLowering = resolve)),
    );
    const listFundedPockets = vi.fn(async () => []);
    const runtime = startPayerRuntime({
      events: {
        subscribe(next) {
          listener = next;
          return Object.assign(() => undefined, { ready: Promise.resolve() });
        },
      },
      pocketHalt: { listFundedPockets, pullback: async () => undefined },
      lowerAutoLimits,
    });
    const event = {
      name: "Frozen",
      vault: "0x0000000000000000000000000000000000000001" as const,
    };
    const first = listener?.(event);
    const second = listener?.(event);
    await vi.waitFor(() => expect(lowerAutoLimits).toHaveBeenCalledOnce());
    expect(listFundedPockets).not.toHaveBeenCalled();
    completeLowering?.();
    await Promise.all([first, second]);
    expect(listFundedPockets).toHaveBeenCalledOnce();
    runtime.stop();
  });
});
