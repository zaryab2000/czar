import type { Config } from "@czar/config";
import type { Address } from "@czar/hashing";
import { createLogger, type Logger } from "@czar/logging";
import type { Hex } from "viem";
import type { GasLowKey, SignerMetrics } from "./metrics.ts";
import { NATIVE_PER_USDC_ATOMIC } from "./policy.ts";
import type { SignResult } from "./service.ts";

type RefillKey = Exclude<GasLowKey, "relayer">;

export interface GasRefillResult {
  readonly key: RefillKey;
  /** Native wei: the balance read at the refill receipt's block when a refill was mined. */
  readonly balance: bigint;
  readonly status: "unchanged" | "refilled" | "failed";
}

export interface GasRefillOptions {
  readonly config: Config;
  readonly signer: {
    sign(
      caller: string,
      request: {
        keyId: string;
        kind: string;
        payload: unknown;
      },
    ): Promise<SignResult>;
    abandonTransaction(keyRef: string, signedTransaction: Hex): Promise<void>;
  };
  readonly keyAddress: (key: GasLowKey) => Address;
  /** Reads the latest balance, or the balance at `blockNumber` when given. */
  readonly getNativeBalance: (address: Address, blockNumber?: bigint) => Promise<bigint>;
  /** Sends a signed refill and resolves with the block of its successful receipt. */
  readonly submitTransaction: (transaction: Hex) => Promise<{ readonly blockNumber: bigint }>;
  readonly alert: (message: string) => Promise<void>;
  readonly metrics: SignerMetrics;
  readonly logger?: Pick<Logger, "error">;
}

/** The chain reads and writes a refill pass needs; the signer process supplies the rest. */
export type GasRefillChainAdapters = Pick<
  GasRefillOptions,
  "getNativeBalance" | "submitTransaction"
>;

const REFILL_KEYS: readonly RefillKey[] = ["K3", "K7", "K8"];
const MS_PER_SECOND = 1000;

/** Where a key's refill stopped. */
type RefillFault = "key-unavailable" | "balance-read-failed" | "sign-failed" | "send-failed";
/** The only detail a gas-low alert carries besides the key id (SCR-157 §2). */
type GasLowReason = RefillFault | "below-min-after-refill" | "below-target-sum";

/**
 * Refill low-balance signer keys to their configured targets through the relayer policy.
 *
 * The pass first checks the relayer against the sum of every key's target. Each key is then
 * evaluated on its own: a fault on one key is signalled and the pass continues with the remaining
 * keys (SCR-155 §3). Every gas-low signal increments `czar_signer_gas_low{key}` and sends the text
 * alert; a failing alert channel is logged and never stops the pass (SCR-157 §2).
 */
export async function runGasRefill(options: GasRefillOptions): Promise<GasRefillResult[]> {
  await checkRelayer(options);
  const results: GasRefillResult[] = [];
  for (const key of REFILL_KEYS) results.push(await refillKey(options, key));
  return results;
}

async function checkRelayer(options: GasRefillOptions): Promise<void> {
  let targetSum = 0n;
  for (const key of REFILL_KEYS)
    targetSum += readGasBound(options.config, key, "targetAtomic") * NATIVE_PER_USDC_ATOMIC;
  let fault: RefillFault = "key-unavailable";
  let balance: bigint;
  try {
    const relayer = options.keyAddress("relayer");
    fault = "balance-read-failed";
    balance = await options.getNativeBalance(relayer);
  } catch {
    return signalGasLow(options, "relayer", fault);
  }
  if (balance < targetSum) await signalGasLow(options, "relayer", "below-target-sum");
}

