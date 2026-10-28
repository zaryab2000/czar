// SCR-146 §3.3 runs 4–5: a CLEAN pinned `arc-anvil --network arc` chain with the Czar contracts deployed by
// `contracts/script/deploy.sh` and the SCR-150 Gateway doubles placed at Circle's canonical addresses.
// Test-only.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { placeGatewayDoubles } from "../../../../ops/local/gateway-doubles.ts";

export const ARC_CHAIN_ID = 5_042_002;
export const ARC_USDC: Address = "0x3600000000000000000000000000000000000000";
export const GATEWAY_WALLET: Address = "0x0077777d7eba4688bdef3e311b846f25870a19b9";
export const GATEWAY_MINTER: Address = "0x0022222abe238cc2c7bb1f21003f0a260052475b";
export const GATEWAY_DOMAIN = 26;
/** Anvil's first unlocked account: deploys the contracts and is the Gateway doubles' controller. */
export const ANVIL_DEPLOYER: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const POLLING_MS = 50;
const RPC_START_ATTEMPTS = 200;
const RPC_START_RETRY_MS = 50;
const ROOT = new URL("../../../../", import.meta.url);
const CONTRACTS = fileURLToPath(new URL("contracts/", ROOT));
const DEPLOYMENTS = fileURLToPath(new URL("deployments/", ROOT));
const DOUBLE_ARTIFACT = `${CONTRACTS}out/MockGatewayWallet.sol/MockGatewayWallet.json`;

export type ArcChainDefinition = ReturnType<typeof arcChain>;

export function arcChain(rpcUrl: string) {
  return {
    id: ARC_CHAIN_ID,
    name: "arc-anvil",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  } as const;
}

export interface ArcChain {
  readonly rpcUrl: string;
  readonly chain: ArcChainDefinition;
  readonly reader: PublicClient;
  /** Wallet client without an account: the slow-path adapter broadcasts signed transactions through it. */
  readonly wallet: WalletClient;
  readonly testClient: ReturnType<typeof createTestClient>;
  readonly factory: Address;
  rpc(method: string, params: readonly unknown[]): Promise<unknown>;
  mine(blocks: number): Promise<void>;
  stop(): void;
}

export interface ArcChainOptions {
  readonly port: number;
  /** Addresses only (`K3`, `K5`, `K6`, `K7`, `K20`); never key material. */
  readonly keyAddresses: Readonly<Record<"K3" | "K5" | "K6" | "K7" | "K20", Address>>;
}

export async function startArcChain(options: ArcChainOptions): Promise<ArcChain> {
  if (!existsSync(DOUBLE_ARTIFACT))
    execFileSync(process.env["ARC_FORGE"] ?? "arc-forge", ["build"], {
      cwd: CONTRACTS,
      stdio: "ignore",
      env: { ...process.env, FOUNDRY_PROFILE: "arc" },
    });
  const rpcUrl = `http://127.0.0.1:${options.port}`;
  const chain = arcChain(rpcUrl);
  const node = spawn(
    process.env["ARC_ANVIL"] ?? "arc-anvil",
    ["--network", "arc", "--chain-id", String(ARC_CHAIN_ID), "--port", String(options.port)],
    { stdio: "ignore" },
  );
  try {
    const reader = createPublicClient({
      chain,
      transport: http(rpcUrl),
      pollingInterval: POLLING_MS,
    });
    await waitForRpc(reader);
    const rpc = jsonRpc(rpcUrl);
    const factory = deployCzar(rpcUrl, options.port, options.keyAddresses);
    await placeGatewayDoubles({ rpcUrl });
    const wallet = createWalletClient({
      chain,
      transport: http(rpcUrl),
      pollingInterval: POLLING_MS,
    });
    const testClient = createTestClient({ chain, transport: http(rpcUrl), mode: "anvil" });
    return {
      rpcUrl,
      chain,
      reader,
      wallet,
      testClient,
      factory,
      rpc,
      async mine(blocks) {
        await rpc("anvil_mine", [`0x${blocks.toString(16)}`]);
      },
      stop: () => node.kill(),
    };
  } catch (error) {
    node.kill();
    throw error;
  }
}

/** A wallet client on the plain transport, for owner, guardian and funder transactions. */
export function walletFor(chain: ArcChain, account: PrivateKeyAccount) {
  return createWalletClient({ chain: chain.chain, transport: http(chain.rpcUrl), account });
}

function deployCzar(
  rpcUrl: string,
  port: number,
  keyAddresses: ArcChainOptions["keyAddresses"],
): Address {
  const keysName = `.local-pocket-${port}-key-addresses.json`;
  const outName = `.local-pocket-${port}-deployment.json`;
  const keys = Object.fromEntries(
    Object.entries(keyAddresses).map(([name, address]) => [
      name,
      { address, ref: `local-pocket-${name}` },
    ]),
  );
  writeFileSync(`${DEPLOYMENTS}${keysName}`, `${JSON.stringify(keys)}\n`, { mode: 0o600 });
  try {
    execFileSync(
      "bash",
      [
        "script/deploy.sh",
        rpcUrl,
        `../deployments/${keysName}`,
        `../deployments/${outName}`,
        "--offline",
        "--broadcast",
        "--unlocked",
        "--sender",
        ANVIL_DEPLOYER,
      ],
      {
        cwd: CONTRACTS,
        stdio: "ignore",
        env: { ...process.env, ARC_FORGE: process.env["ARC_FORGE"] ?? "arc-forge" },
      },
    );
    const output = JSON.parse(readFileSync(`${DEPLOYMENTS}${outName}`, "utf8")) as {
      readonly CzarVaultFactory: Address;
    };
    return output.CzarVaultFactory;
  } finally {
    rmSync(`${DEPLOYMENTS}${keysName}`, { force: true });
    rmSync(`${DEPLOYMENTS}${outName}`, { force: true });
  }
}

function jsonRpc(rpcUrl: string) {
  let id = 0;
  return async (method: string, params: readonly unknown[]): Promise<unknown> => {
    id += 1;
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const body = (await response.json()) as {
      result?: unknown;
      error?: { code?: number; message?: string; data?: unknown };
    };
    if (body.error) {
      const error = new Error(body.error.message ?? `Arc Anvil RPC ${method} failed.`);
      Object.assign(error, { code: body.error.code, data: body.error.data });
      throw error;
    }
    return body.result;
  };
}

async function waitForRpc(client: PublicClient): Promise<void> {
  for (let attempt = 0; attempt < RPC_START_ATTEMPTS; attempt += 1) {
    try {
      await client.getChainId();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, RPC_START_RETRY_MS));
    }
  }
  throw new Error("Pinned arc-anvil did not start on the local pocket test port.");
}
