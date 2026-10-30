// SCR-159 §4: vault setup sends setPasskey only after the bundler reports the createVault
// receipt. The wallet module is real; only the bundler, smart account and chain reads are fakes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  zeroAddress,
  type Hex,
} from "viem";
import { czarVaultAbi, czarVaultFactoryAbi } from "@czar/vault-client";

const mocks = vi.hoisted(() => ({
  getAppWalletConfig: vi.fn(),
  toCircleSmartAccount: vi.fn(),
  toModularTransport: vi.fn(),
  createBundlerClient: vi.fn(),
  walletPublicClient: vi.fn(),
}));

vi.mock("#src/app-api", () => ({ getAppWalletConfig: mocks.getAppWalletConfig }));
vi.mock("@circle-fin/modular-wallets-core", () => ({
  toCircleSmartAccount: mocks.toCircleSmartAccount,
  toModularTransport: mocks.toModularTransport,
}));
vi.mock("viem/account-abstraction", async (importOriginal) => ({
  ...(await importOriginal<typeof import("viem/account-abstraction")>()),
  createBundlerClient: mocks.createBundlerClient,
}));
vi.mock("#src/wallet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#src/wallet")>()),
  getStoredPasskey: () => PASSKEY,
  walletPublicClient: mocks.walletPublicClient,
}));

import { setUpVault } from "#src/vault-setup";

const FACTORY = "0x00000000000000000000000000000000000000f1" as const;
const MSCA = "0x00000000000000000000000000000000000000b1" as const;
const VAULT = "0x00000000000000000000000000000000000000a1" as const;
const PASSKEY = {
  credentialId: "credential-id",
  publicKey: `0x04${"11".repeat(32)}${"22".repeat(32)}`,
} as const;

const ZERO_WORD = `0x${"00".repeat(32)}` as const;

interface Receipt {
  readonly success: boolean;
  readonly reason?: Hex;
}

/** A bundler that logs each send and receipt and settles each receipt when the test says so. */
function scriptedBundler() {
  const events: string[] = [];
  const pending: { name: string; settle: (receipt: Receipt) => void }[] = [];
  let hashes = 0;
  const names = new Map<Hex, string>();
  const client = {
    sendUserOperation: vi.fn(async ({ calls }: { calls: { data: Hex }[] }) => {
      const name = decodeFunctionData({
        abi: [...czarVaultFactoryAbi, ...czarVaultAbi],
        data: calls[0]!.data,
      }).functionName;
      events.push(`send:${name}`);
      hashes += 1;
      const hash = `0x${hashes.toString(16).padStart(64, "0")}` as Hex;
      names.set(hash, name);
      return hash;
    }),
    waitForUserOperationReceipt: vi.fn(
      ({ hash }: { hash: Hex }) =>
        new Promise<Receipt>((resolve) => {
          const name = names.get(hash) ?? "unknown";
          pending.push({
            name,
            settle: (receipt) => {
              events.push(`receipt:${name}`);
              resolve(receipt);
            },
          });
        }),
    ),
  };
  return { client, events, pending };
}

/** A chain with no vault for the MSCA yet and no passkey on any vault. */
function chainWithoutVault() {
  return createPublicClient({
    transport: custom({
      request: async ({ method, params }) => {
        if (method !== "eth_call") throw new Error(`unexpected ${method}`);
        const [call] = params as [{ to: string }];
        if (call.to.toLowerCase() === FACTORY) {
          return encodeFunctionResult({
            abi: czarVaultFactoryAbi,
            functionName: "vaultOf",
            result: zeroAddress,
          });
        }
        return encodeFunctionResult({
          abi: czarVaultAbi,
          functionName: "getPasskey",
          result: { qx: ZERO_WORD, qy: ZERO_WORD, rpIdHash: ZERO_WORD, set: false },
        });
      },
    }),
  });
}

async function settled(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

beforeEach(() => {
  mocks.getAppWalletConfig.mockResolvedValue({
    circleClientUrl: "https://wallet.example.test",
    circleClientKey: "public-key",
    arcRpcUrl: "https://rpc.example.test",
    bundlerOrder: ["circle"],
    bundlerEndpoints: {},
    vaultFactory: FACTORY,
    webauthnRpId: "app.czar.example",
  });
  mocks.toCircleSmartAccount.mockResolvedValue({ address: MSCA });
  mocks.walletPublicClient.mockResolvedValue(chainWithoutVault());
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("setUpVault waits for inclusion (SCR-159 §4)", () => {
  it("never sends setPasskey before the createVault receipt exists", async () => {
    const bundler = scriptedBundler();
    mocks.createBundlerClient.mockReturnValue(bundler.client);

    const done = setUpVault({ msca: MSCA, vault: VAULT });
    await vi.waitFor(() => expect(bundler.pending).toHaveLength(1));
    await settled();
    expect(bundler.events).toEqual(["send:createVault"]);

    bundler.pending[0]!.settle({ success: true });
    await vi.waitFor(() => expect(bundler.pending).toHaveLength(2));
    bundler.pending[1]!.settle({ success: true });
    await done;

    expect(bundler.events).toEqual([
      "send:createVault",
      "receipt:createVault",
      "send:setPasskey",
      "receipt:setPasskey",
    ]);
  });

  it("surfaces a reverted createVault receipt as a clear error and sends no setPasskey", async () => {
    const bundler = scriptedBundler();
    mocks.createBundlerClient.mockReturnValue(bundler.client);

    const done = setUpVault({ msca: MSCA, vault: VAULT }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(bundler.pending).toHaveLength(1));
    bundler.pending[0]!.settle({ success: false });
    const failure = await done;

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/failed on-chain/);
    expect((failure as Error).message).not.toMatch(/network is busy/);
    expect(bundler.events).toEqual(["send:createVault", "receipt:createVault"]);
  });

  it("continues to setPasskey when the createVault receipt reverted with VaultExists", async () => {
    const bundler = scriptedBundler();
    mocks.createBundlerClient.mockReturnValue(bundler.client);

    const done = setUpVault({ msca: MSCA, vault: VAULT });
    await vi.waitFor(() => expect(bundler.pending).toHaveLength(1));
    bundler.pending[0]!.settle({
      success: false,
      reason: encodeErrorResult({ abi: czarVaultFactoryAbi, errorName: "VaultExists" }),
    });
    await vi.waitFor(() => expect(bundler.pending).toHaveLength(2));
    bundler.pending[1]!.settle({ success: true });
    await done;

    expect(bundler.events).toEqual([
      "send:createVault",
      "receipt:createVault",
      "send:setPasskey",
      "receipt:setPasskey",
    ]);
  });
});
