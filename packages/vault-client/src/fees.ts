// T-026: the gas price floor every Czar transaction on Arc uses (p1-A6: maxFeePerGas ≥ 20 Gwei).
import { parseGwei } from "viem";

export const MIN_MAX_FEE_PER_GAS = parseGwei("20");

/** Raises `maxFeePerGas` (and caps `maxPriorityFeePerGas` at it) so a transaction never goes out below the floor. */
export function withFeeFloor<T extends { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }>(
  fees: T,
): T {
  const maxFeePerGas =
    fees.maxFeePerGas === undefined || fees.maxFeePerGas < MIN_MAX_FEE_PER_GAS
      ? MIN_MAX_FEE_PER_GAS
      : fees.maxFeePerGas;
  const priority = fees.maxPriorityFeePerGas;
  return {
    ...fees,
    maxFeePerGas,
    ...(priority === undefined
      ? {}
      : { maxPriorityFeePerGas: priority > maxFeePerGas ? maxFeePerGas : priority }),
  };
}
