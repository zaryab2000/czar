import type { Amount6 } from "@czar/schemas";

const NATIVE_USDC_TO_AMOUNT6 = 1_000_000_000_000n;

/**
 * Native USDC is 18-decimal; CZ-19 §5.2 divides by 10^12 (A1-05). Integer division floors any
 * sub-Amount6 dust. Never throw here: anyone can send a vault or pocket a native transfer with
 * dust, and a throwing handler would halt indexing for every user.
 */
export function normalizeTransferAmount(emitter: "usdc" | "eip7708", value: bigint): Amount6 {
  if (emitter === "usdc") return value.toString();
  return (value / NATIVE_USDC_TO_AMOUNT6).toString();
}
