import type { Amount6 } from "@czar/schemas";

const NATIVE_USDC_TO_AMOUNT6 = 1_000_000_000_000n;

export function normalizeTransferAmount(emitter: "usdc" | "eip7708", value: bigint): Amount6 {
  if (emitter === "usdc") return value.toString();
  if (value % NATIVE_USDC_TO_AMOUNT6 !== 0n) {
    throw new Error("Native USDC transfer has sub-Amount6 precision.");
  }
  return (value / NATIVE_USDC_TO_AMOUNT6).toString();
}
