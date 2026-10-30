import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTransaction, type Hex } from "viem";
import { loadConfig } from "@czar/config";
import type { Address } from "@czar/hashing";
import { runGasRefill, startGasRefillJob, type GasRefillOptions } from "../src/gas-refill.ts";
import { createSignerMetrics, type GasLowKey } from "../src/metrics.ts";
import { harness } from "./helpers.ts";

const relayer = "0x00000000000000000000000000000000000000aa";
const addresses = {
  K3: "0x0000000000000000000000000000000000000003",
  K7: "0x0000000000000000000000000000000000000007",
  K8: "0x0000000000000000000000000000000000000008",
  relayer,
} as const;
const REFILL_KEYS = ["K3", "K7", "K8"] as const;
type RefillKey = (typeof REFILL_KEYS)[number];
/** Arc native balances are 18-decimal wei; `signer.gas.*` and the payload are USDC 6-decimal atomic. */
const WEI_PER_ATOMIC = 10n ** 12n;
const usdcWei = (atomic: bigint) => atomic * WEI_PER_ATOMIC;
const gasBound = (key: RefillKey, bound: "minAtomic" | "targetAtomic" | "maxAtomic") =>
  BigInt(loadConfig().get(`signer.gas.${key}.${bound}` as never) as number);
const atTarget = (key: RefillKey) => usdcWei(gasBound(key, "targetAtomic"));
/** The relayer at exactly the sum of every key's target is not low (CZ-27 §5.5). */
const RELAYER_AT_TARGETS = REFILL_KEYS.reduce((sum, key) => sum + atTarget(key), 0n);

function gasLowCounts(metrics: ReturnType<typeof createSignerMetrics>) {
  return Object.fromEntries(
    (["K3", "K7", "K8", "relayer"] as const).map((key: GasLowKey) => [
      key,
      metrics.gasLowCount(key),
    ]),
  );
}

async function refillThroughPolicy(native: Readonly<Record<RefillKey, bigint>>) {
  const t = await harness();
  for (const key of REFILL_KEYS) t.state.native.set(t.address(key).toLowerCase(), native[key]);
  t.state.native.set(t.address("relayer").toLowerCase(), RELAYER_AT_TARGETS);
  const values: { to: string; value: bigint }[] = [];
  const alerts: string[] = [];
  const results = await runGasRefill({
    config: loadConfig(),
    signer: t.signer,
    keyAddress: (key) => t.address(key),
    getNativeBalance: async (address) => t.state.native.get(address.toLowerCase()) ?? 0n,
    submitTransaction: async (transaction: Hex) => {
      const tx = parseTransaction(transaction);
      const to = (tx.to ?? "").toLowerCase();
      const value = tx.value ?? 0n;
      values.push({ to, value });
      t.state.native.set(to, (t.state.native.get(to) ?? 0n) + value);
      return { blockNumber: 1n };
    },
    alert: async (message) => {
      alerts.push(message);
    },
    metrics: createSignerMetrics(),
  });
  return { t, values, alerts, results };
}

/**
 * In-memory chain for the refill pass. Each submitted refill credits its target and mines one
 * block; a read with `blockNumber` returns the balance as of that block.
 */
function fakeRefillChain(native: Partial<Record<RefillKey | "relayer", bigint>>) {
  const balances = new Map<string, bigint>(
    (["K3", "K7", "K8", "relayer"] as const).map((key) => [
      addresses[key],
      native[key] ?? (key === "relayer" ? RELAYER_AT_TARGETS : 0n),
    ]),
  );
  const history = new Map<bigint, Map<string, bigint>>();
  let block = 100n;
  const requests: { target: string; amount: string }[] = [];
  const alerts: string[] = [];
  const reads: { address: string; blockNumber: bigint | undefined }[] = [];
  const logLines: string[] = [];
  const metrics = createSignerMetrics();
  const options: GasRefillOptions = {
    config: loadConfig(),
    signer: {
      async sign(_caller, request) {
        requests.push(request.payload as { target: string; amount: string });
        return { signedTransaction: "0x01" };
      },
    },
    keyAddress: (key) => addresses[key],
    getNativeBalance: async (address: Address, blockNumber?: bigint) => {
      reads.push({ address, blockNumber });
      const state = blockNumber === undefined ? balances : history.get(blockNumber);
      if (state === undefined) throw new Error(`no state at block ${blockNumber}`);
      return state.get(address.toLowerCase()) ?? 0n;
    },
    submitTransaction: async () => {
      const request = requests.at(-1);
      if (!request) throw new Error("missing gas refill request");
      const address = request.target.toLowerCase();
      balances.set(address, (balances.get(address) ?? 0n) + usdcWei(BigInt(request.amount)));
      block += 1n;
      history.set(block, new Map(balances));
      return { blockNumber: block };
    },
    alert: async (message) => {
      alerts.push(message);
    },
    metrics,
    logger: {
      error: (event, fields) => logLines.push(JSON.stringify({ event, ...fields })),
    },
  };
  return {
    balances,
    history,
    requests,
    alerts,
    reads,
    logLines,
    metrics,
    options,
    block: () => block,
  };
}

