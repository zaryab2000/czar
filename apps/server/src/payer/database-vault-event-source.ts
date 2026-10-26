import type { Config } from "@czar/config";
import type { Logger } from "@czar/logging";
import { czarVaultAbi, czarVaultFactoryAbi } from "@czar/vault-client";
import { isAddress, type Address, type PublicClient } from "viem";
import type { Pool } from "pg";
import { createVaultEventSource } from "#src/payer/vault-event-source";
import type { VaultHaltEvent, VaultHaltEventSource } from "#src/payer/runtime";
import {
  processPendingFrozenEvents,
  queueFrozenEvent,
  scanFrozenEvents,
} from "#src/payer/freeze-events";

interface DatabaseVaultEventSourceInput {
  readonly pool: Pool;
  readonly publicClient: PublicClient;
  readonly config: Config;
  readonly logger: Logger;
}

export function createDatabaseVaultEventSource(
  input: DatabaseVaultEventSourceInput,
): VaultHaltEventSource {
  return {
    subscribe(listener) {
      let stopped = false;
      let scanning = false;
      const seenVaults = new Set<Address>();
      const seenHalts = new Set<string>();
      const retryVaults = new Set<Address>();
      const frozenEventRuns = new Map<Address, Promise<void>>();
      const unsubscribe: (() => void)[] = [];
      const emit = async (event: VaultHaltEvent) => {
        const vaultKey = event.vault.toLowerCase();
        if (event.name === "Frozen") {
          try {
            await runFrozenEvents(input.pool, event.vault, event, listener, frozenEventRuns);
          } catch {
            retryVaults.add(event.vault);
            logSourceError(input.logger, "halt_drain_failed");
          }
          return;
        }
        if (event.name === "Unfrozen") {
          return;
        }
        if (event.name === "GuardianUnpaused") {
          seenHalts.delete(`GuardianPaused:${vaultKey}`);
          return;
        }
        if (event.name !== "Frozen" && event.name !== "GuardianPaused") return;
        const key = `${event.name}:${vaultKey}`;
        if (seenHalts.has(key)) return;
        try {
          await listener(event);
          seenHalts.add(key);
        } catch {
          retryVaults.add(event.vault);
          logSourceError(input.logger, "halt_drain_failed");
        }
      };
      const scan = async () => {
        if (stopped || scanning) return;
        scanning = true;
        try {
          const rows = await input.pool.query<{ vault: string }>(
            "SELECT DISTINCT vault FROM users WHERE vault IS NOT NULL ORDER BY vault",
          );
          for (const row of rows.rows) {
            if (!isAddress(row.vault)) {
              logSourceError(input.logger, "invalid_address");
              continue;
            }
            const vault = row.vault;
            try {
              if (!seenVaults.has(vault)) {
                seenVaults.add(vault);
                const source = createVaultEventSource(
                  input.publicClient,
                  vault,
                  input.config,
                  input.logger,
                );
                unsubscribe.push(source.subscribe(emit));
                retryVaults.add(vault);
              }
              await scanFrozenEvents(input.publicClient, input.pool, vault);
              await runFrozenEvents(input.pool, vault, undefined, listener, frozenEventRuns);
              if (!retryVaults.has(vault)) continue;
              retryVaults.delete(vault);
              await reconcileHalt(input.publicClient, vault, emit);
            } catch {
              retryVaults.add(vault);
              logSourceError(input.logger, "reconcile_failed");
            }
          }
        } catch {
          logSourceError(input.logger, "scan_failed");
        } finally {
          scanning = false;
        }
      };
      const interval = Number(input.config.get("payer.vaultEventPollMs"));
      const timer = setInterval(() => void scan(), interval);
      timer.unref();
      void scan();
      return () => {
        stopped = true;
        clearInterval(timer);
        for (const stop of unsubscribe) stop();
      };
    },
  };
}

function runFrozenEvents(
  pool: Pool,
  vault: Address,
  event: VaultHaltEvent | undefined,
  listener: (event: VaultHaltEvent) => Promise<void>,
  runs: Map<Address, Promise<void>>,
): Promise<void> {
  const active = runs.get(vault);
  if (active) return active;
  const processing = processFrozenEvents(pool, vault, event, listener);
  runs.set(vault, processing);
  return processing.finally(() => runs.delete(vault));
}

async function processFrozenEvents(
  pool: Pool,
  vault: Address,
  event: VaultHaltEvent | undefined,
  listener: (event: VaultHaltEvent) => Promise<void>,
): Promise<void> {
  if (event) await queueFrozenEvent(pool, vault, event);
  await processPendingFrozenEvents(pool, vault, listener);
}

async function reconcileHalt(
  client: PublicClient,
  vault: Address,
  emit: (event: VaultHaltEvent) => Promise<void>,
): Promise<void> {
  const factory = await client.readContract({
    address: vault,
    abi: czarVaultAbi,
    functionName: "factory",
  });
  const paused = await client.readContract({
    address: factory,
    abi: czarVaultFactoryAbi,
    functionName: "guardianPaused",
  });
  if (paused) await emit({ name: "GuardianPaused", vault });
}

function logSourceError(
  logger: Logger,
  rule: "invalid_address" | "scan_failed" | "reconcile_failed" | "halt_drain_failed",
): void {
  logger.error("vault_event_source_failure", { rule, state: "error" });
}
