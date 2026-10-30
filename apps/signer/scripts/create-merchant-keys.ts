#!/usr/bin/env node
import process from "node:process";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
    readonly local?: boolean;
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
  const local = options.local ?? false;
  const localManifestPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../deployments/local-keys.json",
  );
  const localManifest = local ? await readLocalManifest(localManifestPath) : undefined;
  if (localManifest !== undefined) {
    for (const service of services) {
      if (`K10:${service}` in localManifest.manifest) {
        throw new Error(`local key manifest already has K10:${service}`);
      }
    }
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
  if (localManifest !== undefined) {
    await writeLocalManifest(localManifestPath, localManifest, addresses);
  }
  const out = options.out ?? ((line) => process.stdout.write(`${line}\n`));
  for (const [service, address] of Object.entries(addresses)) {
    out(`K10:${service} ${local ? truncateAddress(address) : address}`);
  }
  return addresses;
}

export async function readLocalManifest(path: string) {
  const parserPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../ops/local/parse-local-keys.mjs",
  );
  const { addMerchantKeysToLocalManifest, parseLocalKeysManifest } = await import(
    pathToFileURL(parserPath).href
  );
  const manifest = parseLocalKeysManifest(JSON.parse(await readFile(path, "utf8")));
  return { addMerchantKeysToLocalManifest, manifest, parseLocalKeysManifest };
}

export async function writeLocalManifest(
  path: string,
  localManifest: Awaited<ReturnType<typeof readLocalManifest>>,
  addresses: Readonly<Record<string, string>>,
) {
  const release = await acquireLocalManifestLock(path);
  try {
    const currentManifest = localManifest.parseLocalKeysManifest(
      JSON.parse(await readFile(path, "utf8")),
    );
    const updated = localManifest.addMerchantKeysToLocalManifest(currentManifest, addresses);
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, path);
    } catch (error) {
      throw new Error(
        `could not update local key manifest at ${path}; preserve generated K10 keys and inspect ${temporary}`,
        {
          cause: error,
        },
      );
    }
  } finally {
    await release();
  }
}

async function acquireLocalManifestLock(path: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      return async () => unlink(lockPath);
    } catch (error) {
      if (!isFileExistsError(error)) {
        throw new Error(`could not lock local key manifest at ${path}`, { cause: error });
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for local key manifest lock ${lockPath}`, {
          cause: error,
        });
      }
      await delay(20);
    }
  }
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
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

function isLocal(argv: readonly string[]): boolean {
  return argv.includes("--local");
}

const entrypoint = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === entrypoint) {
  const args = process.argv.slice(2);
  void createMerchantKeys(requestedServices(args), { local: isLocal(args) }).catch(
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    },
  );
}
