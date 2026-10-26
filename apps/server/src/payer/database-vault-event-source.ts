import type { Config } from "@czar/config";
import type { Logger } from "@czar/logging";
import { czarVaultAbi, czarVaultFactoryAbi } from "@czar/vault-client";
import { isAddress, type Address, type PublicClient } from "viem";
import type { Pool } from "pg";
import { createVaultEventSource } from "#src/payer/vault-event-source";
import type {
  VaultHaltEvent,
  VaultHaltEventSource,
  VaultHaltEventSubscription,
} from "#src/payer/runtime";
import {
  advanceFrozenScanTarget,
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
      let nextVaultScanIndex = 0;
      const seenVaults = new Set<Address>();
      const scanCaughtUp = new Map<Address, boolean>();
      const seenHalts = new Set<string>();
      const retryVaults = new Set<Address>();
      const frozenEventRuns = new Map<Address, Promise<void>>();
      const unsubscribe: (() => void)[] = [];
      let resolveReady: (() => void) | undefined;
      let rejectReady: ((reason: unknown) => void) | undefined;
      let readySettled = false;
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
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
      const scan = async (initial = false) => {
        if (stopped || scanning) return;
        scanning = true;
        const failures: unknown[] = [];
        let allCaughtUp = false;
        try {
          const rows = await input.pool.query<{ vault: string }>(
            "SELECT DISTINCT vault FROM users WHERE vault IS NOT NULL ORDER BY vault",
          );
          const vaults: Address[] = [];
          for (const row of rows.rows) {
            if (!isAddress(row.vault)) {
              logSourceError(input.logger, "invalid_address");
              failures.push(new TypeError("Stored user vault is not a valid address."));
              continue;
            }
            const vault = row.vault;
            vaults.push(vault);
            if (!scanCaughtUp.has(vault)) scanCaughtUp.set(vault, false);
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
            } catch (error) {
              retryVaults.add(vault);
              logSourceError(input.logger, "reconcile_failed");
              failures.push(error);
            }
          }
          let scanHead: bigint | undefined;
          let watermarkPersisted = false;
          if (vaults.length > 0) {
            try {
              scanHead = await input.publicClient.getBlockNumber();
              const caughtUpVaults = await advanceFrozenScanTarget(input.pool, vaults, scanHead);
              for (const vault of vaults) scanCaughtUp.set(vault, caughtUpVaults.has(vault));
              watermarkPersisted = true;
            } catch (error) {
              for (const vault of vaults) scanCaughtUp.set(vault, false);
              logSourceError(input.logger, "reconcile_failed");
              failures.push(error);
            }
          }
          if (vaults.length > 0) {
            const index = nextVaultScanIndex % vaults.length;
            const vault = vaults[index];
            if (vault && scanHead !== undefined && watermarkPersisted) {
              nextVaultScanIndex = index + 1;
              try {
                const caughtUp = await scanFrozenEvents(
                  input.publicClient,
                  input.pool,
                  vault,
                  BigInt(Number(input.config.get("indexer.getLogsBlockRange"))),
                  scanHead,
                );
                scanCaughtUp.set(vault, caughtUp);
              } catch (error) {
                scanCaughtUp.set(vault, false);
                retryVaults.add(vault);
                logSourceError(input.logger, "reconcile_failed");
                failures.push(error);
              }
            }
          }
          for (const vault of vaults) {
            try {
              await runFrozenEvents(input.pool, vault, undefined, listener, frozenEventRuns);
            } catch {
              retryVaults.add(vault);
              logSourceError(input.logger, "halt_drain_failed");
            }
          }
          const retryVault = vaults.find((vault) => retryVaults.has(vault));
          if (retryVault) {
            retryVaults.delete(retryVault);
            try {
              await reconcileHalt(input.publicClient, retryVault, emit);
            } catch (error) {
              retryVaults.add(retryVault);
              logSourceError(input.logger, "reconcile_failed");
              failures.push(error);
            }
          }
          allCaughtUp = vaults.every((vault) => scanCaughtUp.get(vault) === true);
        } catch (error) {
          logSourceError(input.logger, "scan_failed");
          failures.push(error);
        } finally {
          scanning = false;
        }
        if (initial && failures.length > 0) {
          rejectReady?.(
            new AggregateError(failures, "Initial vault event synchronization failed."),
          );
          readySettled = true;
          return;
        }
        if (allCaughtUp && !readySettled) {
          readySettled = true;
          resolveReady?.();
        }
      };
      const interval = Number(input.config.get("payer.vaultEventPollMs"));
      const timer = setInterval(() => void scan(), interval);
      timer.unref();
      void scan(true);
      const stop = () => {
        stopped = true;
        clearInterval(timer);
        for (const unsubscribeListener of unsubscribe) unsubscribeListener();
      };
      return Object.assign(stop, { ready }) as VaultHaltEventSubscription;
    },
  };
}

function runFrozenEvents(
  pool: Pool,
  vault: Address,
  event: VaultHaltEvent | undefined,
  listener: Parameters<typeof processPendingFrozenEvents>[2],
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
  listener: Parameters<typeof processPendingFrozenEvents>[2],
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