describe("gas refill job", () => {
  it("gasRefill_keepsK3K7K8WithinBounds", async () => {
    const chain = fakeRefillChain({
      K3: usdcWei(499_999n),
      K7: usdcWei(99_999n),
      K8: usdcWei(500_000n),
    });
    const results = await runGasRefill(chain.options);

    expect(chain.requests).toEqual([
      { target: addresses.K3, amount: "1500001" },
      { target: addresses.K7, amount: "400001" },
    ]);
    expect(results.map(({ key, balance }) => [key, balance])).toEqual([
      ["K3", usdcWei(2_000_000n)],
      ["K7", usdcWei(500_000n)],
      ["K8", usdcWei(500_000n)],
    ]);
    expect(chain.alerts).toEqual([]);
    for (const key of REFILL_KEYS) {
      expect(chain.balances.get(addresses[key])).toBeLessThanOrEqual(
        usdcWei(gasBound(key, "maxAtomic")),
      );
    }
  });

  it("refills K3 from 0.4 USDC to 2 USDC with a signed value of 1.6 USDC in wei", async () => {
    const { t, values, alerts, results } = await refillThroughPolicy({
      K3: usdcWei(400_000n),
      K7: usdcWei(gasBound("K7", "minAtomic")),
      K8: usdcWei(gasBound("K8", "minAtomic")),
    });

    expect(values).toEqual([{ to: t.address("K3").toLowerCase(), value: usdcWei(1_600_000n) }]);
    expect(results.map(({ key, status }) => [key, status])).toEqual([
      ["K3", "refilled"],
      ["K7", "unchanged"],
      ["K8", "unchanged"],
    ]);
    expect(t.state.native.get(t.address("K3").toLowerCase())).toBe(atTarget("K3"));
    expect(alerts).toEqual([]);
  });

  it("leaves a key at or above minAtomic in wei unchanged and refills one wei below it", async () => {
    const min = usdcWei(gasBound("K3", "minAtomic"));
    const atMin = await refillThroughPolicy({ K3: min, K7: min, K8: min });
    expect(atMin.values).toEqual([]);
    expect(atMin.results.map(({ status }) => status)).toEqual([
      "unchanged",
      "unchanged",
      "unchanged",
    ]);

    const below = await refillThroughPolicy({ K3: min - 1n, K7: min, K8: min });
    const refilled = below.t.state.native.get(below.t.address("K3").toLowerCase()) ?? 0n;
    expect(below.results[0]).toMatchObject({ key: "K3", status: "refilled" });
    expect(refilled).toBeGreaterThanOrEqual(atTarget("K3"));
    expect(refilled).toBeLessThanOrEqual(usdcWei(gasBound("K3", "maxAtomic")));
  });

  it("alerts instead of refilling when target exceeds max in wei terms", async () => {
    const chain = fakeRefillChain({
      K3: usdcWei(400_000n),
      K7: usdcWei(1_000_000n),
      K8: usdcWei(1_000_000n),
    });
    const results = await runGasRefill({
      ...chain.options,
      config: loadConfig({
        envFile: { "signer.gas.K3.targetAtomic": 2_000_000, "signer.gas.K3.maxAtomic": 1_999_999 },
      }),
    });

    expect(chain.requests).toEqual([]);
    expect(results[0]).toMatchObject({ key: "K3", status: "failed" });
    expect(chain.alerts).toEqual([expect.stringContaining("signer.gas.K3")]);
  });

  it("alerts when the relayer cannot submit a refill", async () => {
    const chain = fakeRefillChain({ K3: 1n });
    const results = await runGasRefill({
      ...chain.options,
      submitTransaction: async () => {
        throw new Error("insufficient funds for gas * price + value");
      },
    });

    expect(results.map(({ key, status }) => [key, status])).toEqual([
      ["K3", "failed"],
      ["K7", "failed"],
      ["K8", "failed"],
    ]);
    expect(chain.alerts).toEqual(
      REFILL_KEYS.map((key) => `signer gas low for ${key}: send-failed`),
    );
  });
});

