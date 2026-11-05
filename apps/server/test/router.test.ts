import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GATEWAY_EXTRA_NAME, USDC_ADDRESS, type PaymentRequirements } from "@czar/x402";
import { loadConfig } from "@czar/config";
import type { Step } from "@czar/schemas";
import {
  callsCovered,
  cPocket,
  cVd,
  pocketCapOk,
  pocketThreshold,
  pocketWorthIt,
  route,
  routingParamsFromConfig,
  type MerchantRate,
  type RouterInput,
  type RoutingParams,
} from "#src/router/index";

const SEED: RoutingParams = {
  gas: {
    reserve: 132_000n,
    settleBase: 30_000n,
    settleIdx: 6_000n,
    finalize: 30_000n,
    pocketSetup: 282_000n,
    pocketDrain: 305_000n,
    pocketSweep: 21_000n,
  },
  gatewayFeeAtomic: 3_500n,
  gatewayEnabled: true,
  jobEnabled: true,
  maxFeeRatioBps: 1_000n,
  jobThresholdAtomic: 5_000_000n,
  maxGasPriceWei: 200_000_000_000n,
};
const FLOOR_GAS_PRICE = 20_000_000_000n;
const NETWORK = "eip155:5042002";
const exact: PaymentRequirements = {
  scheme: "exact",
  network: NETWORK,
  amount: "1000000",
  asset: USDC_ADDRESS,
  payTo: "0x0000000000000000000000000000000000000001",
  maxTimeoutSeconds: 60,
  extra: {},
};
const gateway: PaymentRequirements = {
  ...exact,
  extra: {
    name: GATEWAY_EXTRA_NAME,
    verifyingContract: loadConfig().get("chain.gatewayWalletAddress"),
  },
};
function input(overrides: Partial<RouterInput> = {}): RouterInput {
  return {
    step: {} as Step,
    offers: [exact, gateway],
    planNetwork: NETWORK,
    unitAmount: 40_000n,
    expectedCalls: 1,
    V: 200_000n,
    supplierIsAgent: false,
    needsAcceptanceBeforePayment: false,
    eth_gasPrice: FLOOR_GAS_PRICE,
    params: SEED,
    ...overrides,
  };
}

