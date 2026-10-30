// SCR-157 §3 (BF-4): the onboarding reads and the VaultExists check the web app makes through the client.
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  zeroAddress,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";
import {
  czarVaultAbi,
  czarVaultFactoryAbi,
  isVaultExistsError,
  readVaultOf,
  readVaultPasskey,
} from "@czar/vault-client";

const FACTORY = "0x00000000000000000000000000000000000000f1" as const;
const VAULT = "0x00000000000000000000000000000000000000a1" as const;
const MSCA = "0x00000000000000000000000000000000000000b1" as const;
const CHAIN = {
  id: 5042002,
  name: "Arc local",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
} as const;
const VAULT_EXISTS = encodeErrorResult({ abi: czarVaultFactoryAbi, errorName: "VaultExists" });

function chain(answer: (to: string, data: Hex) => Hex) {
  const calls: { to: string; data: Hex }[] = [];
  const client = createPublicClient({
    chain: CHAIN,
    transport: custom({
      request: async ({ method, params }) => {
        if (method !== "eth_call") throw new Error(`unexpected ${method}`);
        const [call] = params as [{ to: string; data: Hex }];
        calls.push(call);
        return answer(call.to, call.data);
      },
    }),
  });
  return { client, calls };
}

describe("readVaultOf", () => {
  it("returns the factory's vault for an owner account, or the zero address", async () => {
    for (const vault of [VAULT, zeroAddress]) {
      const { client, calls } = chain((_to, data) => {
        const call = decodeFunctionData({ abi: czarVaultFactoryAbi, data });
        expect(call).toMatchObject({ functionName: "vaultOf", args: [MSCA] });
        return encodeFunctionResult({
          abi: czarVaultFactoryAbi,
          functionName: "vaultOf",
          result: vault,
        });
      });

      await expect(readVaultOf({ client, factory: FACTORY, ownerAccount: MSCA })).resolves.toBe(
        vault,
      );
      expect(calls[0]?.to.toLowerCase()).toBe(FACTORY);
    }
  });
});

describe("readVaultPasskey", () => {
  it("returns the vault's passkey coordinates, RP ID hash and set flag", async () => {
    const passkey = {
      qx: `0x${"11".repeat(32)}`,
      qy: `0x${"22".repeat(32)}`,
      rpIdHash: `0x${"33".repeat(32)}`,
      set: true,
    } as const;
    const { client, calls } = chain(() =>
      encodeFunctionResult({ abi: czarVaultAbi, functionName: "getPasskey", result: passkey }),
    );

    await expect(readVaultPasskey({ client, vault: VAULT })).resolves.toEqual(passkey);
    expect(calls[0]?.to.toLowerCase()).toBe(VAULT);
  });
});

describe("isVaultExistsError", () => {
  it("finds the VaultExists selector in revert data a bundler returns", () => {
    const rpc = Object.assign(new Error("UserOperation reverted during simulation"), {
      data: { revertData: VAULT_EXISTS },
    });
    expect(isVaultExistsError(new Error("The network is busy.", { cause: rpc }))).toBe(true);
  });

  it("finds the selector when the revert data only appears in a message", () => {
    const rpc = new Error(`execution reverted with reason: ${VAULT_EXISTS}`);
    expect(isVaultExistsError(new Error("busy", { cause: rpc }))).toBe(true);
  });

  it("finds the selector inside an account's wrapped revert bytes", () => {
    const wrapped = `0x${"deadbeef"}${"00".repeat(31)}20${"00".repeat(31)}04${VAULT_EXISTS.slice(2)}${"00".repeat(28)}`;
    expect(isVaultExistsError(Object.assign(new Error("reverted"), { data: wrapped }))).toBe(true);
  });

  it("does not match another revert, an error string or a plain error", () => {
    const other = encodeErrorResult({ abi: czarVaultFactoryAbi, errorName: "ZeroAddress" });
    expect(isVaultExistsError(Object.assign(new Error("reverted"), { data: other }))).toBe(false);
    expect(isVaultExistsError(new Error("VaultExists"))).toBe(false);
    expect(isVaultExistsError(new Error("insufficient funds"))).toBe(false);
    expect(isVaultExistsError("not an error")).toBe(false);
  });
});
