// SCR-146 §3.3 runs 4–5: a CLEAN pinned `arc-anvil --network arc` chain with the Czar contracts deployed by
// `contracts/script/deploy.sh` and the SCR-150 Gateway doubles placed at Circle's canonical addresses.
// Test-only. Every transaction the payer broadcasts goes through `crashTransport`, so a test can kill the
// payer exactly before a chosen transaction is sent or right after it is mined.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  custom,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionSerialized,
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
/** `0x` plus the four-byte function selector. */
const SELECTOR_HEX_LENGTH = 10;
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

/** A raw transaction the payer is about to broadcast, decoded for crash-point matching. */
export interface OutgoingTransaction {
  readonly from: Address;
  readonly to: Address | null;
  readonly selector: Hex | null;
}

export class InjectedCrash extends Error {
  constructor(point: string) {
    super(`injected crash: ${point}`);
    this.name = "InjectedCrash";
  }
}

/**
 * One armed point; it fires once, for the first matching transaction. `before-send`: the payer dies before the
 * transaction reaches the node. `after-mined`: right after it is mined. `around-send`: the test sends the
 * transaction itself through `forward`, so it can order other transactions into the same block.
 */
export type CrashPoint =
  | {
      readonly name: string;
      readonly when: "before-send" | "after-mined";
      readonly match: (transaction: OutgoingTransaction) => boolean;
    }
  | {
      readonly name: string;
      readonly when: "around-send";
      readonly match: (transaction: OutgoingTransaction) => boolean;
      around(forward: () => Promise<Hex>): Promise<Hex>;
    };

export interface CrashSwitch {
  arm(point: CrashPoint): void;
  readonly fired: readonly string[];
}

export interface ArcChain {
  readonly rpcUrl: string;
  readonly chain: ArcChainDefinition;
  /** Plain client for setup and assertions; never crashes. */
  readonly reader: PublicClient;
  /** The payer's client: `eth_sendRawTransaction` honours the armed crash point. */
  readonly payerClient: PublicClient;
  /** Wallet client on the same crash-aware transport (the slow-path adapter broadcasts through it). */
  readonly payerWallet: WalletClient;
  readonly crash: CrashSwitch;
  readonly testClient: ReturnType<typeof createTestClient>;
  readonly factory: Address;
  rpc(method: string, params: readonly unknown[]): Promise<unknown>;
  mine(blocks: number): Promise<void>;
  /** Advances chain time with `evm_increaseTime` and mines one block. */
  increaseTime(seconds: number): Promise<void>;
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
    const crash = createCrashSwitch();
    const transport = crashTransport(rpc, crash);
    const payerClient = createPublicClient({ chain, transport, pollingInterval: POLLING_MS });
    const payerWallet = createWalletClient({ chain, transport, pollingInterval: POLLING_MS });
    const testClient = createTestClient({ chain, transport: http(rpcUrl), mode: "anvil" });
    return {
      rpcUrl,
      chain,
      reader,
      payerClient,
      payerWallet,
      crash,
      testClient,
      factory,
      rpc,
      async mine(blocks) {
        await rpc("anvil_mine", [`0x${blocks.toString(16)}`]);
      },
      async increaseTime(seconds) {
        await rpc("evm_increaseTime", [seconds]);
        await rpc("evm_mine", []);
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

function createCrashSwitch(): CrashSwitch & {
  take(transaction: OutgoingTransaction, when: CrashPoint["when"]): CrashPoint | null;
} {
  let armed: CrashPoint | null = null;
  const fired: string[] = [];
  return {
    fired,
    arm(point) {
      armed = point;
    },
    take(transaction, when) {
      if (!armed || armed.when !== when || !armed.match(transaction)) return null;
      const point = armed;
      armed = null;
      fired.push(point.name);
      return point;
    },
  };
}

function crashTransport(
  rpc: (method: string, params: readonly unknown[]) => Promise<unknown>,
  crash: ReturnType<typeof createCrashSwitch>,
) {
  return custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      const list = (Array.isArray(params) ? params : []) as readonly unknown[];
      if (method !== "eth_sendRawTransaction") return rpc(method, list);
      const raw = list[0] as TransactionSerialized;
      const outgoing = await decodeOutgoing(raw);
      const before = crash.take(outgoing, "before-send");
      if (before) throw new InjectedCrash(before.name);
      const around = crash.take(outgoing, "around-send");
      if (around?.when === "around-send")
        return around.around(async () => (await rpc(method, list)) as Hex);
      const hash = (await rpc(method, list)) as Hex;
      const after = crash.take(outgoing, "after-mined");
      if (after) {
        await waitForReceipt(rpc, hash);
        throw new InjectedCrash(after.name);
      }
      return hash;
    },
  });
}

async function decodeOutgoing(raw: TransactionSerialized): Promise<OutgoingTransaction> {
  const parsed = parseTransaction(raw);
  const data = (parsed.data ?? "0x") as Hex;
  return {
    from: await recoverTransactionAddress({ serializedTransaction: raw }),
    to: parsed.to ?? null,
    selector:
      data.length >= SELECTOR_HEX_LENGTH ? (data.slice(0, SELECTOR_HEX_LENGTH) as Hex) : null,
  };
}

async function waitForReceipt(
  rpc: (method: string, params: readonly unknown[]) => Promise<unknown>,
  hash: Hex,
): Promise<void> {
  for (let attempt = 0; attempt < RPC_START_ATTEMPTS; attempt += 1) {
    if (await rpc("eth_getTransactionReceipt", [hash])) return;
    await new Promise((resolve) => setTimeout(resolve, RPC_START_RETRY_MS));
  }
  throw new Error(`Crash-point transaction ${hash} was not mined.`);
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