describe("CZ-14 payment router cost model", () => {
  it("matches the worked seed defaults at the 20 Gwei floor", () => {
    expect(pocketThreshold(1, FLOOR_GAS_PRICE, SEED)).toBe(39_600n);
    expect(pocketThreshold(10, FLOOR_GAS_PRICE, SEED)).toBe(5_040n);
    expect(pocketThreshold(100, FLOOR_GAS_PRICE, SEED)).toBe(1_764n);
    expect(cPocket(FLOOR_GAS_PRICE, SEED)).toBe(15_660n);
    expect(pocketWorthIt(156_600n, FLOOR_GAS_PRICE, SEED)).toBe(true);
    expect(pocketWorthIt(156_599n, FLOOR_GAS_PRICE, SEED)).toBe(false);
    expect(cVd(1, FLOOR_GAS_PRICE, SEED)).toBe(3_960n);
  });

  it("covers at most expected calls, 128 authorizations, and the known 600 s rate", () => {
    const rate: MerchantRate = { numerator: 1n, denominator: 1n };
    expect(callsCovered(150, rate)).toBe(128);
    expect(callsCovered(100, { numerator: 1n, denominator: 2n })).toBe(100);
    expect(callsCovered(400, { numerator: 1n, denominator: 2n })).toBe(128);
    expect(callsCovered(200)).toBe(128);
  });

  it("checks the contract limits against the Solidity source", () => {
    const constants = readFileSync(
      new URL("../../../contracts/src/libraries/CzarConstants.sol", import.meta.url),
      "utf8",
    );
    expect(constants).toMatch(/MAX_AUTHORIZATIONS_PER_RESERVATION\s*=\s*128\s*;/);
    expect(constants).toMatch(/MAX_RESERVATION_TTL\s*=\s*600\s*;/);
  });

  it("checks the objective pocket funding cap at its floor boundary", () => {
    expect(pocketCapOk([25n, 25n], 200n)).toBe(true);
    expect(pocketCapOk([25n, 26n], 200n)).toBe(false);
    expect(pocketCapOk([], 200n)).toBe(true);
  });

  it("loads measured gas-table values and retains usable thresholds", () => {
    const measured = JSON.parse(
      readFileSync(new URL("../../../packages/config/gas-table.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    const config = loadConfig({ envFile: measured });
    const params = routingParamsFromConfig(config);
    expect(pocketThreshold(1, FLOOR_GAS_PRICE, params)).toBe(84_980n);
    expect(pocketThreshold(10, FLOOR_GAS_PRICE, params)).toBe(9_955n);
    expect(pocketThreshold(100, FLOOR_GAS_PRICE, params)).toBe(3_056n);
    expect(cPocket(FLOOR_GAS_PRICE, params)).toBe(22_433n);
  });

  it("keeps Gateway routes off by default and enables them only by config", () => {
    const disabled = routingParamsFromConfig(loadConfig());
    expect(disabled.gatewayEnabled).toBe(false);
    expect(
      route(
        input({
          offers: [gateway],
          unitAmount: 1n,
          params: disabled,
        }),
      ),
    ).toMatchObject({ error: "unsupported-offer", reason: "no-usable-offer" });

    const enabled = routingParamsFromConfig(
      loadConfig({ envFile: { "routing.gatewayEnabled": true } }),
    );
    expect(enabled.gatewayEnabled).toBe(true);
    expect(route(input({ offers: [gateway], unitAmount: 1n, params: enabled }))).toMatchObject({
      kind: "gateway-nano",
    });
  });

  it("routes a verified Circle Gateway batch offer through the pocket", () => {
    const config = loadConfig({ envFile: { "routing.gatewayEnabled": true } });
    const circleGateway: PaymentRequirements = {
      ...gateway,
      extra: {
        name: GATEWAY_EXTRA_NAME,
        verifyingContract: config.get("chain.gatewayWalletAddress"),
        paymentFlow: "batch-settlement",
      },
    };
    expect(
      route(
        input({
          offers: [circleGateway],
          unitAmount: 1_000n,
          params: routingParamsFromConfig(config),
        }),
      ),
    ).toMatchObject({ kind: "gateway-nano" });
  });

  it("keeps job routes off by default and enables them only by config", () => {
    const disabled = routingParamsFromConfig(loadConfig());
    expect(disabled.jobEnabled).toBe(false);
    expect(route(input({ supplierIsAgent: true, params: disabled }))).toMatchObject({
      skipped: true,
      error: "unsupported-offer",
    });

    const enabled = routingParamsFromConfig(
      loadConfig({ envFile: { "routing.jobEnabled": true } }),
    );
    expect(enabled.jobEnabled).toBe(true);
    expect(route(input({ supplierIsAgent: true, params: enabled }))).toMatchObject({
      kind: "erc8183-job",
      routingReason: "specialist-agent",
    });
  });
});

describe("CZ-14 payment router decision order", () => {
  it.each([
    ["specialist-agent", { supplierIsAgent: true }],
    ["acceptance-before-payment", { needsAcceptanceBeforePayment: true }],
    ["above-job-threshold", { unitAmount: SEED.jobThresholdAtomic }],
  ] as const)("rejects %s when job routing is disabled", (_name, overrides) => {
    expect(route(input({ ...overrides, params: { ...SEED, jobEnabled: false } }))).toMatchObject({
      skipped: true,
      error: "unsupported-offer",
      reason: "no-usable-offer",
    });
  });

  it.each([
    ["specialist-agent", { supplierIsAgent: true }, "specialist-agent"],
    [
      "acceptance-before-payment",
      { needsAcceptanceBeforePayment: true },
      "acceptance-before-payment",
    ],
    ["above-job-threshold", { unitAmount: SEED.jobThresholdAtomic }, "above-job-threshold"],
  ] as const)("routes step 1: %s", (_name, overrides, routingReason) => {
    expect(route(input(overrides))).toMatchObject({ kind: "erc8183-job", routingReason });
  });

  it("returns planner-selected local and agent-assist Steps unchanged", () => {
    const step = {
      kind: "local",
      routingReason: "planner-choice",
      marker: true,
    } as unknown as Step;
    expect(route(input({ step }))).toBe(step);
    const assist = { kind: "agent-assist", routingReason: "planner-choice" } as unknown as Step;
    expect(route(input({ step: assist }))).toBe(assist);
  });

  it.each([
    ["at threshold routes exact direct", 39_600n, [exact, gateway], "x402-exact", "vault-direct"],
    [
      "below threshold routes useful pocket",
      39_599n,
      [exact, gateway],
      "gateway-nano",
      "below-pocket-threshold",
    ],
    [
      "below threshold uses safe exact batch",
      3_960n,
      [exact],
      "x402-exact",
      "vault-direct-batched",
    ],
    [
      "gateway without exact routes when useful",
      1_000n,
      [gateway],
      "gateway-nano",
      "below-pocket-threshold",
    ],
  ] as const)("routes step 4: %s", (_name, amount, offers, kind, routingReason) => {
    const result = route(input({ unitAmount: amount, offers, V: 200_000n }));
    expect(result).toMatchObject({ kind, routingReason });
  });

  it("uses 20 Gwei when the supplied gas price is below the floor", () => {
    expect(pocketThreshold(1, 1n, SEED)).toBe(pocketThreshold(1, FLOOR_GAS_PRICE, SEED));
  });

  it("pauses Gateway above maxGasPrice and uses safe exact batch", () => {
    expect(
      route(input({ unitAmount: 40_000n, eth_gasPrice: SEED.maxGasPriceWei + 1n })),
    ).toMatchObject({ kind: "x402-exact", routingReason: "vault-direct-batched" });
  });

  it.each([
    ["upto", { scheme: "upto", extra: {} }],
    ["batch-settlement", { scheme: "batch-settlement", extra: {} }],
    ["SIWX scheme", { scheme: "siwx", extra: {} }],
    ["SIWX-only", { scheme: "exact", extra: { siwx: true } }],
  ] as const)("refuses %s-only offers", (_name, changes) => {
    const offer = { ...exact, ...changes } as PaymentRequirements;
    expect(route(input({ offers: [offer], unitAmount: 1n }))).toMatchObject({
      skipped: true,
      error: "unsupported-offer",
      reason: "no-usable-offer",
    });
  });

  it("returns fee-exceeds-payment when an exact offer cannot cover direct cost", () => {
    expect(route(input({ offers: [exact], unitAmount: 3_959n }))).toMatchObject({
      skipped: true,
      error: "unsupported-offer",
      reason: "fee-exceeds-payment",
    });
  });

  it("returns fee-exceeds-payment for a gateway-only offer when volume is too small", () => {
    expect(route(input({ offers: [gateway], unitAmount: 1n, V: 156_599n }))).toMatchObject({
      skipped: true,
      error: "unsupported-offer",
      reason: "fee-exceeds-payment",
    });
  });

  it("returns no-usable-offer when no supported parsed offer matches", () => {
    expect(route(input({ offers: [], unitAmount: 100_000n }))).toMatchObject({
      skipped: true,
      error: "unsupported-offer",
      reason: "no-usable-offer",
    });
  });

  it.each([
    ["wrong plan network", { network: "eip155:1" }],
    ["wrong asset", { asset: "0x0000000000000000000000000000000000000002" }],
  ] as const)("rejects an otherwise exact offer with %s", (_name, changes) => {
    expect(route(input({ offers: [{ ...exact, ...changes }] }))).toMatchObject({
      skipped: true,
      error: "unsupported-offer",
      reason: "no-usable-offer",
    });
  });

  it("preserves the D37 hard cost rule across 10,000 seeded inputs", () => {
    let state = 0x6d2b79f5;
    const random = (max: number) => {
      state = (Math.imul(state ^ (state >>> 15), 1 | state) + 0x6d2b79f5) | 0;
      state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
      return ((state ^ (state >>> 14)) >>> 0) % max;
    };
    for (let i = 0; i < 10_000; i += 1) {
      const calls = 1 + random(128);
      const amount = BigInt(random(100_000));
      const volume = BigInt(random(1_000_000));
      const result = route(
        input({
          expectedCalls: calls,
          unitAmount: amount,
          V: volume,
          offers: i % 3 === 0 ? [exact] : [exact, gateway],
        }),
      );
      if ("kind" in result && result.kind === "x402-exact") {
        expect(cVd(result.calls, FLOOR_GAS_PRICE, SEED)).toBeLessThanOrEqual(amount);
      } else if ("kind" in result && result.kind === "gateway-nano") {
        expect(pocketWorthIt(volume, FLOOR_GAS_PRICE, SEED)).toBe(true);
      } else if (!("kind" in result)) {
        const hasGateway = i % 3 !== 0;
        expect(cVd(calls, FLOOR_GAS_PRICE, SEED) > amount).toBe(true);
        expect(hasGateway && pocketWorthIt(volume, FLOOR_GAS_PRICE, SEED)).toBe(false);
      }
    }
  });
});
