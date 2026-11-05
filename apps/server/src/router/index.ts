import { loadConfig, type Config, type ParameterValue } from "@czar/config";
import { MIN_MAX_FEE_PER_GAS } from "@czar/vault-client";
import {
  classifyOffer,
  USDC_ADDRESS,
  type PaymentRequirements,
  type SanitizedExtensions,
} from "@czar/x402";
import type { Step } from "@czar/schemas";

export const MAX_AUTHORIZATIONS_PER_RESERVATION = 128;
export const MAX_RESERVATION_TTL = 600n;
export const FINALIZE_CHUNK = 32n;
export const POCKET_CAP_BPS = 2_500n;
const ATOMIC_PER_WEI = 1_000_000_000_000n;
const BPS = 10_000n;

export interface RoutingParams {
  readonly gas: {
    readonly reserve: bigint;
    readonly settleBase: bigint;
    readonly settleIdx: bigint;
    readonly finalize: bigint;
    readonly pocketSetup: bigint;
    readonly pocketDrain: bigint;
    readonly pocketSweep: bigint;
  };
  readonly gatewayFeeAtomic: bigint;
  readonly gatewayEnabled: boolean;
  readonly jobEnabled: boolean;
  readonly maxFeeRatioBps: bigint;
  readonly jobThresholdAtomic: bigint;
  readonly maxGasPriceWei: bigint;
}

