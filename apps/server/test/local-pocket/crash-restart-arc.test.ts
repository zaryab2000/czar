// SCR-146 §3.3 run 5 (SCR-150 §5): kill and resume the CZ-15 payer on a CLEAN pinned arc-anvil with the
// SCR-150 Gateway doubles, the real CZ-27 signer and the D92 stand-ins. Kill points: reserve.sent, call.sent,
// before settle, between /v1/transfer and gatewayMint, and after an expired lease.
// "Kill" is in-process: the executor is aborted at an injected point (a raw transaction is dropped before the
// node or the payer dies right after it is mined; the seller or `/v1/transfer` answers and the payer dies
// before reading it), the instance is dropped, and a fresh executor resumes over the same database and chain.
// Every outcome is counted on chain over the whole block range: one Reserved, one AuthorizationUsed and one
// transfer per index, one Settled per index, one burn and one AttestationUsed per pullback.
// Run: CZAR_LOCAL_CHAIN=1 pnpm --filter @czar/server exec vitest run test/local-pocket/crash-restart-arc.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAbiItem, parseAbi, toFunctionSelector, type Address } from "viem";
import { derivedNonce } from "@czar/hashing";
import { czarVaultAbi } from "@czar/vault-client";
import { setupDatabase } from "#test/db";
import { getExecutionTrace } from "#src/payer/executions";
import {
  ARC_USDC,
  GATEWAY_MINTER,
  GATEWAY_WALLET,
  type OutgoingTransaction,
} from "#test/local-pocket/arc-chain";
import {
  localChainEnabled,
  startLocalPocketHarness,
  type LocalPocketHarness,
  type PocketPlan,
} from "#test/local-pocket/harness";
import {
  executeX402,
  holdLeaseAsKilledWorker,
  openX402Plan,
  type X402Plan,
} from "#test/local-pocket/vault-direct-harness";

const BASE_PORT = 18630;
const UNIT_AMOUNT = 1_000n;
const CALLS = 2;
/**
 * The seller's `maxTimeoutSeconds` for the case whose lease wait must outlive `validBefore`: above the vault's
 * `MIN_RESERVATION_TTL` (30 s), so a reserve mined a few seconds after it was signed is still inside the TTL
 * window, and below `payer.leaseSeconds` (60 s).
 */
const SHORT_TIMEOUT_SECONDS = 45;
/**
 * Every other case. A reserve that is re-sent after a kill must still satisfy
 * `validBefore >= block.timestamp + MIN_RESERVATION_TTL`; with a 30 s seller timeout it has no slack and
 * reverts `BadTtl` if it mines a second later.
 */
