// The lab's identity and its one source of randomness (CZ-20 §5.8a).
//
// Every profile is a pure function of `merchants.lab.seed`, the service id, a named stream and the position
// of the call in that stream. The caller of a lab route is never an input: there is no parameter on any
// function here that could carry it, so Czar cannot tune a result for its own agent.
import { H } from "@czar/hashing";
import { ARC_TESTNET_CHAIN_ID } from "@czar/config";
import { EXTRACT_PATH } from "../extract/index.ts";
import { SEARCH_PATH } from "../search/index.ts";
import { SPOT_PATH } from "../spot/index.ts";

/** The six services, in registration order (CZ-20 §5.8a). Each needs its own `K10:<id>` key. */
export const LAB_SERVICE_IDS = [
  "lab-search-steady",
  "lab-search-flaky",
  "lab-search-slow",
  "lab-extract-schemabreak",
  "lab-extract-drift",
  "lab-spot-payee-swap",
] as const;

export type LabServiceId = (typeof LAB_SERVICE_IDS)[number];

const TAILS: Readonly<Record<LabServiceId, string>> = {
  "lab-search-steady": SEARCH_PATH,
  "lab-search-flaky": SEARCH_PATH,
  "lab-search-slow": SEARCH_PATH,
  "lab-extract-schemabreak": EXTRACT_PATH,
  "lab-extract-drift": EXTRACT_PATH,
  "lab-spot-payee-swap": SPOT_PATH,
};

/**
 * The route group `/lab/<serviceName>/…` (CZ-20 §5.8a). Past the group the path is the core service the lab
 * service imitates (`/v1/search`, `/v1/extract`, `/v1/spot`), so a lab service takes the same input and
 * answers in the same shape as the real one.
 */
export const labPath = (id: LabServiceId): string => `/lab/${id}${TAILS[id]}`;

/** The local `arc-anvil` chain id; with Arc testnet these are the only chains the lab may run on. */
export const LOCAL_ANVIL_CHAIN_ID = 31337;

/**
 * True only for a CAIP-2 network on a test chain. Mirrors the cloud guard (`cloud-only.ts`): anything that is
 * not a known test chain, including a string that cannot be read, counts as mainnet, so the check fails closed.
 */
export function isTestNetwork(network: string): boolean {
  const match = /^eip155:([0-9]{1,18})$/.exec(network);
  if (match === null) return false;
  const chainId = Number(match[1]);
  return chainId === ARC_TESTNET_CHAIN_ID || chainId === LOCAL_ANVIL_CHAIN_ID;
}

/** Hex digits of the keccak digest that make up the 52-bit mantissa of one draw. */
const UNIT_HEX_DIGITS = 13;
const UNIT_RANGE = 2 ** (UNIT_HEX_DIGITS * 4);

/**
 * One uniform draw in [0, 1), a pure function of its four arguments. `stream` keeps the draws of different
 * behaviours of one service independent; `n` is the draw's position in that stream.
 */
export function labUnit(seed: number, service: LabServiceId, stream: string, n: number): number {
  const digest = H({ lab: "czar-test-merchant", seed, service, stream, n });
  return Number(BigInt(digest.slice(0, 2 + UNIT_HEX_DIGITS))) / UNIT_RANGE;
}

/**
 * Calls per block of a rate stream. Inside a block the hits are placed at seeded random positions, but the
 * number of hits is fixed by the rate, so any run of whole blocks hits the configured rate exactly and a
 * thousand calls land within a fraction of a percent of it. Plain independent draws would only land within
 * a few percent, which is too loose for a test that checks the profile against its parameter.
 */
export const LAB_BLOCK_CALLS = 100;
const PARTS_PER_MILLION = 1_000_000;

/**
 * A seeded stream of yes/no outcomes that is `true` for `rate` of the calls. Call it once per event: the
 * n-th call returns the n-th outcome, which depends on the seed, the service, the stream name and `n` only.
 * Hits per block follow the running total of `rate x LAB_BLOCK_CALLS`, so a fractional share is not lost.
 */
export function labCoin(
  seed: number,
  service: LabServiceId,
  stream: string,
  rate: number,
): () => boolean {
  const ppm = Math.round(rate * PARTS_PER_MILLION);
  // Hits up to `blocks` whole blocks; integer arithmetic, exact below 9e9 calls.
  const hitsThrough = (blocks: number) =>
    Math.floor((blocks * LAB_BLOCK_CALLS * ppm) / PARTS_PER_MILLION);
  let call = 0;
  let block = -1;
  let hitPositions = new Set<number>();

  function enter(next: number): void {
    block = next;
    const hits = hitsThrough(next + 1) - hitsThrough(next);
    const order = Array.from({ length: LAB_BLOCK_CALLS }, (_, position) => ({
      position,
      key: labUnit(seed, service, stream, next * LAB_BLOCK_CALLS + position),
    })).toSorted((a, b) => a.key - b.key || a.position - b.position);
    hitPositions = new Set(order.slice(0, hits).map((entry) => entry.position));
  }

  return () => {
    const n = call;
    call += 1;
    const current = Math.floor(n / LAB_BLOCK_CALLS);
    if (current !== block) enter(current);
    return hitPositions.has(n % LAB_BLOCK_CALLS);
  };
}

const MS_PER_DAY = 86_400_000;

/**
 * Whether the second payee is the live one at `nowMs`. The payee flips every `everyDays` days, so each
 * payee is live for `everyDays` days at a time; the seed sets where in that cycle day 0 falls.
 */
export function payeeSwapped(seed: number, everyDays: number, nowMs: number): boolean {
  const epochDay = Math.floor(nowMs / MS_PER_DAY);
  const phase = ((seed % everyDays) + everyDays) % everyDays;
  return Math.floor((epochDay + phase) / everyDays) % 2 === 1;
}
