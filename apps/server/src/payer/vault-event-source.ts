import { loadConfig, type Config } from "@czar/config";
import { createLogger, type Logger } from "@czar/logging";
import { czarVaultAbi, czarVaultFactoryAbi } from "@czar/vault-client";
import type { Address, PublicClient } from "viem";
import type { VaultHaltEvent, VaultHaltEventSource } from "#src/payer/runtime";

export function createVaultEventSource(
  client: PublicClient,
  vaultAddress: Address,
  config: Config = loadConfig(),
  logger: Logger = createLogger({ service: "server", component: "CZ-15" }),
): VaultHaltEventSource {
  const pollingInterval = Number(config.get("payer.vaultEventPollMs"));
  return {
    subscribe(listener) {
      let stopped = false;
      const unsubscribe: (() => void)[] = [];
      void watchEvents(
        client,
        vaultAddress,
        pollingInterval,
        listener,
        unsubscribe,
        () => stopped,
      ).catch(() =>
        logger.error("vault_event_subscription_failed", {
          rule: "vault_event_source",
          state: "error",
        }),
      );
      return () => {
        stopped = true;
        for (const stop of unsubscribe) stop();
      };
    },
  };
}

async function watchEvents(
  client: PublicClient,
  vaultAddress: Address,
  pollingInterval: number,
  listener: (event: VaultHaltEvent) => Promise<void>,
  unsubscribe: (() => void)[],
  isStopped: () => boolean,
): Promise<void> {
  const factory = await client.readContract({
    address: vaultAddress,
    abi: czarVaultAbi,
    functionName: "factory",
  });
  if (isStopped()) return;
  unsubscribe.push(
    client.watchContractEvent({
      address: vaultAddress,
      abi: czarVaultAbi,
      eventName: "Frozen",
      pollingInterval,
      onLogs: (logs) => notifyListeners(logs, "Frozen", vaultAddress, listener),
    }),
    client.watchContractEvent({
      address: vaultAddress,
      abi: czarVaultAbi,
      eventName: "Unfrozen",
      pollingInterval,
      onLogs: (logs) => notifyListeners(logs, "Unfrozen", vaultAddress, listener),
    }),
    client.watchContractEvent({
      address: factory,
      abi: czarVaultFactoryAbi,
      eventName: "GuardianPaused",
      pollingInterval,
      onLogs: (logs) => notifyListeners(logs, "GuardianPaused", vaultAddress, listener),
    }),
    client.watchContractEvent({
      address: factory,
      abi: czarVaultFactoryAbi,
      eventName: "GuardianUnpaused",
      pollingInterval,
      onLogs: (logs) => notifyListeners(logs, "GuardianUnpaused", vaultAddress, listener),
    }),
  );
}

async function notifyListeners(
  logs: readonly { readonly eventName?: string }[],
  eventName: "Frozen" | "Unfrozen" | "GuardianPaused" | "GuardianUnpaused",
  vault: Address,
  listener: (event: VaultHaltEvent) => Promise<void>,
): Promise<void> {
  for (const log of logs) {
    if (log.eventName === eventName) await listener({ name: eventName, vault });
  }
}
