// SCR-157 §3 (BF-3, BF-4): vault onboarding reads the factory and RP ID from wallet-config and
// never sends a createVault or setPasskey the chain already has.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  sha256,
  stringToBytes,
  zeroAddress,
  type Hex,
} from "viem";
import { czarVaultAbi, czarVaultFactoryAbi } from "@czar/vault-client";

const mocks = vi.hoisted(() => ({
  getAppWalletConfig: vi.fn(),
  sendOwnerUserOperation: vi.fn(),
  walletPublicClient: vi.fn(),
}));

vi.mock("#src/app-api", () => ({ getAppWalletConfig: mocks.getAppWalletConfig }));
vi.mock("#src/wallet", () => ({
  getStoredPasskey: () => PASSKEY,
  sendOwnerUserOperation: mocks.sendOwnerUserOperation,
  walletPublicClient: mocks.walletPublicClient,
}));

import { canCreateVault, setUpVault } from "#src/vault-setup";

const FACTORY = "0x00000000000000000000000000000000000000f1" as const;
const MSCA = "0x00000000000000000000000000000000000000b1" as const;
const VAULT = "0x00000000000000000000000000000000000000a1" as const;
const RP_ID = "app.czar.example";
const QX = `0x${"11".repeat(32)}` as const;
const QY = `0x${"22".repeat(32)}` as const;
const PASSKEY = { credentialId: "credential-id", publicKey: `0x04${QX.slice(2)}${QY.slice(2)}` };
const RP_ID_HASH = sha256(stringToBytes(RP_ID));
const NO_PASSKEY = {
  qx: `0x${"00".repeat(32)}`,
  qy: `0x${"00".repeat(32)}`,
  rpIdHash: `0x${"00".repeat(32)}`,
  set: false,
} as const;

/** A chain whose factory answers `vaultOf` and whose vault answers `getPasskey`. */
function chainWith(state: {
  vaultOf: `0x${string}`;
  passkey?: { qx: Hex; qy: Hex; rpIdHash: Hex; set: boolean };
}) {
  return createPublicClient({
    transport: custom({
      request: async ({ method, params }) => {
        if (method === "eth_chainId") return "0x4cef52";
        if (method !== "eth_call") throw new Error(`unexpected ${method}`);
        const [call] = params as [{ to: string; data: Hex }];
        if (call.to.toLowerCase() === FACTORY) {
          decodeFunctionData({ abi: czarVaultFactoryAbi, data: call.data });
          return encodeFunctionResult({
            abi: czarVaultFactoryAbi,
            functionName: "vaultOf",
            result: state.vaultOf,
          });
        }
        return encodeFunctionResult({
          abi: czarVaultAbi,
          functionName: "getPasskey",
          result: state.passkey ?? NO_PASSKEY,
        });
      },
    }),
  });
}

function sentFunctions(): { to: string; functionName: string }[] {
  return mocks.sendOwnerUserOperation.mock.calls.map(([, to, data]) => ({
    to: (to as string).toLowerCase(),
    functionName: decodeFunctionData({
      abi: [...czarVaultFactoryAbi, ...czarVaultAbi],
      data: data as Hex,
    }).functionName,
  }));
}

