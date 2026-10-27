// T-026: revert data decoded to the custom-error names of ICzarVault and ICzarVaultFactory (03 czar-vault.md §9.2).
import { BaseError, ContractFunctionRevertedError, decodeErrorResult, type Hex } from "viem";
import { czarVaultAbi, czarVaultFactoryAbi } from "./abi.ts";

/** The vault and the factory share no selector, so one combined ABI decodes both. */
const ERRORS_ABI = [...czarVaultAbi, ...czarVaultFactoryAbi].filter(
  (item) => item.type === "error",
);

export type DecodedRevert =
  | { readonly kind: "custom"; readonly name: string; readonly args: readonly unknown[] }
  | { readonly kind: "string"; readonly name: "Error"; readonly message: string }
  | { readonly kind: "panic"; readonly name: "Panic"; readonly code: bigint }
  | { readonly kind: "empty"; readonly name: "EmptyRevert" }
  | { readonly kind: "unknown"; readonly name: "Unknown"; readonly data: Hex };

const ERROR_STRING_SELECTOR = "0x08c379a0";
const PANIC_SELECTOR = "0x4e487b71";
const SELECTOR_HEX_CHARS = 10;

/** Decodes raw revert data. Never throws: data that matches nothing comes back as `Unknown`. */
export function decodeRevert(data: Hex | undefined): DecodedRevert {
  if (data === undefined || data === "0x") return { kind: "empty", name: "EmptyRevert" };
  const selector = data.slice(0, SELECTOR_HEX_CHARS).toLowerCase();
  // viem also knows Error(string) and Panic(uint256); check those selectors first so they keep their own kinds.
  if (selector !== ERROR_STRING_SELECTOR && selector !== PANIC_SELECTOR) {
    try {
      const r = decodeErrorResult({ abi: ERRORS_ABI, data });
      return { kind: "custom", name: r.errorName, args: r.args ?? [] };
    } catch {
      return { kind: "unknown", name: "Unknown", data };
    }
  }
  try {
    if (selector === ERROR_STRING_SELECTOR) {
      const r = decodeErrorResult({ data });
      return { kind: "string", name: "Error", message: String(r.args?.[0] ?? "") };
    }
    if (selector === PANIC_SELECTOR) {
      const r = decodeErrorResult({ data });
      return { kind: "panic", name: "Panic", code: BigInt(r.args?.[0] as bigint) };
    }
  } catch {
    // malformed built-in error
  }
  return { kind: "unknown", name: "Unknown", data };
}

/** Finds the revert data inside an error viem threw (simulate, call or write) and decodes it. */
export function decodeViemError(error: unknown): DecodedRevert | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError) {
    if (reverted.raw !== undefined) return decodeRevert(reverted.raw);
  }
  const withData = error.walk((e) => typeof (e as { data?: unknown }).data === "string") as {
    data?: Hex;
  } | null;
  if (withData?.data !== undefined) return decodeRevert(withData.data);
  return undefined;
}

/** The names of every custom error the client decodes (vault and factory). */
export const errorNames = (): readonly string[] => ERRORS_ABI.map((e) => e.name);
