// SCR-146 §3.3 run 3 (T-124 on a local chain), with the SCR-150 Gateway doubles on a CLEAN arc-anvil node.
// The real `pollPocketBalance` reads the D92 stand-in's `/v1/balances` (chain-backed when the double is placed)
// and the on-chain `withdrawingBalance`, `withdrawalBlock` and pocket USDC. Gated like the signer local-chain
// suite: CZAR_LOCAL_CHAIN=1, pinned `arc-anvil` on PATH (or ARC_ANVIL), and the Foundry artifacts
// (`cd contracts && FOUNDRY_PROFILE=arc arc-forge build`; built here if absent).
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseAbi,
  type Address,
} from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleStandinRequest, type RpcCall } from "../../../ops/local/circle-standins/server.ts";
import {
  CANONICAL_GATEWAY_WALLET,
  placeGatewayDoubles,
} from "../../../ops/local/gateway-doubles.ts";
import {
  pollPocketBalance,
  type PocketBalanceRow,
  type PocketBalanceStore,
} from "../src/gateway-balances.ts";

const enabled = process.env["CZAR_LOCAL_CHAIN"] === "1";
const RPC_PORT = 18558;
const RPC = `http://127.0.0.1:${RPC_PORT}`;
const CHAIN_ID = 5042002;
const GATEWAY_DOMAIN = 26;
const USDC: Address = "0x3600000000000000000000000000000000000000";
const ONE_USDC = 1_000_000n;
// Anvil's default accounts: #0 deploys the doubles (their controller); #1 acts as a funded pocket key.
const FUNDER: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const POCKET: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
// A pocket address with no key and no balance, for the closed-pocket quiet period.
const CLOSED_POCKET: Address = "0x000000000000000000000000000000000000c105";
const VAULT: Address = "0x000000000000000000000000000000000000ca11";
const QUIET_MS = 60_000;
const API_MAX_AGE_MS = 120_000;
const TIMEOUT_MS = 5_000;
const CONTRACTS = fileURLToPath(new URL("../../../contracts/", import.meta.url));
const ARTIFACT = `${CONTRACTS}out/MockGatewayWallet.sol/MockGatewayWallet.json`;

const chain = {
  id: CHAIN_ID,
  name: "arc-anvil",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;
const transport = http(RPC);
const pub = createPublicClient({ chain, transport });
const testClient = createTestClient({ chain, transport, mode: "anvil" });
const usdcAbi = parseAbi([
  "function approve(address spender, uint256 value) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
]);
const walletAbi = parseAbi([
  "function deposit(address token, uint256 value)",
  "function depositFor(address token, address depositor, uint256 value)",
  "function initiateWithdrawal(address token, uint256 value)",
  "function withdraw(address token)",
]);

let anvil: ChildProcess | undefined;
let clock = Date.parse("2026-10-27T00:00:00.000Z");

const rpc: RpcCall = async (method, params) => {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error !== undefined) throw new Error(`RPC ${method} failed`);
  return body.result;
};

// The stand-in handler behind the poller's fetch, without an HTTP listener.
const standinFetch: typeof fetch = async (input, init) =>
  handleStandinRequest(new Request(input as string | URL, init), rpc, USDC);

function memoryStore(): PocketBalanceStore {
  const rows = new Map<string, PocketBalanceRow>();
  return {
    find: async (pocket) => {
      const row = rows.get(pocket.toLowerCase());
      return row ? { ...row } : null;
    },
    save: async (row) => {
      rows.set(row.pocket, { ...row });
    },
  };
}

function poll(store: PocketBalanceStore, pocket: Address, state: string) {
  return pollPocketBalance(
    {
      pocket,
      vault: VAULT,
      state,
      domain: GATEWAY_DOMAIN,
      gatewayWallet: CANONICAL_GATEWAY_WALLET as Address,
      usdc: USDC,
      apiBase: "http://127.0.0.1:4999",
      timeoutMs: TIMEOUT_MS,
      quietMs: QUIET_MS,
      apiMaxAgeMs: API_MAX_AGE_MS,
    },
    { fetch: standinFetch, chain: pub, store, now: () => clock },
  );
}