async function refillKey(options: GasRefillOptions, key: RefillKey): Promise<GasRefillResult> {
  // Balances are native wei; `signer.gas.*` and the request `amount` stay USDC atomic (A1-05).
  const min = readGasBound(options.config, key, "minAtomic") * NATIVE_PER_USDC_ATOMIC;
  const refillTarget = readGasBound(options.config, key, "targetAtomic") * NATIVE_PER_USDC_ATOMIC;
  const max = readGasBound(options.config, key, "maxAtomic") * NATIVE_PER_USDC_ATOMIC;
  let fault: RefillFault = "key-unavailable";
  let target: Address;
  let balance: bigint;
  try {
    target = options.keyAddress(key);
    fault = "balance-read-failed";
    balance = await options.getNativeBalance(target);
  } catch {
    return refillFailed(options, key, 0n, fault);
  }
  if (balance >= min) return { key, balance, status: "unchanged" };
  const amount = (refillTarget - balance + NATIVE_PER_USDC_ATOMIC - 1n) / NATIVE_PER_USDC_ATOMIC;
  if (amount <= 0n || balance + amount * NATIVE_PER_USDC_ATOMIC > max) {
    await sendAlert(
      options,
      key,
      `Gas refill bounds invalid for ${key}; check signer.gas.${key} config.`,
    );
    return { key, balance, status: "failed" };
  }
  let receiptBlock: bigint;
  try {
    fault = "sign-failed";
    const signed = await options.signer.sign("relayer", {
      keyId: "relayer",
      kind: "gas-refill",
      payload: { target, amount: amount.toString() },
    });
    if (!("signedTransaction" in signed)) throw new Error("gas-refill policy returned a signature");
    fault = "send-failed";
    receiptBlock = await submitOrAbandon(options, signed.signedTransaction);
  } catch {
    return refillFailed(options, key, balance, fault);
  }
  // Read at the receipt's block: the key's own later spending cannot race this read (SCR-157 §2).
  let refilled: bigint;
  try {
    refilled = await options.getNativeBalance(target, receiptBlock);
  } catch {
    return refillFailed(options, key, balance, "balance-read-failed");
  }
  if (refilled < min) await signalGasLow(options, key, "below-min-after-refill");
  return { key, balance: refilled, status: "refilled" };
}

/**
 * Nothing else holds a refill's signed bytes, so a failed send is never broadcast again: its relayer nonce is
 * handed back (SCR-159 §2) and the next refill does not wait behind a gap.
 */
async function submitOrAbandon(options: GasRefillOptions, transaction: Hex): Promise<bigint> {
  try {
    return (await options.submitTransaction(transaction)).blockNumber;
  } catch (error) {
    await options.signer.abandonTransaction("relayer", transaction);
    throw error;
  }
}

async function refillFailed(
  options: GasRefillOptions,
  key: RefillKey,
  balance: bigint,
  fault: RefillFault,
): Promise<GasRefillResult> {
  await signalGasLow(options, key, fault);
  return { key, balance, status: "failed" };
}

async function signalGasLow(
  options: GasRefillOptions,
  key: GasLowKey,
  reason: GasLowReason,
): Promise<void> {
  options.metrics.incrementGasLow(key);
  await sendAlert(options, key, `signer gas low for ${key}: ${reason}`);
}

async function sendAlert(options: GasRefillOptions, key: GasLowKey, message: string) {
  try {
    await options.alert(message);
  } catch {
    const logger = options.logger ?? createLogger({ service: "signer", component: "CZ-27" });
    logger.error("signer_gas_alert", { keyId: key, outcome: "alert-failed" });
  }
}

/**
 * Run one refill pass now, then one every `signer.gasRefillIntervalSeconds`. A pass never starts
 * while another is running; errors go to `onError` and do not stop later passes.
 */
export function startGasRefillJob(
  options: GasRefillOptions,
  onError: (error: unknown) => void,
): () => void {
  let running = false;
  const runPass = () => {
    if (running) return;
    running = true;
    void runGasRefill(options)
      .catch(onError)
      .finally(() => {
        running = false;
      });
  };
  const intervalMs = Number(options.config.get("signer.gasRefillIntervalSeconds")) * MS_PER_SECOND;
  const timer = setInterval(runPass, intervalMs);
  runPass();
  return () => clearInterval(timer);
}

function readGasBound(
  config: Config,
  key: RefillKey,
  bound: "minAtomic" | "targetAtomic" | "maxAtomic",
) {
  return BigInt(config.get(`signer.gas.${key}.${bound}` as never) as number);
}