describe("gas refill per key (SCR-155 §3)", () => {
  it("still refills the second key when the first key's balance read throws", async () => {
    const chain = fakeRefillChain({ K3: atTarget("K3"), K7: 0n, K8: atTarget("K8") });
    const read = chain.options.getNativeBalance;
    const results = await runGasRefill({
      ...chain.options,
      getNativeBalance: async (address, blockNumber) => {
        if (address === addresses.K3) throw new Error(`rpc read failed for ${address}`);
        return read(address, blockNumber);
      },
    });

    expect(results.map(({ key, status }) => [key, status])).toEqual([
      ["K3", "failed"],
      ["K7", "refilled"],
      ["K8", "unchanged"],
    ]);
    expect(chain.balances.get(addresses.K7)).toBe(atTarget("K7"));
    expect(chain.alerts).toEqual(["signer gas low for K3: balance-read-failed"]);
  });

  it("still refills the second key when the first key's send fails", async () => {
    const chain = fakeRefillChain({ K3: 0n, K7: 0n, K8: atTarget("K8") });
    const submit = chain.options.submitTransaction;
    const results = await runGasRefill({
      ...chain.options,
      submitTransaction: async (transaction) => {
        if (chain.requests.at(-1)?.target === addresses.K3)
          throw new Error(`insufficient funds for ${relayer} at https://rpc.example/?key=secret`);
        return submit(transaction);
      },
    });

    expect(results.map(({ key, status }) => [key, status])).toEqual([
      ["K3", "failed"],
      ["K7", "refilled"],
      ["K8", "unchanged"],
    ]);
    expect(chain.balances.get(addresses.K7)).toBe(atTarget("K7"));
    expect(chain.alerts).toEqual(["signer gas low for K3: send-failed"]);
  });

  it("counts a mined refill as refilled even if the key spends gas after the receipt block", async () => {
    const chain = fakeRefillChain({ K3: 0n, K7: atTarget("K7"), K8: atTarget("K8") });
    const submit = chain.options.submitTransaction;
    const results = await runGasRefill({
      ...chain.options,
      submitTransaction: async (transaction) => {
        const receipt = await submit(transaction);
        const k3 = chain.balances.get(addresses.K3) ?? 0n;
        chain.balances.set(addresses.K3, k3 - usdcWei(gasBound("K3", "targetAtomic")));
        return receipt;
      },
    });

    expect(results.map(({ key, status }) => [key, status])).toEqual([
      ["K3", "refilled"],
      ["K7", "unchanged"],
      ["K8", "unchanged"],
    ]);
    expect(results[0]?.balance).toBe(atTarget("K3"));
    expect(chain.alerts).toEqual([]);
    expect(chain.metrics.gasLowCount("K3")).toBe(0);
  });
});