export interface MerchantRate {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export interface RouterInput {
  readonly step: Step;
  readonly offers: readonly PaymentRequirements[];
  readonly planNetwork: string;
  readonly unitAmount: bigint;
  readonly expectedCalls: number;
  readonly V: bigint;
  readonly supplierIsAgent: boolean;
  readonly needsAcceptanceBeforePayment: boolean;
  readonly eth_gasPrice: bigint;
  readonly merchantCallsPerSecond?: MerchantRate;
  readonly params: RoutingParams;
  readonly config?: Config;
  readonly extensions402?: SanitizedExtensions;
}

export type RoutingReason =
  | "vault-direct"
  | "vault-direct-batched"
  | "below-pocket-threshold"
  | "specialist-agent"
  | "acceptance-before-payment"
  | "above-job-threshold";

export interface RouteDecision {
  readonly kind: "x402-exact" | "gateway-nano" | "erc8183-job";
  readonly routingReason: RoutingReason;
  readonly calls: number;
}

export interface SkippedRoute {
  readonly skipped: true;
  readonly error: "unsupported-offer";
  readonly reason: "fee-exceeds-payment" | "no-usable-offer";
}

export type UnpaidStep = Step & { readonly kind: "local" | "agent-assist" };
export type RouteResult = UnpaidStep | RouteDecision | SkippedRoute;

export function routingParamsFromConfig(config: Config = loadConfig()): RoutingParams {
  return {
    gas: {
      reserve: configBigInt(config.get("routing.gas.reserve")),
      settleBase: configBigInt(config.get("routing.gas.settleBase")),
      settleIdx: configBigInt(config.get("routing.gas.settleIdx")),
      finalize: configBigInt(config.get("routing.gas.finalize")),
      pocketSetup: configBigInt(config.get("routing.gas.pocketSetup")),
      pocketDrain: configBigInt(config.get("routing.gas.pocketDrain")),
      pocketSweep: configBigInt(config.get("routing.gas.pocketSweep")),
    },
    gatewayFeeAtomic: configBigInt(config.get("routing.gatewayFeeAtomic")),
    gatewayEnabled: config.get("routing.gatewayEnabled") as boolean,
    jobEnabled: config.get("routing.jobEnabled") as boolean,
    maxFeeRatioBps: configBigInt(config.get("routing.maxFeeRatioBps")),
    jobThresholdAtomic: configBigInt(config.get("routing.jobThresholdAtomic")),
    maxGasPriceWei: configBigInt(config.get("routing.maxGasPriceWei")),
  };
}

export function cVd(calls: number, gasPriceWei: bigint, params: RoutingParams): bigint {
  validateCalls(calls);
  const n = BigInt(calls);
  const total = gasTotal(n, params);
  return ceilDiv(total * floorGasPrice(gasPriceWei), n * ATOMIC_PER_WEI);
}

export function pocketThreshold(calls: number, gasPriceWei: bigint, params: RoutingParams): bigint {
  validateCalls(calls);
  const n = BigInt(calls);
  return ceilDiv(
    gasTotal(n, params) * floorGasPrice(gasPriceWei) * BPS,
    n * ATOMIC_PER_WEI * positive(params.maxFeeRatioBps, "maxFeeRatioBps"),
  );
}

export function cPocket(gasPriceWei: bigint, params: RoutingParams): bigint {
  const gas = params.gas.pocketSetup + params.gas.pocketDrain + params.gas.pocketSweep;
  return ceilDiv(gas * floorGasPrice(gasPriceWei), ATOMIC_PER_WEI) + params.gatewayFeeAtomic;
}

export function pocketWorthIt(V: bigint, gasPriceWei: bigint, params: RoutingParams): boolean {
  const minVolume = ceilDiv(
    cPocket(gasPriceWei, params) * BPS,
    positive(params.maxFeeRatioBps, "maxFeeRatioBps"),
  );
  return V >= minVolume;
}

export function pocketCapOk(
  gatewayStepCaps: readonly bigint[],
  envelopeCap: bigint,
  pocketCapBps: bigint = POCKET_CAP_BPS,
): boolean {
  if (envelopeCap < 0n || pocketCapBps < 0n)
    throw new RangeError("pocket cap inputs must be non-negative");
  const total = gatewayStepCaps.reduce((sum, cap) => {
    if (cap < 0n) throw new RangeError("gateway step caps must be non-negative");
    return sum + cap;
  }, 0n);
  return total <= (envelopeCap * pocketCapBps) / BPS;
}

export function callsCovered(expectedCalls: number, rate?: MerchantRate): number {
  if (!Number.isSafeInteger(expectedCalls) || expectedCalls < 0)
    throw new RangeError("expectedCalls must be a non-negative safe integer");
  let covered = Math.min(expectedCalls, MAX_AUTHORIZATIONS_PER_RESERVATION);
  if (rate !== undefined) {
    if (rate.numerator < 0n || rate.denominator <= 0n)
      throw new RangeError("merchant rate must be a non-negative rational number");
    const withinTtl = (rate.numerator * MAX_RESERVATION_TTL) / rate.denominator;
    const capped = withinTtl < BigInt(covered) ? withinTtl : BigInt(covered);
    covered = Number(capped);
  }
  return covered;
}

export function route(input: RouterInput): RouteResult {
  if (input.step.kind === "local" || input.step.kind === "agent-assist")
    return input.step as UnpaidStep;
  const calls = callsCovered(input.expectedCalls, input.merchantCallsPerSecond);
  const jobReason = input.supplierIsAgent
    ? "specialist-agent"
    : input.needsAcceptanceBeforePayment
      ? "acceptance-before-payment"
      : input.unitAmount >= input.params.jobThresholdAtomic
        ? "above-job-threshold"
        : undefined;
  if (jobReason !== undefined) {
    if (!input.params.jobEnabled) return skipped("no-usable-offer");
    return { kind: "erc8183-job", routingReason: jobReason, calls };
  }

  const offers = usableOffers(
    input.offers,
    input.planNetwork,
    input.config ?? loadConfig(),
    input.extensions402 ?? { dropped: [] },
  );
  if (calls === 0) return skipped("fee-exceeds-payment");
  if (!offers.hasExact && offers.hasGateway && !input.params.gatewayEnabled)
    return skipped("no-usable-offer");
  const gasPrice = floorGasPrice(input.eth_gasPrice);
  const gatewayUsable =
    input.params.gatewayEnabled && offers.hasGateway && gasPrice <= input.params.maxGasPriceWei;
  const cost = cVd(calls, gasPrice, input.params);
  const threshold = pocketThreshold(calls, gasPrice, input.params);
  const worthIt = pocketWorthIt(input.V, gasPrice, input.params);
  if (offers.hasExact && input.unitAmount >= threshold)
    return { kind: "x402-exact", routingReason: "vault-direct", calls };
  if (offers.hasExact && gatewayUsable && worthIt)
    return { kind: "gateway-nano", routingReason: "below-pocket-threshold", calls };
  if (offers.hasExact && input.unitAmount >= cost)
    return { kind: "x402-exact", routingReason: "vault-direct-batched", calls };
  if (!offers.hasExact && gatewayUsable)
    return worthIt
      ? { kind: "gateway-nano", routingReason: "below-pocket-threshold", calls }
      : skipped("fee-exceeds-payment");
  if (offers.hadCandidate) return skipped("fee-exceeds-payment");
  return skipped("no-usable-offer");
}

function usableOffers(
  offers: readonly PaymentRequirements[],
  planNetwork: string,
  config: Config,
  extensions402: SanitizedExtensions,
) {
  let hasExact = false;
  let hasGateway = false;
  let hadCandidate = false;
  for (const offer of offers) {
    // planNetwork is selection.paymentNetwork, set by the planner from @czar/config (D83).
    if (offer.scheme !== "exact" || offer.network !== planNetwork) continue;
    if (offer.asset.toLowerCase() !== USDC_ADDRESS.toLowerCase()) continue;
    const classification = classifyOffer(offer, extensions402, config);
    if (classification === "unsupported") continue;
    hasExact ||= classification === "vanilla";
    hasGateway ||= classification === "gateway";
    hadCandidate = true;
  }
  return { hasExact, hasGateway, hadCandidate };
}

function gasTotal(calls: bigint, params: RoutingParams): bigint {
  const settleChunks = ceilDiv(calls, FINALIZE_CHUNK);
  return (
    params.gas.reserve +
    settleChunks * params.gas.settleBase +
    calls * params.gas.settleIdx +
    params.gas.finalize
  );
}

function floorGasPrice(wei: bigint): bigint {
  if (wei < 0n) throw new RangeError("gas price must be non-negative");
  const floor = BigInt(MIN_MAX_FEE_PER_GAS);
  return wei > floor ? wei : floor;
}

function validateCalls(calls: number): void {
  if (!Number.isSafeInteger(calls) || calls < 1 || calls > MAX_AUTHORIZATIONS_PER_RESERVATION)
    throw new RangeError("calls must be between 1 and MAX_AUTHORIZATIONS_PER_RESERVATION");
}

function positive(value: bigint, name: string): bigint {
  if (value <= 0n) throw new RangeError(`${name} must be positive`);
  return value;
}

function configBigInt(value: ParameterValue): bigint {
  if (typeof value !== "number" && typeof value !== "string")
    throw new TypeError("routing configuration value must be an integer");
  return BigInt(value);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError("division denominator must be positive");
  return (numerator + denominator - 1n) / denominator;
}

function skipped(reason: SkippedRoute["reason"]): SkippedRoute {
  return { skipped: true, error: "unsupported-offer", reason };
}