const LONG_TIMEOUT_SECONDS = 300;
/** viem wraps the transport error, so match the injected crash by message. */
const KILLED = "injected crash";
const FUNDED_STEP_CAP = 400_000n;
const FUNDED_CAP = 2_000_000n;
const MS_PER_SECOND = 1000;
const reserveSelector = toFunctionSelector(getAbiItem({ abi: czarVaultAbi, name: "reserve" }));
const settleSelector = toFunctionSelector(getAbiItem({ abi: czarVaultAbi, name: "settle" }));
const mintSelector = toFunctionSelector("gatewayMint(bytes,bytes)");
const usdcEventsAbi = parseAbi([
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const getPool = setupDatabase();
let harness: LocalPocketHarness;

describe.skipIf(!localChainEnabled)(
  "payer kill and resume on a local Arc chain (SCR-146 run 5)",
  () => {
    beforeAll(async () => {
      harness = await startLocalPocketHarness({ pool: getPool(), basePort: BASE_PORT });
    }, 300_000);

    afterAll(async () => {
      await harness?.stop();
    });

    describe("vault-direct x402 step (TA-09)", () => {
      it("resumes after a kill at reserve.sent once the reserve transaction has mined", async () => {
        const plan = await x402Plan();
        harness.chain.crash.arm({
          name: "reserve-mined",
          when: "after-mined",
          match: sentTo(plan, reserveSelector),
        });
        await expect(executeX402(harness, plan)).rejects.toThrow(KILLED);
        expect(await phases(plan)).toContain("reserve.sent");
        expect(await phases(plan)).not.toContain("reserve.mined");
        expect(await reservedEvents(plan)).toHaveLength(1);

        expect((await executeX402(harness, plan)).state).toBe("done");
        await expectPaidExactlyOnce(plan);
      });

      it("resumes after a kill at reserve.sent before the signed reserve reached the node", async () => {
        const plan = await x402Plan();
        harness.chain.crash.arm({
          name: "reserve-unsent",
          when: "before-send",
          match: sentTo(plan, reserveSelector),
        });
        await expect(executeX402(harness, plan)).rejects.toThrow(KILLED);
        expect(await phases(plan)).toContain("reserve.sent");
        expect(await reservedEvents(plan)).toHaveLength(0);

        expect((await executeX402(harness, plan)).state).toBe("done");
        await expectPaidExactlyOnce(plan);
      });

      it("resumes after a kill at call.sent once the seller has settled the payment", async () => {
        const plan = await x402Plan();
        plan.merchant.armCrashAfterSettle();
        await expect(executeX402(harness, plan)).rejects.toThrow(KILLED);
        expect(await phases(plan)).toContain("call.sent");
        expect(await phases(plan)).not.toContain("call.result");
        expect(await authorizationsUsed(plan)).toHaveLength(1);

        expect((await executeX402(harness, plan)).state).toBe("done");
        await expectPaidExactlyOnce(plan);
        expect(plan.merchant.settlements()).toBe(CALLS);
      });

      it("resumes after a kill before settle is sent", async () => {
        const plan = await x402Plan();
        harness.chain.crash.arm({
          name: "settle-unsent",
          when: "before-send",
          match: sentTo(plan, settleSelector),
        });
        await expect(executeX402(harness, plan)).rejects.toThrow(KILLED);
        expect(await phases(plan)).toContain("settle.sent");
        expect(await settledEvents(plan)).toHaveLength(0);
        expect(await authorizationsUsed(plan)).toHaveLength(CALLS);

        expect((await executeX402(harness, plan)).state).toBe("done");
        await expectPaidExactlyOnce(plan);
      });

      it("waits out the killed worker's lease, then resumes exactly once", async () => {
        const plan = await x402Plan();
        await killWithLeaseHeld(plan);
        await waitOutLease();
        expect((await executeX402(harness, plan, "fresh-worker")).state).toBe("done");
        await expectPaidExactlyOnce(plan);
      });

      it("after a lease that outlived validBefore, settles the paid call once and releases the other", async () => {
        const plan = await x402Plan(SHORT_TIMEOUT_SECONDS);
        await killWithLeaseHeld(plan);
        await waitOutLease();
        expect(await executeX402(harness, plan, "fresh-worker")).toEqual({
          state: "failed",
          errorCode: "unpaid-index",
        });
        const reserved = await reservedEvents(plan);
        expect(reserved).toHaveLength(1);
        expect(await authorizationsUsed(plan)).toHaveLength(1);
        expect(await usdcTransfers(plan.vault.vault, plan.merchant.payTo)).toHaveLength(1);
        expect((await settledEvents(plan)).map((event) => event.args.index)).toEqual([0]);
        const released = await harness.chain.reader.getContractEvents({
          address: plan.vault.vault,
          abi: czarVaultAbi,
          eventName: "Released",
          fromBlock: 0n,
        });
        expect(released.map((event) => event.args.index)).toEqual([1]);
        const final = await finalEvents(plan);
        expect(final).toHaveLength(1);
        expect(final[0]?.args.settledCount).toBe(1);
        expect(final[0]?.args.releasedCount).toBe(1);
        const envelope = await envelopeOf(plan);
        expect(envelope.spent).toBe(UNIT_AMOUNT);
        expect(envelope.reserved).toBe(0n);
      });
    });

    describe("pocket pullback mint (TA-21)", () => {
      it("burns and mints once after a kill between /v1/transfer and gatewayMint", async () => {
        const plan = await fundedPocket();
        const burnsBefore = (await burns()).length;
        harness.transferCrash.armAfterResponse();
        await expect(harness.recovery().halt.pullback(plan.pocket)).rejects.toThrow(KILLED);
        expect(harness.transferCrash.fired()).toBe(1);
        expect((await burns()).length - burnsBefore).toBe(1);
        expect(await harness.attestations(plan.vault.vault)).toHaveLength(0);

        await harness.recovery().halt.pullback(plan.pocket);
        expect((await burns()).length - burnsBefore).toBe(1);
        await expectPulledBackOnce(plan);
      });

      it("does not mint twice after a kill once gatewayMint has mined", async () => {
        const plan = await fundedPocket();
        harness.chain.crash.arm({
          name: "mint-mined",
          when: "after-mined",
          match: (tx) => tx.to?.toLowerCase() === GATEWAY_MINTER && tx.selector === mintSelector,
        });
        await expect(harness.recovery().halt.pullback(plan.pocket)).rejects.toThrow(KILLED);
        expect(await harness.attestations(plan.vault.vault)).toHaveLength(1);
        expect(
          await harness.vaultEvents(plan.vault.vault, "PullbackConfirmed", plan.pocket),
        ).toHaveLength(0);

        await harness.recovery().halt.pullback(plan.pocket);
        await expectPulledBackOnce(plan);
      });
    });
  },
);

async function x402Plan(maxTimeoutSeconds = LONG_TIMEOUT_SECONDS): Promise<X402Plan> {
  return openX402Plan(harness, await harness.createVault(), {
    unitAmount: UNIT_AMOUNT,
    calls: CALLS,
    maxTimeoutSeconds,
  });
}

/** Kill after the seller settled call 0, leaving the lease the killed worker held (no `finally` on SIGKILL). */
async function killWithLeaseHeld(plan: X402Plan): Promise<void> {
  plan.merchant.armCrashAfterSettle();
  await expect(executeX402(harness, plan, "killed-worker")).rejects.toThrow(KILLED);
  await holdLeaseAsKilledWorker(harness, plan, "killed-worker");
  const blockBefore = await harness.chain.reader.getBlockNumber();
  expect(await executeX402(harness, plan, "fresh-worker")).toEqual({
    state: "failed",
    errorCode: "executor-lease-held",
  });
  expect(await harness.chain.reader.getBlockNumber()).toBe(blockBefore);
  expect(await authorizationsUsed(plan)).toHaveLength(1);
}

async function waitOutLease(): Promise<void> {
  const leaseMs = Number(harness.config.get("payer.leaseSeconds")) * MS_PER_SECOND;
  await harness.clock.advance(leaseMs + MS_PER_SECOND);
}

function finalEvents(plan: X402Plan) {
  return harness.chain.reader.getContractEvents({
    address: plan.vault.vault,
    abi: czarVaultAbi,
    eventName: "ReservationFinal",
    fromBlock: 0n,
  });
}

function envelopeOf(plan: X402Plan) {
  return harness.chain.reader.readContract({
    address: plan.vault.vault,
    abi: czarVaultAbi,
    functionName: "getEnvelope",
    args: [plan.envelopeId],
  });
}

async function fundedPocket(): Promise<PocketPlan> {
  const plan = await harness.openPocketPlan(await harness.createVault(), {
    stepCap: FUNDED_STEP_CAP,
    cap: FUNDED_CAP,
  });
  await harness.preparePocket(plan);
  expect(await harness.gatewayAvailable(plan.pocket)).toBe(FUNDED_STEP_CAP);
  return plan;
}

function sentTo(plan: X402Plan, selector: string) {
  return (tx: OutgoingTransaction) =>
    tx.to?.toLowerCase() === plan.vault.vault.toLowerCase() && tx.selector === selector;
}

async function phases(plan: X402Plan): Promise<string[]> {
  return (await getExecutionTrace(getPool(), plan.planId, 0, 0)).map((row) => row.phase);
}

async function reservedEvents(plan: X402Plan) {
  return harness.chain.reader.getContractEvents({
    address: plan.vault.vault,
    abi: czarVaultAbi,
    eventName: "Reserved",
    args: { envelopeId: plan.envelopeId },
    fromBlock: 0n,
  });
}

async function settledEvents(plan: X402Plan) {
  return harness.chain.reader.getContractEvents({
    address: plan.vault.vault,
    abi: czarVaultAbi,
    eventName: "Settled",
    fromBlock: 0n,
  });
}

async function authorizationsUsed(plan: X402Plan) {
  return harness.chain.reader.getContractEvents({
    address: ARC_USDC,
    abi: usdcEventsAbi,
    eventName: "AuthorizationUsed",
    args: { authorizer: plan.vault.vault },
    fromBlock: 0n,
  });
}

async function usdcTransfers(from: Address, to: Address) {
  return harness.chain.reader.getContractEvents({
    address: ARC_USDC,
    abi: usdcEventsAbi,
    eventName: "Transfer",
    args: { from, to },
    fromBlock: 0n,
  });
}

/** Gateway double burns: the stand-in's `testBurnForTransferSpec` moves value + fee wallet → minter. */
function burns() {
  return usdcTransfers(GATEWAY_WALLET, GATEWAY_MINTER);
}

async function expectPaidExactlyOnce(plan: X402Plan): Promise<void> {
  const reserved = await reservedEvents(plan);
  expect(reserved).toHaveLength(1);
  const reservationId = reserved[0]?.args.reservationId;
  if (reservationId === undefined) throw new Error("Reserved event has no reservation id.");
  const used = await authorizationsUsed(plan);
  expect(used).toHaveLength(CALLS);
  expect(new Set(used.map((event) => event.args.nonce))).toEqual(
    new Set(
      Array.from({ length: CALLS }, (_, index) =>
        derivedNonce(plan.vault.vault, reservationId, index),
      ),
    ),
  );
  const paid = await usdcTransfers(plan.vault.vault, plan.merchant.payTo);
  expect(paid.map((event) => event.args.value)).toEqual(Array(CALLS).fill(UNIT_AMOUNT));
  const settled = await settledEvents(plan);
  expect(settled.map((event) => event.args.index).toSorted()).toEqual(
    Array.from({ length: CALLS }, (_, index) => index),
  );
  const final = await finalEvents(plan);
  expect(final).toHaveLength(1);
  expect(final[0]?.args.settledCount).toBe(CALLS);
  const envelope = await envelopeOf(plan);
  expect(envelope.spent).toBe(UNIT_AMOUNT * BigInt(CALLS));
  expect(envelope.reserved).toBe(0n);
  const step = await getPool().query<{ state: string; calls_used: number }>(
    "SELECT state,calls_used FROM steps WHERE plan_id=$1 AND step_index=0",
    [plan.planId],
  );
  expect(step.rows[0]).toEqual({ state: "done", calls_used: CALLS });
}

async function expectPulledBackOnce(plan: PocketPlan): Promise<void> {
  const requested = await harness.vaultEvents(plan.vault.vault, "PullbackRequested", plan.pocket);
  expect(requested).toHaveLength(1);
  const value = requested[0]?.args["value"] as bigint;
  expect(await harness.attestations(plan.vault.vault)).toHaveLength(1);
  const confirmed = await harness.vaultEvents(plan.vault.vault, "PullbackConfirmed", plan.pocket);
  expect(confirmed).toHaveLength(1);
  expect(confirmed[0]?.args["creditedToEnvelope"]).toBe(true);
  const fee = BigInt(Number(harness.config.get("routing.gatewayFeeAtomic")));
  expect(await harness.gatewayAvailable(plan.pocket)).toBe(FUNDED_STEP_CAP - value - fee);
  expect(await usdcTransfers(GATEWAY_MINTER, plan.vault.vault)).toHaveLength(1);
}