describe("gas-low signal (SCR-157 §2, CZ-27 §5.5)", () => {
  it("reads the balance at the receipt's block and reports that balance", async () => {
    const chain = fakeRefillChain({ K3: 0n, K7: atTarget("K7"), K8: atTarget("K8") });
    const results = await runGasRefill(chain.options);

    const receiptBlock = chain.block();
    expect(chain.reads.filter((read) => read.address === addresses.K3)).toEqual([
      { address: addresses.K3, blockNumber: undefined },
      { address: addresses.K3, blockNumber: receiptBlock },
    ]);
    expect(results[0]).toEqual({ key: "K3", balance: atTarget("K3"), status: "refilled" });
    expect(gasLowCounts(chain.metrics)).toEqual({ K3: 0, K7: 0, K8: 0, relayer: 0 });
  });

  it("counts and alerts when the balance at the receipt block is below minAtomic", async () => {
    const chain = fakeRefillChain({ K3: 0n, K7: atTarget("K7"), K8: atTarget("K8") });
    const submit = chain.options.submitTransaction;
    const belowMin = usdcWei(gasBound("K3", "minAtomic")) - 1n;
    const results = await runGasRefill({
      ...chain.options,
      submitTransaction: async (transaction) => {
        const receipt = await submit(transaction);
        chain.history.get(receipt.blockNumber)?.set(addresses.K3, belowMin);
        return receipt;
      },
    });

    expect(results[0]).toEqual({ key: "K3", balance: belowMin, status: "refilled" });
    expect(gasLowCounts(chain.metrics)).toEqual({ K3: 1, K7: 0, K8: 0, relayer: 0 });
    expect(chain.alerts).toEqual(["signer gas low for K3: below-min-after-refill"]);
  });

  it.each([
    ["key-unavailable", { keyAddress: () => throwing("no key") }],
    ["balance-read-failed", { getNativeBalance: async () => throwing("rpc down") }],
    ["sign-failed", { signer: { sign: async () => throwing("denied") } }],
    ["send-failed", { submitTransaction: async () => throwing("rpc down") }],
  ] as const)("counts a failed attempt (%s) for the key", async (reason, override) => {
    const chain = fakeRefillChain({ K3: 0n, K7: atTarget("K7"), K8: atTarget("K8") });
    const options = { ...chain.options, ...override } as GasRefillOptions;
    const keyAddress = options.keyAddress;
    const getNativeBalance = options.getNativeBalance;
    await runGasRefill({
      ...options,
      // The relayer check and the healthy keys keep working; only K3's step fails.
      keyAddress: (key) => (key === "K3" ? keyAddress(key) : addresses[key]),
      getNativeBalance: (address, blockNumber) =>
        address === addresses.K3
          ? getNativeBalance(address, blockNumber)
          : chain.options.getNativeBalance(address, blockNumber),
    });

    expect(gasLowCounts(chain.metrics)).toEqual({ K3: 1, K7: 0, K8: 0, relayer: 0 });
    expect(chain.alerts).toEqual([`signer gas low for K3: ${reason}`]);
  });

  it("counts the relayer when it is below the sum of every key's targetAtomic", async () => {
    const chain = fakeRefillChain({
      K3: atTarget("K3"),
      K7: atTarget("K7"),
      K8: atTarget("K8"),
      relayer: RELAYER_AT_TARGETS - 1n,
    });
    await runGasRefill(chain.options);

    expect(gasLowCounts(chain.metrics)).toEqual({ K3: 0, K7: 0, K8: 0, relayer: 1 });
    expect(chain.alerts).toEqual(["signer gas low for relayer: below-target-sum"]);
  });

  it("checks the relayer at the start of the pass, before any key is refilled", async () => {
    const chain = fakeRefillChain({ K3: 0n, relayer: 0n });
    await runGasRefill({
      ...chain.options,
      submitTransaction: async () => throwing("insufficient funds"),
    });

    expect(chain.alerts[0]).toBe("signer gas low for relayer: below-target-sum");
    expect(chain.reads[0]?.address).toBe(addresses.relayer);
  });

  it("leaves the relayer quiet at exactly the sum of targets", async () => {
    const chain = fakeRefillChain({ K3: atTarget("K3"), K7: atTarget("K7"), K8: atTarget("K8") });
    await runGasRefill(chain.options);

    expect(gasLowCounts(chain.metrics)).toEqual({ K3: 0, K7: 0, K8: 0, relayer: 0 });
    expect(chain.alerts).toEqual([]);
  });

  it("logs alert-failed with the key id when the alert channel fails and finishes the pass", async () => {
    const chain = fakeRefillChain({ K3: 0n, K7: 0n, K8: atTarget("K8") });
    const submit = chain.options.submitTransaction;
    const results = await runGasRefill({
      ...chain.options,
      submitTransaction: async (transaction) => {
        if (chain.requests.at(-1)?.target === addresses.K3) throwing("rpc down");
        return submit(transaction);
      },
      alert: async () => throwing("alert channel down"),
    });

    expect(results.map(({ key, status }) => [key, status])).toEqual([
      ["K3", "failed"],
      ["K7", "refilled"],
      ["K8", "unchanged"],
    ]);
    expect(chain.metrics.gasLowCount("K3")).toBe(1);
    expect(chain.logLines.map((line) => JSON.parse(line))).toEqual([
      { event: "signer_gas_alert", keyId: "K3", outcome: "alert-failed" },
    ]);
  });

  it("exposes the counter in Prometheus text form with one series per key", async () => {
    const chain = fakeRefillChain({ K3: 0n, relayer: 0n });
    await runGasRefill({
      ...chain.options,
      submitTransaction: async () => throwing("rpc down"),
    });

    expect(chain.metrics.render()).toBe(
      [
        "# HELP czar_signer_gas_low Signer gas key found low or not refilled (CZ-27 §5.5).",
        "# TYPE czar_signer_gas_low counter",
        'czar_signer_gas_low{key="K3"} 1',
        'czar_signer_gas_low{key="K7"} 1',
        'czar_signer_gas_low{key="K8"} 1',
        'czar_signer_gas_low{key="relayer"} 1',
        "",
      ].join("\n"),
    );
  });
});