beforeEach(() => {
  mocks.getAppWalletConfig.mockResolvedValue({
    circleClientUrl: "https://wallet.example.test",
    circleClientKey: "public-key",
    arcRpcUrl: "https://rpc.example.test",
    bundlerOrder: ["circle"],
    bundlerEndpoints: {},
    vaultFactory: FACTORY,
    webauthnRpId: RP_ID,
  });
  mocks.sendOwnerUserOperation.mockResolvedValue({
    userOpHash: `0x${"ab".repeat(32)}`,
    bundler: "circle",
  });
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("setUpVault", () => {
  it("creates the vault at the wallet-config factory, then sets the passkey with that RP ID", async () => {
    mocks.walletPublicClient.mockResolvedValue(chainWith({ vaultOf: zeroAddress }));

    await setUpVault({ msca: MSCA, vault: VAULT });

    expect(sentFunctions()).toEqual([
      { to: FACTORY, functionName: "createVault" },
      { to: VAULT, functionName: "setPasskey" },
    ]);
    const setPasskey = decodeFunctionData({
      abi: czarVaultAbi,
      data: mocks.sendOwnerUserOperation.mock.calls[1]?.[2] as Hex,
    });
    expect(setPasskey.args).toEqual([QX, QY, RP_ID_HASH]);
  });

  it("sends no operation on a second Create vault once the vault and passkey exist", async () => {
    mocks.walletPublicClient.mockResolvedValue(
      chainWith({ vaultOf: VAULT, passkey: { qx: QX, qy: QY, rpIdHash: RP_ID_HASH, set: true } }),
    );

    await setUpVault({ msca: MSCA, vault: VAULT });

    expect(mocks.sendOwnerUserOperation).not.toHaveBeenCalled();
  });

  it("skips createVault but sets the passkey when the vault exists without it", async () => {
    mocks.walletPublicClient.mockResolvedValue(chainWith({ vaultOf: VAULT }));

    await setUpVault({ msca: MSCA, vault: VAULT });

    expect(sentFunctions()).toEqual([{ to: VAULT, functionName: "setPasskey" }]);
  });

  it("sets the passkey again when the vault holds a different RP ID hash", async () => {
    mocks.walletPublicClient.mockResolvedValue(
      chainWith({
        vaultOf: VAULT,
        passkey: { qx: QX, qy: QY, rpIdHash: sha256(stringToBytes("localhost")), set: true },
      }),
    );

    await setUpVault({ msca: MSCA, vault: VAULT });

    expect(sentFunctions()).toEqual([{ to: VAULT, functionName: "setPasskey" }]);
  });

  it("treats a VaultExists revert from the bundler as success and continues", async () => {
    mocks.walletPublicClient.mockResolvedValue(chainWith({ vaultOf: zeroAddress }));
    const vaultExists = encodeErrorResult({ abi: czarVaultFactoryAbi, errorName: "VaultExists" });
    mocks.sendOwnerUserOperation.mockRejectedValueOnce(
      new Error("The network is busy. Your approval was not sent. Try again in a minute.", {
        cause: Object.assign(new Error("UserOperation reverted"), { data: vaultExists }),
      }),
    );

    await setUpVault({ msca: MSCA, vault: VAULT });

    expect(sentFunctions().map(({ functionName }) => functionName)).toEqual([
      "createVault",
      "setPasskey",
    ]);
  });

  it("stops on any other createVault failure", async () => {
    mocks.walletPublicClient.mockResolvedValue(chainWith({ vaultOf: zeroAddress }));
    mocks.sendOwnerUserOperation.mockRejectedValueOnce(new Error("AA21 didn't pay prefund"));

    await expect(setUpVault({ msca: MSCA, vault: VAULT })).rejects.toThrow("AA21");
    expect(mocks.sendOwnerUserOperation).toHaveBeenCalledTimes(1);
  });
});

describe("canCreateVault", () => {
  it("is false only when the MSCA holds no network fees", () => {
    expect(canCreateVault({ balances: { mscaBalance: "0" } })).toBe(false);
    expect(canCreateVault({ balances: { mscaBalance: "1" } })).toBe(true);
  });
});

describe("web app sources (SCR-157 §3)", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const sources = ["app", "packages"].flatMap((directory) =>
    readdirSync(join(root, directory), { recursive: true })
      .map((name) => join(directory, name.toString()))
      .filter((name) => /\.tsx?$/.test(name) && !name.endsWith(".test.ts")),
  );
  const read = (name: string) => readFileSync(join(root, name), "utf8");

  it("the vault onboarding page holds no literal address, factory variable or RP ID", () => {
    const page = read("app/onboarding/vault/page.tsx");
    expect(page).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(page).not.toContain("NEXT_PUBLIC_CZAR_VAULT_FACTORY_ADDRESS");
    expect(page).not.toContain('"localhost"');
  });

  it("no app source names a vault factory or uses localhost as an RP ID", () => {
    expect(sources.length).toBeGreaterThan(10);
    for (const name of sources) {
      const text = read(name);
      expect(text, name).not.toContain("NEXT_PUBLIC_CZAR_VAULT_FACTORY_ADDRESS");
      expect(text, name).not.toMatch(/0xA624047E961D13bF49711e1383e7A3EBD3E25ef4/i);
      expect(text, name).not.toContain('"localhost"');
    }
  });
});
