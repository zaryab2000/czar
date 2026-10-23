import type { Config } from "@czar/config";
import { loadConfig } from "@czar/config";
import type { SignerNetwork } from "./policy.ts";
import { assertNoSecretInProcess, keychainPassphrase, type KeychainOpen } from "./passphrase.ts";
import { gitProbe, guardKeystorePath, nodeKeystoreFs, openLocalKeystore } from "./local-backend.ts";
import { startGasRefillJob, type GasRefillOptions } from "./gas-refill.ts";
import { postgresAudit, type AuditQueryExecutor } from "./postgres-audit.ts";
import type { Projection } from "./projection.ts";
import { createSigner, type Signer, type TransactionPreparer } from "./service.ts";
import { keychainSignerIdentity, startSignerSocket } from "./socket.ts";
import type { KeyId } from "./kinds.ts";

export interface SignerProcessOptions {
  readonly config?: Config;
  readonly projection: Projection;
  readonly network: SignerNetwork;
  readonly callers: Readonly<Record<string, readonly KeyId[]>>;
  readonly prepareTransaction: TransactionPreparer;
  readonly auditExecutor: AuditQueryExecutor;
  readonly refill: Omit<GasRefillOptions, "config" | "signer" | "keyAddress">;
  readonly allowedCallers: Readonly<Record<string, readonly string[]>>;
  readonly keychainOpen?: KeychainOpen;
  readonly argv?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface RunningSignerProcess {
  readonly signer: Signer;
  stop(): Promise<void>;
}

/** Opens the local keystore and runs the authenticated Unix-socket signer process. */
export async function startSignerProcess(
  options: SignerProcessOptions,
): Promise<RunningSignerProcess> {
  assertNoSecretInProcess(options.argv, options.env);
  const config =
    options.config ?? loadConfig(options.env === undefined ? {} : { env: options.env });
  if (config.get("signer.backend") !== "local-keystore")
    throw new Error("signer process requires signer.backend=local-keystore");
  const keychainService = String(config.get("signer.keychainService"));
  const keyStorePath = String(config.get("signer.keystorePath"));
  await guardKeystorePath(keyStorePath, { fs: nodeKeystoreFs, git: gitProbe });
  const backend = await openLocalKeystore({
    path: keyStorePath,
    passphrase: keychainPassphrase(keychainService, options.keychainOpen),
  });
  const audit = postgresAudit(options.auditExecutor);
  const signer = createSigner({
    backend,
    projection: options.projection,
    network: options.network,
    config,
    audit,
    callers: options.callers,
    prepareTransaction: options.prepareTransaction,
  });
  const identity = keychainSignerIdentity(keychainService, options.keychainOpen);
  const stopSocket = await startSignerSocket({
    socketPath: String(config.get("signer.socketPath")),
    signer,
    audit,
    identity,
    allowedCallers: options.allowedCallers,
  });
  const stopRefill = startGasRefillJob(
    {
      ...options.refill,
      config,
      signer,
      keyAddress: (key) => {
        const address = backend.address(key);
        if (address === undefined) throw new Error(`local keystore has no ${key} key`);
        return address;
      },
    },
    () => {
      process.emitWarning("signer gas refill job failed; inspect the configured alert sink");
    },
  );
  return {
    signer,
    async stop() {
      stopRefill();
      await stopSocket();
    },
  };
}
