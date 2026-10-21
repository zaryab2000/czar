#!/usr/bin/env node
import process from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@czar/config";
import {
  assertNoSecretInProcess,
  gitProbe,
  guardKeystorePath,
  keychainPassphrase,
  nodeKeystoreFs,
  openLocalKeystore,
} from "../src/index.ts";

const SERVICE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Add one merchant payout key per configured merchant service; print addresses only. */
export async function createMerchantKeys(
  services: readonly string[],
  options: {
    readonly argv?: readonly string[];
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly out?: (line: string) => void;
  } = {},
): Promise<Readonly<Record<string, string>>> {
  const env = options.env ?? process.env;
  assertNoSecretInProcess(options.argv ?? process.argv, env);
  if (services.length === 0 || services.some((service) => !SERVICE_ID.test(service))) {
    throw new Error("provide one or more kebab-case merchant service ids");
  }
  if (new Set(services).size !== services.length) {
    throw new Error("merchant service ids must be unique");
  }
  const config = loadConfig({ env });
  if (config.get("signer.backend") !== "local-keystore") {
    throw new Error("signer.backend must be local-keystore to create merchant keys");
  }
  const path = String(config.get("signer.keystorePath"));
  await guardKeystorePath(path, { fs: nodeKeystoreFs, git: gitProbe });
  const backend = await openLocalKeystore({
    path,
    passphrase: keychainPassphrase(String(config.get("signer.keychainService"))),
  });
  for (const service of services) {
    if (backend.address(`K10:${service}`) !== undefined) {
      throw new Error(`merchant key K10:${service} already exists`);
    }
  }
  const addresses: Record<string, string> = {};
  for (const service of services) {
    const key = await backend.createKey("K10", service);
    addresses[service] = key.address;
  }
  const out = options.out ?? ((line) => process.stdout.write(`${line}\n`));
  for (const [service, address] of Object.entries(addresses)) out(`K10:${service} ${address}`);
  return addresses;
}

function requestedServices(argv: readonly string[]): string[] {
  const services: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--service" && argv[index + 1] !== undefined) {
      services.push(argv[index + 1] as string);
      index += 1;
    }
  }
  return services;
}

const entrypoint = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === entrypoint) {
  void createMerchantKeys(requestedServices(process.argv.slice(2))).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