describe("gas refill job start (SCR-155 §3)", () => {
  afterEach(() => vi.useRealTimers());

  it("refills a key with no gas in its first pass, before the interval elapses", async () => {
    vi.useFakeTimers();
    const chain = fakeRefillChain({ K3: 0n, K7: atTarget("K7"), K8: atTarget("K8") });
    const stop = startGasRefillJob(chain.options, () => undefined);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(chain.balances.get(addresses.K3)).toBe(atTarget("K3"));
      expect(chain.requests).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it("runs again on signer.gasRefillIntervalSeconds and never overlaps passes", async () => {
    vi.useFakeTimers();
    const intervalMs = 60_000;
    const chain = fakeRefillChain({ K3: atTarget("K3"), K7: atTarget("K7"), K8: atTarget("K8") });
    let passes = 0;
    let release: (() => void) | undefined;
    const read = chain.options.getNativeBalance;
    const stop = startGasRefillJob(
      {
        ...chain.options,
        config: loadConfig({ envFile: { "signer.gasRefillIntervalSeconds": intervalMs / 1000 } }),
        getNativeBalance: async (address, blockNumber) => {
          if (address === addresses.K3) {
            passes += 1;
            if (passes === 1) await new Promise<void>((resolve) => (release = resolve));
          }
          return read(address, blockNumber);
        },
      },
      () => undefined,
    );
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(passes).toBe(1);
      await vi.advanceTimersByTimeAsync(2 * intervalMs);
      expect(passes).toBe(1);
      release?.();
      await vi.advanceTimersByTimeAsync(intervalMs - 1);
      expect(passes).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(passes).toBe(2);
    } finally {
      stop();
    }
  });

  it("defaults the interval to 300 seconds", () => {
    expect(loadConfig().get("signer.gasRefillIntervalSeconds" as never)).toBe(300);
  });
});

function throwing(message: string): never {
  throw new Error(message);
}

describe("refill nonces after a failed send (SCR-159 §2)", () => {
  it("signs the next refill on the failed refill's nonce, so it is not stuck behind a gap", async () => {
    // The RPC pending count moves only when a refill reaches the node.
    let pending = 5;
    const t = await harness({
      prepareTransaction: async (_from, call) => ({
        type: "eip1559",
        chainId: 5042002,
        nonce: pending,
        gas: 21_000n,
        maxFeePerGas: 20_000_000_000n,
        maxPriorityFeePerGas: 1n,
        to: call.to,
        data: call.data,
        value: call.value,
      }),
    });
    for (const key of REFILL_KEYS) t.state.native.set(t.address(key).toLowerCase(), 0n);
    t.state.native.set(t.address("relayer").toLowerCase(), RELAYER_AT_TARGETS);
    const nonces: number[] = [];
    let failFirst = true;

    const results = await runGasRefill({
      config: loadConfig(),
      signer: t.signer,
      keyAddress: (key) => t.address(key),
      getNativeBalance: async (address) => t.state.native.get(address.toLowerCase()) ?? 0n,
      submitTransaction: async (transaction: Hex) => {
        const tx = parseTransaction(transaction);
        nonces.push(tx.nonce ?? -1);
        if (failFirst) {
          failFirst = false;
          throw new Error("insufficient funds for gas");
        }
        pending += 1;
        const to = (tx.to ?? "").toLowerCase();
        t.state.native.set(to, (t.state.native.get(to) ?? 0n) + (tx.value ?? 0n));
        return { blockNumber: 1n };
      },
      alert: async () => undefined,
      metrics: createSignerMetrics(),
    });

    expect(results.map(({ status }) => status)).toEqual(["failed", "refilled", "refilled"]);
    expect(nonces).toEqual([5, 5, 6]);
  });
});
