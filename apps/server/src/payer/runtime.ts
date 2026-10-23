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
  readonly fallbackPollSeconds?: number;
  readonly runFallbacks?: () => Promise<unknown>;
  readonly onError?: (operation: "halt-drain" | "pullback-fallback", error: unknown) => void;
  readonly drain?: typeof drainPocketsAfterHalt;
}

export function startPayerRuntime(options: PayerRuntimeOptions): { stop(): void } {
  const unsubscribe = subscribeHaltEvents(options);
  const timer = scheduleFallbacks(options);
  return {
    stop() {
      unsubscribe?.();
      if (timer) clearInterval(timer);
    },
  };
}

function subscribeHaltEvents(options: PayerRuntimeOptions): (() => void) | undefined {
  if (!options.events) return undefined;
  if (!options.pocketHalt) throw new Error("Vault halt event source requires pocket drain ports.");
  const drain = options.drain ?? drainPocketsAfterHalt;
  return options.events.subscribe(async (event) => {
    if (event.name !== "Frozen" && event.name !== "GuardianPaused") return;
    try {
      await drain(
        { vault: event.vault, event: event.name },
        options.pocketHalt as PocketHaltDependencies,
      );
    } catch (error) {
      options.onError?.("halt-drain", error);
      throw error;
    }
  });
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