async function send(from: Address, functionName: string, args: readonly unknown[]): Promise<void> {
  const wallet = createWalletClient({ chain, transport, account: from });
  const isUsdc = functionName === "approve";
  const hash = await wallet.writeContract({
    address: isUsdc ? USDC : (CANONICAL_GATEWAY_WALLET as Address),
    abi: isUsdc ? usdcAbi : walletAbi,
    functionName: functionName as never,
    args: args as never,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe("success");
}

describe.skipIf(!enabled)(
  "run 3: pocket_balances on a CLEAN local chain (SCR-146, SCR-150)",
  () => {
    beforeAll(async () => {
      if (!existsSync(ARTIFACT)) {
        execFileSync(process.env["ARC_FORGE"] ?? "arc-forge", ["build"], {
          cwd: CONTRACTS,
          stdio: "ignore",
          env: { ...process.env, FOUNDRY_PROFILE: "arc" },
        });
      }
      anvil = spawn(
        process.env["ARC_ANVIL"] ?? "arc-anvil",
        ["--network", "arc", "--chain-id", String(CHAIN_ID), "--port", String(RPC_PORT)],
        { stdio: "ignore" },
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          await pub.getChainId();
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      await placeGatewayDoubles({ rpcUrl: RPC, usdc: USDC });
    }, 180_000);

    afterAll(() => {
      anvil?.kill("SIGTERM");
    });

    it("projects available, withdrawing and pocket USDC from the chain-backed stand-in", async () => {
      const store = memoryStore();
      await send(POCKET, "approve", [CANONICAL_GATEWAY_WALLET, 2n * ONE_USDC]);
      await send(POCKET, "deposit", [USDC, 2n * ONE_USDC]);
      const funded = await poll(store, POCKET, "Funded");
      expect(funded.apiError).toBe(false);
      expect(funded.chainError).toBe(false);
      expect(funded.row.gatewayAvailableAtomic).toBe((2n * ONE_USDC).toString());
      expect(funded.row.gatewayPendingBatchAtomic).toBe("0");
      expect(funded.row.gatewayWithdrawingAtomic).toBe("0");
      expect(funded.row.closedZeroSince).toBeNull();

      await send(POCKET, "initiateWithdrawal", [USDC, ONE_USDC]);
      const withdrawing = await poll(store, POCKET, "Funded");
      expect(withdrawing.row.gatewayAvailableAtomic).toBe(ONE_USDC.toString());
      expect(withdrawing.row.gatewayWithdrawingAtomic).toBe(ONE_USDC.toString());
      expect(withdrawing.row.withdrawalBlock).toBeGreaterThan(0n);

      const before = await pub.readContract({
        address: USDC,
        abi: usdcAbi,
        functionName: "balanceOf",
        args: [POCKET],
      });
      await testClient.mine({ blocks: 10 });
      await send(POCKET, "withdraw", [USDC]);
      const withdrawn = await poll(store, POCKET, "Funded");
      expect(withdrawn.row.gatewayWithdrawingAtomic).toBe("0");
      expect(withdrawn.row.withdrawalBlock).toBe(0n);
      expect(BigInt(withdrawn.row.pocketUsdcAtomic ?? "0")).toBeGreaterThan(before);
    });

    it("ends polling of a quiet closed pocket and resets the quiet period on a non-zero read", async () => {
      const store = memoryStore();
      const first = await poll(store, CLOSED_POCKET, "Closed");
      expect(first.row.closedZeroSince).not.toBeNull();
      expect(first.row.pollEndedAt).toBeNull();

      // A late deposit for the closed pocket resets the quiet period (SCR-141 §2).
      await send(FUNDER, "approve", [CANONICAL_GATEWAY_WALLET, ONE_USDC]);
      await send(FUNDER, "depositFor", [USDC, CLOSED_POCKET, ONE_USDC]);
      clock += QUIET_MS / 2;
      const late = await poll(store, CLOSED_POCKET, "Closed");
      expect(late.row.gatewayAvailableAtomic).toBe(ONE_USDC.toString());
      expect(late.row.closedZeroSince).toBeNull();
      expect(late.row.pollEndedAt).toBeNull();
    });

    it("records pollEndedAt once a closed pocket has read zero for the quiet period (SCR-142 §2)", async () => {
      const store = memoryStore();
      const empty: Address = "0x000000000000000000000000000000000000c106";
      const start = await poll(store, empty, "Closed");
      expect(start.row.closedZeroSince).not.toBeNull();
      clock += QUIET_MS;
      const ended = await poll(store, empty, "Closed");
      expect(ended.row.pollEndedAt).not.toBeNull();
      const endedAt = ended.row.pollEndedAt;
      clock += QUIET_MS;
      const after = await poll(store, empty, "Closed");
      expect(after.row.pollEndedAt).toBe(endedAt);
    });
  },
);
