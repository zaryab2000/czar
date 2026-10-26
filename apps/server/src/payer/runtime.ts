import type { Address } from "viem";
import { drainPocketsAfterHalt, type PocketHaltDependencies } from "#src/payer/pocket";

export interface VaultHaltEvent {
  readonly name: "Frozen" | "GuardianPaused" | string;
  readonly vault: Address;
}

export interface VaultHaltEventSource {
  subscribe(listener: (event: VaultHaltEvent) => Promise<void>): () => void;
}

export interface PayerRuntimeOptions {
  readonly events?: VaultHaltEventSource;
  readonly pocketHalt?: PocketHaltDependencies;
  readonly lowerAutoLimits?: (vault: Address) => Promise<void>;
  readonly fallbackPollSeconds?: number;
  readonly runFallbacks?: () => Promise<unknown>;
  readonly recoveryPollSeconds?: number;
  readonly runClosedRecovery?: () => Promise<unknown>;
  readonly onError?: (
    operation: "halt-drain" | "freeze-auto-limit" | "pullback-fallback" | "closed-pocket-recovery",
    error: unknown,
  ) => void;
  readonly drain?: typeof drainPocketsAfterHalt;
}

export function startPayerRuntime(options: PayerRuntimeOptions): { stop(): void } {
  const unsubscribe = subscribeHaltEvents(options);
  const timer = scheduleFallbacks(options);
  const recoveryTimer = scheduleClosedRecovery(options);
  return {
    stop() {
      unsubscribe?.();
      if (timer) clearInterval(timer);
      if (recoveryTimer) clearInterval(recoveryTimer);
    },
  };
}

function scheduleClosedRecovery(
  options: PayerRuntimeOptions,
): ReturnType<typeof setInterval> | undefined {
  if (!options.runClosedRecovery) return undefined;
  const seconds = Number(options.recoveryPollSeconds);
  if (!Number.isInteger(seconds) || seconds <= 0)
    throw new RangeError("Closed-pocket recovery interval must be a positive integer.");
  const timer = setInterval(() => {
    void options.runClosedRecovery?.().catch((error: unknown) => {
      options.onError?.("closed-pocket-recovery", error);
      if (!options.onError) throw error;
    });
  }, seconds * 1000);
  timer.unref();
  return timer;
}

function subscribeHaltEvents(options: PayerRuntimeOptions): (() => void) | undefined {
  if (!options.events) return undefined;
  if (!options.pocketHalt && !options.lowerAutoLimits)
    throw new Error("Vault halt event source requires a halt action.");
  const drain = options.drain ?? drainPocketsAfterHalt;
  const inFlight = new Map<string, Promise<void>>();
  return options.events.subscribe(async (event) => {
    if (event.name !== "Frozen" && event.name !== "GuardianPaused") return;
    const key = `${event.name}:${event.vault.toLowerCase()}`;
    const previous = inFlight.get(key);
    if (previous) return previous;
    const handling = handleHaltEvent(event, options, drain);
    inFlight.set(key, handling);
    try {
      await handling;
    } finally {
      inFlight.delete(key);
    }
  });
}

async function handleHaltEvent(
  event: VaultHaltEvent,
  options: PayerRuntimeOptions,
  drain: NonNullable<PayerRuntimeOptions["drain"]>,
): Promise<void> {
  const failures: unknown[] = [];
  if (options.pocketHalt) {
    try {
      await drain(
        { vault: event.vault, event: event.name as "Frozen" | "GuardianPaused" },
        options.pocketHalt,
      );
    } catch (error) {
      options.onError?.("halt-drain", error);
      failures.push(error);
    }
  }
  if (event.name !== "Frozen" || !options.lowerAutoLimits) return;
  try {
    await options.lowerAutoLimits(event.vault);
  } catch (error) {
    options.onError?.("freeze-auto-limit", error);
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Frozen halt actions failed.");
}

function scheduleFallbacks(
  options: PayerRuntimeOptions,
): ReturnType<typeof setInterval> | undefined {
  if (!options.runFallbacks) return undefined;
  const seconds = Number(options.fallbackPollSeconds);
  if (!Number.isInteger(seconds) || seconds <= 0)
    throw new RangeError("Payer fallback poll interval must be a positive integer.");
  const timer = setInterval(() => {
    void options.runFallbacks?.().catch((error: unknown) => {
      options.onError?.("pullback-fallback", error);
      if (!options.onError) throw error;
    });
  }, seconds * 1000);
  timer.unref();
  return timer;
}
