// Entry of the CZ-20 §5.11 test provider: its own process, never started by `local-main.ts` or the merchant
// runtime. `merchants.provider.enabled` defaults to true, so the provider runs only when this file is started on
// purpose (`pnpm --filter @czar/merchants start:provider`), and never on a mainnet.
//
// Phase 1 (N3): the server is local, so the provider runs on the same machine and reaches it on loopback. The
// RPC URL and the server port come from the same runtime variables the local merchant and server read; the
// signer socket path, the modes and the cadence come from `@czar/config`. No key material is read here.
import { readFile } from "node:fs/promises";
import { loadConfigFile, parameterEnvironment, validateLocalOnlyConfig } from "@czar/config";
import type { Address } from "@czar/hashing";
import { createLogger } from "@czar/logging";
import { createSignerClient } from "@czar/signer";
import { czarVaultFactoryAbi } from "@czar/vault-client";
import { createPublicClient, http } from "viem";
import { createRpcProviderChain } from "#src/provider/chain";
import { composeProviders } from "#src/provider/compose";
import { createHttpJobServer } from "#src/provider/server-client";

/** The local server's default port (`apps/server/src/local-main.ts`), overridden by `CZAR_SERVER_PORT`. */
const DEFAULT_SERVER_PORT = 3000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function requireAddress(value: unknown, label: string): Address {
  if (typeof value !== "string" || !ADDRESS.test(value))
    throw new Error(`deployment manifest has no valid ${label} address`);
  return value as Address;
}

export async function startTestProvider() {
  const localConfigPath =
    process.env["CZAR_LOCAL_CONFIG"] ?? new URL("../../../../env/local.toml", import.meta.url);
  const config = await loadConfigFile(localConfigPath, { env: parameterEnvironment(process.env) });
  const rpcUrl =
    process.env["CZAR_ARC_RPC_URL"] ?? `http://127.0.0.1:${config.get("signer.local.rpcPort")}`;
  await validateLocalOnlyConfig({ config, overlayPath: localConfigPath, arcRpcUrl: rpcUrl });
  const logger = createLogger({ service: "merchants", component: "CZ-20" });

  const manifestPath =
    process.env["CZAR_PROVIDER_DEPLOYMENT_PATH"] ??
    new URL("../../../../deployments/arc-local.json", import.meta.url);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  const client = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await client.getChainId();
  if (manifest["chainId"] !== chainId) throw new Error("deployment and RPC chain ids differ");
  const escrow = requireAddress(manifest["jobEscrow"], "jobEscrow");
  const factory = requireAddress(manifest["CzarVaultFactory"], "CzarVaultFactory");
  // K7 is the factory's default evaluator: the one evaluator an instance works for.
  const defaults = await client.readContract({
    address: factory,
    abi: czarVaultFactoryAbi,
    functionName: "defaults",
  });

  const signer = await createSignerClient({
    socketPath: String(config.get("signer.socketPath")),
    service: "merchants",
  });
  const serverPort = Number(process.env["CZAR_SERVER_PORT"] ?? DEFAULT_SERVER_PORT);
  if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65_535)
    throw new RangeError("CZAR_SERVER_PORT must be an integer from 1 to 65535.");
  const { instances } = composeProviders({
    config,
    chainId,
    evaluator: defaults.evaluator,
    signer,
    chain: createRpcProviderChain({ client, escrow }),
    server: createHttpJobServer({ baseUrl: `http://127.0.0.1:${serverPort}` }),
    logger,
  });
  if (instances.length === 0) {
    logger.warn("provider_disabled", { chainId, state: "off" });
    return { stop: async () => undefined };
  }
  for (const instance of instances) {
    try {
      await instance.start();
    } catch (error) {
      // CZ-27's `keyAddress` row (SCR-129) does not yet name K21a/K21b, so the signer answers `key-not-allowed`
      // and the instance cannot learn its own address. Fail closed rather than guess one (PM-046 spec problem).
      throw new Error("provider_key_address_unavailable", { cause: error });
    }
  }
  const running = instances.map((instance) => instance.run());
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      for (const instance of instances) instance.stop();
      await Promise.all(running);
    })();
    return stopping;
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  return { stop };
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1])) {
  await startTestProvider();
}
