// SCR-146 §3.3 run 4 (SCR-150 §5): the CZ-15 pocket path on a CLEAN pinned arc-anvil with the SCR-150
// Gateway doubles, the real CZ-27 signer and the D92 `/v1/transfer` stand-in. Covers TA-21 (halt drain on
// freeze and on guardian pause, late funds, SCR-144 slow-path resume), TA-22a/b (manual-return ordering) and
// SCR-145 (overdue write-off), under SCR-152's one-ledger rules: a pocket return moves balanceOf − gasReserve
// and the EOA is "empty" when nothing is returnable, and SCR-153 §1: the slow path withdraws first and
// returns last, so the pocket's gas grant pays for initiate and withdraw. Gateway routing stays off; the executor is driven
// directly. "Kill" is in-process: the executor dies at an injected point and a fresh one resumes over the
// same database and chain. Every outcome is asserted on chain (events counted over the whole block range,
// balances), then on rows.
// Run: CZAR_LOCAL_CHAIN=1 pnpm --filter @czar/server exec vitest run test/local-pocket/pocket-arc.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseAbi, toFunctionSelector, type Address, type Hash, type Hex } from "viem";
import { czarVaultAbi, czarVaultFactoryAbi, withFeeFloor } from "@czar/vault-client";
import {
  createRpcTransactionPreparer,
  pocketReturnGasReserve,
  returnableAtomic,
} from "@czar/signer";
import { setupDatabase } from "#test/db";
import { createDatabaseVaultEventSource } from "#src/payer/database-vault-event-source";
import { createIndexerPocketReader } from "#src/payer/indexer-pocket";
import { startPayerRuntime } from "#src/payer/runtime";
import {
  ARC_CHAIN_ID,
  ARC_USDC,
  GATEWAY_WALLET,
  InjectedCrash,
  walletFor,
} from "#test/local-pocket/arc-chain";
import {
  localChainEnabled,
  startLocalPocketHarness,
  type LocalPocketHarness,
  type PocketPlan,
  type VaultFixture,
} from "#test/local-pocket/harness";

const BASE_PORT = 18620;
const FUNDED_STEP_CAP = 400_000n;
const FUNDED_CAP = 2_000_000n;
const DUST_STEP_CAP = 8_000n;
const DUST_CAP = 40_000n;
const LATE_DEPOSIT = 300_000n;
// ICzarVault.PocketState: None, Registered, Funded, Draining, Closed.
const POCKET_CLOSED = 4;
/** Passes allowed for one slow-path step: a SCR-152 value denial (the fee moved) is retried on the next pass. */
const MAX_PASSES = 5;
const FIRST_RECORD = 1_000n;
const SECOND_RECORD = 50_000n;
const WAIT_TIMEOUT_MS = 60_000;
const WAIT_STEP_MS = 100;
const MS_PER_HOUR = 3_600_000;
const MARGIN_MS = 60_000;
const withdrawSelector = toFunctionSelector("withdraw(address)");
const initiateSelector = toFunctionSelector("initiateWithdrawal(address,uint256)");
const transferSelector = toFunctionSelector("transfer(address,uint256)");
const walletDelayAbi = parseAbi(["function withdrawalDelay() view returns (uint256)"]);
const getPool = setupDatabase();
let harness: LocalPocketHarness;
/** Every K4 `pocket-return` request, with whether its row's `withdraw_tx` was mined (status 1) at that moment. */
const returnRequests: { readonly pocket: Address; readonly withdrawMined: boolean }[] = [];

describe.skipIf(!localChainEnabled)("pocket path on a local Arc chain (SCR-146 run 4)", () => {
  beforeAll(async () => {
    harness = await startLocalPocketHarness({ pool: getPool(), basePort: BASE_PORT });
    harness.signCrash.observe(async (request) => {
      if (request.kind !== "pocket-return") return;
      const pocket = (request.payload as { pocket: Address }).pocket;
      returnRequests.push({ pocket, withdrawMined: await withdrawMined(pocket) });
    });
  }, 300_000);

  afterAll(async () => {
    await harness?.stop();
  });

  describe("halt drain (TA-21)", () => {
    it("pulls a funded pocket back once after the owner freezes the vault", async () => {
      const vault = await harness.createVault();
      const plan = await fundedPocket(vault);
      const vaultBefore = await harness.usdcBalance(vault.vault);
      await withRuntime(async () => {
        await ownerFreeze(plan);
        await waitFor(async () => (await confirmed(plan)).length === 1);
      });
      expect(await harness.vaultEvents(vault.vault, "Frozen")).toHaveLength(1);
      await expectSingleCreditedPullback(plan, vaultBefore);
    });

    it("pulls a funded pocket back once after the guardian pauses the factory", async () => {
      const vault = await harness.createVault();
      const plan = await fundedPocket(vault);
      const vaultBefore = await harness.usdcBalance(vault.vault);
      try {
        await withRuntime(async () => {
          await guardianPause(true);
          await waitFor(async () => (await confirmed(plan)).length === 1);
        });
      } finally {
        await guardianPause(false);
      }
      expect(await harness.vaultEvents(vault.vault, "Frozen")).toHaveLength(0);
      await expectSingleCreditedPullback(plan, vaultBefore);
    });
  });

  describe("late funds on a Closed pocket (SCR-127 §5)", () => {
    it("recovers a late Gateway deposit to free vault balance through a recovery pullback", async () => {
      const plan = await dustClosedPocket(await harness.createVault());
      await harness.depositFor(plan.pocket, LATE_DEPOSIT);
      const vaultBefore = await harness.usdcBalance(plan.vault.vault);
      const available = await harness.gatewayAvailable(plan.pocket);
      expect(available).toBe(DUST_STEP_CAP + LATE_DEPOSIT);
      await harness.recovery().runClosedPocketRecovery();
      const requested = await harness.vaultEvents(
        plan.vault.vault,
        "PullbackRequested",
        plan.pocket,
      );
      expect(requested).toHaveLength(1);
      const value = requested[0]?.args["value"] as bigint;
      expect(value).toBe(available - dustLimit());
      const done = await confirmed(plan);
      expect(done).toHaveLength(1);
      expect(done[0]?.args["creditedToEnvelope"]).toBe(false);
      expect(await harness.attestations(plan.vault.vault)).toHaveLength(1);
      expect(await harness.usdcBalance(plan.vault.vault)).toBe(vaultBefore + value);
      expect(await harness.gatewayAvailable(plan.pocket)).toBe(available - value - gatewayFee());
      const record = await pocketRecord(plan);
      expect(record.state).toBe(POCKET_CLOSED);
      expect(record.outstanding).toBe(0n);
    });
  });

  describe("slow-path resume after a restart (SCR-144 §Tests)", () => {
    it("sends exactly one pocket-return after a crash between withdraw and pocket-return", async () => {
      const plan = await dustClosedPocket(await harness.createVault());
      await recoveryPass();
      expect(await harness.gatewayEvents("WithdrawalInitiated", plan.pocket)).toHaveLength(1);
      await mineWithdrawalDelay();
      const gasLeft = await harness.usdcBalance(plan.pocket);
      harness.chain.crash.arm({
        name: "after-withdraw-mined",
        when: "after-mined",
        match: (tx) =>
          tx.from.toLowerCase() === plan.pocket.toLowerCase() && tx.selector === withdrawSelector,
      });
      await recoveryPass();
      expect(harness.chain.crash.fired).toContain("after-withdraw-mined");
      expect(await harness.gatewayEvents("WithdrawalCompleted", plan.pocket)).toHaveLength(1);
      expect(await harness.usdcBalance(plan.pocket)).toBe(gasLeft + DUST_STEP_CAP);
      expect(await harness.gatewayAvailable(plan.pocket)).toBe(0n);
      const listed = await indexerReader().closedPocketsWithBalance();
      expect(listed.some((entry) => sameAddress(entry.pocket, plan.pocket))).toBe(false);
      expect(await harness.usdcTransfers(plan.pocket, plan.vault.vault)).toHaveLength(0);
      expect((await harness.row(plan))?.state).toBe("pending");

      await passUntil(plan, "returned-to-vault", recoveryPass);
      await expectSingleReturn(plan, DUST_STEP_CAP, "returned-to-vault");
    });

    it("does not transfer twice after a crash between a mined pocket-return and the row update", async () => {
      const plan = await dustClosedPocket(await harness.createVault());
      await recoveryPass();
      await mineWithdrawalDelay();
      const gasLeft = await harness.usdcBalance(plan.pocket);
      await recoveryPass();
      expect(await harness.gatewayEvents("WithdrawalCompleted", plan.pocket)).toHaveLength(1);
      expect(await harness.usdcBalance(plan.pocket)).toBeGreaterThan(gasLeft);
      harness.chain.crash.arm({
        name: "after-return-mined",
        when: "after-mined",
        match: (tx) =>
          tx.from.toLowerCase() === plan.pocket.toLowerCase() && tx.selector === transferSelector,
      });
      await recoveryPass();
      expect(harness.chain.crash.fired).toContain("after-return-mined");
      expect(await harness.usdcTransfers(plan.pocket, plan.vault.vault)).toHaveLength(1);
      const crashed = await harness.row(plan);
      expect(crashed?.state).toBe("pending");
      expect(crashed?.return_tx).toMatch(/^0x[0-9a-f]{64}$/);

      await passUntil(plan, "returned-to-vault", recoveryPass);
      await expectSingleReturn(plan, DUST_STEP_CAP, "returned-to-vault");
    });

    it("resumes from on-chain withdrawingBalance after a crash between the row and the initiate", async () => {
      const plan = await dustClosedPocket(await harness.createVault());
      harness.signCrash.arm({
        name: "before-initiate-signed",
        match: (request) => request.kind === "pocket-slow-withdraw" && isInitiate(request.payload),
      });
      await recoveryPass();
      expect(harness.signCrash.fired).toContain("before-initiate-signed");
      const written = await harness.row(plan);
      expect(written?.state).toBe("pending");
      expect(written?.closed_pocket).toBe(true);
      expect(written?.initiate_tx).toBeNull();
      expect(await harness.gatewayEvents("WithdrawalInitiated", plan.pocket)).toHaveLength(0);

      harness.chain.crash.arm({
        name: "after-initiate-mined",
        when: "after-mined",
        match: (tx) =>
          tx.from.toLowerCase() === plan.pocket.toLowerCase() && tx.selector === initiateSelector,
      });
      await recoveryPass();
      expect(harness.chain.crash.fired).toContain("after-initiate-mined");
      expect(await withdrawing(plan.pocket)).toBe(DUST_STEP_CAP);

      await recoveryPass();
      expect(await harness.gatewayEvents("WithdrawalInitiated", plan.pocket)).toHaveLength(1);
      expect(await harness.gatewayEvents("WithdrawalCompleted", plan.pocket)).toHaveLength(0);
      await mineWithdrawalDelay();
      await passUntil(plan, "returned-to-vault", recoveryPass);
      expect(await harness.gatewayEvents("WithdrawalInitiated", plan.pocket)).toHaveLength(1);
      expect(await harness.gatewayEvents("WithdrawalCompleted", plan.pocket)).toHaveLength(1);
      await expectSingleReturn(plan, DUST_STEP_CAP, "returned-to-vault");
    });
  });

  describe("manual return and overdue write-off (TA-22b, SCR-133, SCR-144 §2, SCR-145)", () => {
    let manual: PocketPlan;
    let deniedThenWrittenOff: PocketPlan;
    let recordedBeforeWriteOff: PocketPlan;
    let sameBlockRecord: Hex;

    beforeAll(async () => {
      manual = await fundedPocket(await harness.createVault());
      deniedThenWrittenOff = await fundedPocket(await harness.createVault());
      recordedBeforeWriteOff = await fundedPocket(await harness.createVault());
      const plans = [manual, deniedThenWrittenOff, recordedBeforeWriteOff];
      const before = new Map<PocketPlan, bigint>();
      for (const plan of plans) before.set(plan, await harness.usdcBalance(plan.vault.vault));
      const vaultBefore = { get: (plan: PocketPlan) => before.get(plan) ?? -1n };
      for (const plan of plans) await gatewayApiDown(plan);
      await harness.clock.advance(hours("payer.pullbackApiDownHours") + MARGIN_MS);
      await harness.runFallbacks();
      for (const plan of plans)
        expect(await harness.gatewayEvents("WithdrawalInitiated", plan.pocket)).toHaveLength(1);
      await mineWithdrawalDelay();
      await harness.runFallbacks();
      for (const plan of plans)
        expect(await harness.gatewayEvents("WithdrawalCompleted", plan.pocket)).toHaveLength(1);
      harness.chain.crash.arm({
        name: "record-in-return-block",
        when: "around-send",
        match: (tx) =>
          tx.from.toLowerCase() === manual.pocket.toLowerCase() && tx.selector === transferSelector,
        around: async (forward) => {
          await harness.chain.rpc("evm_setAutomine", [false]);
          try {
            sameBlockRecord = await sendRecordManualReturn(manual, FIRST_RECORD, { mine: false });
            const hash = await forward();
            await harness.chain.rpc("evm_mine", []);
            return hash;
          } finally {
            await harness.chain.rpc("evm_setAutomine", [true]);
          }
        },
      });
      for (const plan of plans)
        await passUntil(plan, "manual-return-required", harness.runFallbacks);
      expect(harness.chain.crash.fired).toContain("record-in-return-block");
      for (const plan of plans) {
        await expectSingleReturn(plan, FUNDED_STEP_CAP, "manual-return-required");
        await expectGatewayClear(plan);
        const returned = BigInt((await harness.row(plan))?.returned_amount ?? "0");
        expect(await harness.usdcBalance(plan.vault.vault)).toBe(vaultBefore.get(plan) + returned);
        expect((await harness.row(plan))?.manual_return_required_at).not.toBeNull();
      }
    }, 300_000);

    it("matches ManualReturnRecorded by (block, logIndex): a lower index in the return block does not match", async () => {
      const row = await harness.row(manual);
      const recordReceipt = await harness.chain.reader.getTransactionReceipt({
        hash: sameBlockRecord,
      });
      const sameBlock = await harness.vaultEvents(
        manual.vault.vault,
        "ManualReturnRecorded",
        manual.pocket,
      );
      expect(sameBlock).toHaveLength(1);
      expect(sameBlock[0]?.blockNumber).toBe(BigInt(row?.return_block ?? "-1"));
      expect(recordReceipt.blockNumber).toBe(BigInt(row?.return_block ?? "-1"));
      expect(sameBlock[0]?.logIndex).toBeLessThan(row?.return_log_index ?? -1);

      await harness.runManualReturnRecovery();
      const unmatched = await harness.row(manual);
      expect(unmatched?.state).toBe("manual-return-required");
      expect(unmatched?.recorded_tx).toBeNull();

      const later = await sendRecordManualReturn(manual, SECOND_RECORD, { mine: true });
      await harness.runManualReturnRecovery();
      const events = await harness.vaultEvents(
        manual.vault.vault,
        "ManualReturnRecorded",
        manual.pocket,
      );
      expect(events).toHaveLength(2);
      const matched = events.find((event) => event.transactionHash === later);
      expect(matched?.args["amount"]).toBe(SECOND_RECORD);
      const recorded = await harness.row(manual);
      expect(recorded?.state).toBe("recorded");
      expect(recorded?.recorded_tx).toBe(later);
      expect(recorded?.recorded_credit).toBe(SECOND_RECORD.toString());
      expect(
        await harness.vaultEvents(manual.vault.vault, "PocketClosed", manual.pocket),
      ).toHaveLength(0);
    });

    it("keeps an overdue row manual-return-required while the signer denies, then expires it once the write-off mines", async () => {
      const hold = hours("payer.manualReturnHoldHours") + MARGIN_MS;
      const deniedBefore = (await k3Audit("kms_denied")).filter(staleDenial).length;
      const writeOffErrorsBefore = writeOffErrors();
      // The signer's own clock (predicate 7: return block time <= now - hold) has not reached the hold
      // that CZ-15 measures from `manual_return_required_at`, so K3 refuses the stale-figure write-off.
      harness.clock.setSignerLag(hold);
      try {
        await harness.clock.advance(hold);
        await harness.runManualReturnRecovery();
        await harness.runManualReturnRecovery();
      } finally {
        harness.clock.setSignerLag(0);
      }
      const plan = deniedThenWrittenOff;
      expect(await harness.vaultEvents(plan.vault.vault, "PocketClosed", plan.pocket)).toHaveLength(
        0,
      );
      expect((await harness.row(plan))?.state).toBe("manual-return-required");
      // Two overdue rows (this one and recordedBeforeWriteOff), two passes: four refusals, no write-off.
      expect((await k3Audit("kms_denied")).filter(staleDenial).length - deniedBefore).toBe(4);
      expect(writeOffErrors() - writeOffErrorsBefore).toBe(4);
      // Predicates 2–6 and 8 hold for this row, and predicate 5 is SCR-152's "the EOA is empty": only the
      // signer's clock keeps predicate 7 false.
      await expectEoaEmpty(plan);
      expect((await harness.row(recordedBeforeWriteOff))?.state).toBe("manual-return-required");

      await recordManualReturnNow(recordedBeforeWriteOff);
      await harness.runManualReturnRecovery();
      const closed = await harness.vaultEvents(plan.vault.vault, "PocketClosed", plan.pocket);
      expect(closed).toHaveLength(1);
      expect(closed[0]?.args["writtenOff"]).toBe(FUNDED_STEP_CAP);
      expect((await harness.row(plan))?.state).toBe("expired");
      const signed = (await k3Audit("signed")).filter(
        (row) => row.rule === "writeoff-manual-return-overdue",
      );
      expect(signed).toHaveLength(1);
      expect(signed[0]?.digest).toMatch(/^0x[0-9a-f]{64}$/);
      expect((await pocketRecord(plan)).state).toBe(POCKET_CLOSED);
    });

    it("lets a recording that lands before the write-off win (recorded, no write-off)", async () => {
      const plan = recordedBeforeWriteOff;
      expect(await harness.vaultEvents(plan.vault.vault, "PocketClosed", plan.pocket)).toHaveLength(
        0,
      );
      const events = await harness.vaultEvents(
        plan.vault.vault,
        "ManualReturnRecorded",
        plan.pocket,
      );
      expect(events).toHaveLength(1);
      const row = await harness.row(plan);
      expect(row?.state).toBe("recorded");
      expect(row?.recorded_tx).toBe(events[0]?.transactionHash);
      expect((await pocketRecord(plan)).state).not.toBe(POCKET_CLOSED);
    });
  });

  describe("withdraw first, return last (SCR-153 §1)", () => {
    it("returns a closed dust pocket's Gateway balance and gas grant to the vault in that order", async () => {
      const plan = await dustClosedPocket(await harness.createVault());
      const vaultBefore = await harness.usdcBalance(plan.vault.vault);
      await recoveryPass();
      expect(await harness.gatewayEvents("WithdrawalInitiated", plan.pocket)).toHaveLength(1);
      expect(await harness.usdcTransfers(plan.pocket, plan.vault.vault)).toHaveLength(0);
      await mineWithdrawalDelay();
      await passUntil(plan, "returned-to-vault", recoveryPass);

      await expectSingleReturn(plan, DUST_STEP_CAP, "returned-to-vault");
      await expectGatewayClear(plan);
      const returned = BigInt((await harness.row(plan))?.returned_amount ?? "0");
      expect(await harness.usdcBalance(plan.vault.vault)).toBe(vaultBefore + returned);
      expect(await k4Order(plan.pocket)).toEqual([
        "initiate/withdraw",
        "initiate/withdraw",
        "return",
      ]);
    });

    it("resumes a closed dust pocket in order after a crash at each point, sending nothing twice", async () => {
      const plan = await dustClosedPocket(await harness.createVault());
      await crashWalk(plan, recoveryPass);
      await expectSingleReturn(plan, DUST_STEP_CAP, "returned-to-vault");
      await expectGatewayClear(plan);
    });

    it("resumes an API-down funded pocket in order after a crash at each point, sending nothing twice", async () => {
      const plan = await fundedPocket(await harness.createVault());
      await gatewayApiDown(plan);
      await harness.clock.advance(hours("payer.pullbackApiDownHours") + MARGIN_MS);
      await crashWalk(plan, harness.runFallbacks);
      await expectSingleReturn(plan, FUNDED_STEP_CAP, "manual-return-required");
      await expectGatewayClear(plan);
    });
  });

  describe("no pocket-return before a mined withdraw (SCR-153 §1 test)", () => {
    it("never requested a K4 pocket-return for a row whose withdraw_tx was not mined", async () => {
      const rows = await getPool().query<{ pocket: Address; withdraw_tx: string | null }>(
        `SELECT pocket,withdraw_tx FROM payer_pullback_gateway_failures
         WHERE initiate_tx IS NOT NULL OR return_tx IS NOT NULL ORDER BY pocket`,
      );
      // Every slow-path row in this run started with a Gateway figure above 0 (dust or a funded step):
      // three SCR-144 restarts, three manual returns, one clean dust return and two crash walks.
      expect(rows.rows).toHaveLength(9);
      expect(returnRequests.length).toBeGreaterThanOrEqual(rows.rows.length);
      expect(returnRequests.filter((request) => !request.withdrawMined)).toEqual([]);
      for (const row of rows.rows) {
        expect(row.withdraw_tx).toMatch(/^0x[0-9a-f]{64}$/);
        const order = await k4Order(row.pocket);
        expect(order).toEqual(["initiate/withdraw", "initiate/withdraw", "return"]);
      }
    });
  });
});

async function withRuntime(body: () => Promise<void>): Promise<void> {
  const runtime = startPayerRuntime({
    events: createDatabaseVaultEventSource({
      pool: getPool(),
      publicClient: harness.chain.payerClient,
      config: harness.config,
      logger: harness.logger,
    }),
    pocketHalt: harness.recovery().halt,
    onError: (operation) => harness.errors.push(operation),
  });
  try {
    await runtime.ready;
    await body();
  } finally {
    runtime.stop();
  }
}

async function fundedPocket(vault: VaultFixture): Promise<PocketPlan> {
  const plan = await harness.openPocketPlan(vault, { stepCap: FUNDED_STEP_CAP, cap: FUNDED_CAP });
  const prepared = await harness.preparePocket(plan);
  expect(prepared.funded).toBe(FUNDED_STEP_CAP.toString());
  expect(await harness.gatewayAvailable(plan.pocket)).toBe(FUNDED_STEP_CAP);
  return plan;
}

/** A pocket funded with dust and closed by the normal drain: write-off with a fresh figure ≤ the fee. */
async function dustClosedPocket(vault: VaultFixture): Promise<PocketPlan> {
  const plan = await harness.openPocketPlan(vault, { stepCap: DUST_STEP_CAP, cap: DUST_CAP });
  await harness.preparePocket(plan);
  await harness.recovery().halt.pullback(plan.pocket);
  expect(await harness.vaultEvents(vault.vault, "PocketClosed", plan.pocket)).toHaveLength(1);
  expect(await harness.vaultEvents(vault.vault, "PullbackRequested", plan.pocket)).toHaveLength(0);
  expect(await harness.gatewayAvailable(plan.pocket)).toBe(DUST_STEP_CAP);
  return plan;
}

/** SCR-127 trigger (a): the Gateway API fails after a good observation; the drain records the outage. */
async function gatewayApiDown(plan: PocketPlan): Promise<void> {
  await harness.standin.observe(plan.pocket);
  harness.standin.setGatewayApi(plan.pocket, "down");
  await expect(harness.recovery().halt.pullback(plan.pocket)).rejects.toThrow(
    "gateway-balance-stale",
  );
  const row = await harness.row(plan);
  expect(row?.state).toBe("pending");
  expect(row?.closed_pocket).toBe(false);
}

async function recoveryPass(): Promise<void> {
  await harness.recovery().runClosedPocketRecovery();
}

async function mineWithdrawalDelay(): Promise<void> {
  const delay = await harness.chain.reader.readContract({
    address: GATEWAY_WALLET,
    abi: walletDelayAbi,
    functionName: "withdrawalDelay",
  });
  await harness.chain.mine(Number(delay));
}

function withdrawing(pocket: Address): Promise<bigint> {
  return harness.chain.reader.readContract({
    address: GATEWAY_WALLET,
    abi: parseAbi([
      "function withdrawingBalance(address token, address depositor) view returns (uint256)",
    ]),
    functionName: "withdrawingBalance",
    args: [ARC_USDC, pocket],
  });
}

function confirmed(plan: PocketPlan) {
  return harness.vaultEvents(plan.vault.vault, "PullbackConfirmed", plan.pocket);
}

async function pocketRecord(plan: PocketPlan) {
  return harness.chain.reader.readContract({
    address: plan.vault.vault,
    abi: czarVaultAbi,
    functionName: "getPocket",
    args: [plan.pocket],
  });
}

async function expectSingleCreditedPullback(plan: PocketPlan, vaultBefore: bigint): Promise<void> {
  const requested = await harness.vaultEvents(plan.vault.vault, "PullbackRequested", plan.pocket);
  const done = await confirmed(plan);
  expect(requested).toHaveLength(1);
  expect(done).toHaveLength(1);
  const value = requested[0]?.args["value"] as bigint;
  expect(value).toBe(FUNDED_STEP_CAP - dustLimit());
  expect(done[0]?.args["creditedToEnvelope"]).toBe(true);
  expect(await harness.attestations(plan.vault.vault)).toHaveLength(1);
  expect(await harness.usdcBalance(plan.vault.vault)).toBe(vaultBefore + value);
  expect(await harness.gatewayAvailable(plan.pocket)).toBe(FUNDED_STEP_CAP - value - gatewayFee());
  expect((await pocketRecord(plan)).outstanding).toBe(FUNDED_STEP_CAP - value);
}

/**
 * Exactly one USDC transfer pocket → vault, of `balanceOf − gasReserve` of the signer's prepared transaction
 * (SCR-152 §1): the withdrawn amount plus whatever of the gas grant was returnable. Afterwards the EOA is empty
 * (§2) and the row holds that receipt's position.
 */
async function expectSingleReturn(
  plan: PocketPlan,
  withdrawn: bigint,
  state: "returned-to-vault" | "manual-return-required",
): Promise<void> {
  const transfers = await harness.usdcTransfers(plan.pocket, plan.vault.vault);
  expect(transfers).toHaveLength(1);
  const value = transfers[0]?.args["value"] as bigint;
  expect(value).toBeGreaterThanOrEqual(withdrawn);
  await expectEoaEmpty(plan);
  expect(await withdrawing(plan.pocket)).toBe(0n);
  const row = await harness.row(plan);
  expect(row?.state).toBe(state);
  expect(row?.return_tx).toBe(transfers[0]?.transactionHash);
  expect(row?.return_block).toBe(transfers[0]?.blockNumber.toString());
  expect(row?.return_log_index).toBe(transfers[0]?.logIndex);
  expect(row?.returned_amount).toBe(value.toString());
}

/** SCR-152 §2, computed as the signer and CZ-15 compute it, with the signer's own transaction preparer. */
async function expectEoaEmpty(plan: PocketPlan): Promise<void> {
  const preparer = createRpcTransactionPreparer({
    chainId: ARC_CHAIN_ID,
    client: harness.chain.reader,
  });
  const balance = await harness.usdcBalance(plan.pocket);
  expect(balance).toBeGreaterThan(0n);
  const { returnable } = await returnableAtomic(balance, (amount) =>
    pocketReturnGasReserve(preparer, {
      usdc: ARC_USDC,
      pocket: plan.pocket,
      vault: plan.vault.vault,
      amount,
    }),
  );
  expect(returnable).toBeLessThanOrEqual(0n);
}

/** Runs `pass` until the plan's row reaches `state`; a SCR-152 value denial waits for the next pass. */
async function passUntil(
  plan: PocketPlan,
  state: string,
  pass: () => Promise<unknown>,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_PASSES; attempt += 1) {
    if ((await harness.row(plan))?.state === state) return;
    await pass();
  }
  expect((await harness.row(plan))?.state).toBe(state);
}

function writeOffErrors(): number {
  return harness.errors.filter((error) => error === "manual-return-writeoff").length;
}

async function sendRecordManualReturn(
  plan: PocketPlan,
  amount: bigint,
  options: { mine: boolean },
): Promise<Hex> {
  const wallet = walletFor(harness.chain, plan.vault.owner);
  const gasPrice = await harness.chain.reader.getGasPrice();
  const hash = await wallet.writeContract({
    address: plan.vault.vault,
    abi: czarVaultAbi,
    functionName: "recordManualReturn",
    args: [plan.pocket, amount],
    gas: 200_000n,
    maxFeePerGas: gasPrice * 10n,
    maxPriorityFeePerGas: gasPrice * 5n,
  });
  if (options.mine) {
    const receipt = await harness.chain.reader.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
  }
  return hash;
}

async function recordManualReturnNow(plan: PocketPlan): Promise<void> {
  await sendRecordManualReturn(plan, SECOND_RECORD, { mine: true });
}

/** K3 `vault-call` audit rows (the signer's `postgresAudit` rows in the server `audit` table). */
async function k3Audit(outcome: "signed" | "kms_denied") {
  const rows = await getPool().query<{ rule: string | null; digest: string | null }>(
    `SELECT object_ids->0->>'rule' AS rule,object_ids->0->>'digest' AS digest FROM audit
     WHERE action='signer:vault-call' AND outcome=$1 AND object_ids->0->>'keyRef'='K3'
     ORDER BY at`,
    [outcome],
  );
  return rows.rows;
}

async function ownerFreeze(plan: PocketPlan): Promise<void> {
  const wallet = walletFor(harness.chain, plan.vault.owner);
  const hash = await wallet.writeContract({
    address: plan.vault.vault,
    abi: czarVaultAbi,
    functionName: "freeze",
    ...withFeeFloor({ maxFeePerGas: (await harness.chain.reader.getGasPrice()) * 2n }),
  });
  expect((await harness.chain.reader.waitForTransactionReceipt({ hash })).status).toBe("success");
}

async function guardianPause(paused: boolean): Promise<void> {
  const wallet = walletFor(harness.chain, harness.guardian);
  const hash = await wallet.writeContract({
    address: harness.chain.factory,
    abi: czarVaultFactoryAbi,
    functionName: paused ? "pause" : "unpause",
    ...withFeeFloor({ maxFeePerGas: (await harness.chain.reader.getGasPrice()) * 2n }),
  });
  expect((await harness.chain.reader.waitForTransactionReceipt({ hash })).status).toBe("success");
}

function indexerReader() {
  return createIndexerPocketReader(
    harness.standin.url,
    Number(harness.config.get("fetch.timeoutMs")),
  );
}

function isInitiate(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { step?: unknown }).step === "initiate"
  );
}

function staleDenial(row: { rule: string | null }): boolean {
  return row.rule === "gateway-balance-stale";
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function dustLimit(): bigint {
  return (
    BigInt(Number(harness.config.get("payer.pullbackMaxFeeAtomic"))) +
    BigInt(Number(harness.config.get("payer.pullbackSafetyAtomic")))
  );
}

function gatewayFee(): bigint {
  return BigInt(Number(harness.config.get("routing.gatewayFeeAtomic")));
}

function hours(key: "payer.pullbackApiDownHours" | "payer.manualReturnHoldHours"): number {
  return Number(harness.config.get(key)) * MS_PER_HOUR;
}

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
  }
  throw new Error(`Condition not met in time; payer errors: ${harness.errors.join(", ")}`);
}

/** Gateway available + withdrawing = 0 for the pocket (SCR-153 acceptance). */
async function expectGatewayClear(plan: PocketPlan): Promise<void> {
  expect((await harness.gatewayAvailable(plan.pocket)) + (await withdrawing(plan.pocket))).toBe(0n);
}

async function withdrawMined(pocket: Address): Promise<boolean> {
  const row = await getPool().query<{ withdraw_tx: string | null }>(
    "SELECT withdraw_tx FROM payer_pullback_gateway_failures WHERE lower(pocket)=lower($1)",
    [pocket],
  );
  const hash = row.rows[0]?.withdraw_tx;
  if (!hash) return false;
  try {
    const receipt = await harness.chain.reader.getTransactionReceipt({ hash: hash as Hash });
    return receipt.status === "success";
  } catch {
    return false;
  }
}

/** The pocket's signed K4 slow-path audit rows, in audit order (the signer audits before it returns). */
async function k4Order(pocket: Address): Promise<string[]> {
  const rows = await getPool().query<{ action: string }>(
    `SELECT action FROM audit
     WHERE action IN ('signer:pocket-slow-withdraw','signer:pocket-return') AND outcome='signed'
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(object_ids) AS ids
                   WHERE lower(ids->>'keyRef')=lower($1))
     ORDER BY audit_id`,
    [`K4:${pocket}`],
  );
  return rows.rows.map((row) =>
    row.action === "signer:pocket-return" ? "return" : "initiate/withdraw",
  );
}

/**
 * SCR-153 §1 acceptance: kill the payer (in process: an injected throw at the transport) after `initiate_tx`
 * is recorded, after it is mined, after `withdraw_tx` is recorded, after it is mined, and after `return_tx` is
 * recorded. Each restart resumes in order; the pocket sends exactly three transactions and K4 signs each once.
 */
async function crashWalk(plan: PocketPlan, pass: () => Promise<unknown>): Promise<void> {
  const nonceBefore = await harness.chain.reader.getTransactionCount({ address: plan.pocket });
  const fromPocket = (selector: Hex) => (tx: { from: Address; selector: Hex | null }) =>
    tx.from.toLowerCase() === plan.pocket.toLowerCase() && tx.selector === selector;
  const crashed = async (name: string, when: "before-send" | "after-mined", selector: Hex) => {
    harness.chain.crash.arm({ name, when, match: fromPocket(selector) });
    await pass().catch((error: unknown) => {
      if (!(error instanceof InjectedCrash)) throw error;
    });
    expect(harness.chain.crash.fired).toContain(name);
    return harness.row(plan);
  };
  const tag = plan.pocket.slice(2, 10);

  const initiateRecorded = await crashed(
    `${tag}-initiate-recorded`,
    "before-send",
    initiateSelector,
  );
  expect(initiateRecorded?.initiate_tx).toMatch(/^0x[0-9a-f]{64}$/);
  expect(await harness.gatewayEvents("WithdrawalInitiated", plan.pocket)).toHaveLength(0);

  const initiateMined = await crashed(`${tag}-initiate-mined`, "after-mined", initiateSelector);
  expect(initiateMined?.initiate_tx).toBe(initiateRecorded?.initiate_tx);
  expect(await harness.gatewayEvents("WithdrawalInitiated", plan.pocket)).toHaveLength(1);
  await pass();
  expect(await harness.gatewayEvents("WithdrawalCompleted", plan.pocket)).toHaveLength(0);
  await mineWithdrawalDelay();

  const withdrawRecorded = await crashed(
    `${tag}-withdraw-recorded`,
    "before-send",
    withdrawSelector,
  );
  expect(withdrawRecorded?.withdraw_tx).toMatch(/^0x[0-9a-f]{64}$/);
  expect(await harness.gatewayEvents("WithdrawalCompleted", plan.pocket)).toHaveLength(0);

  const withdrawDone = await crashed(`${tag}-withdraw-mined`, "after-mined", withdrawSelector);
  expect(withdrawDone?.withdraw_tx).toBe(withdrawRecorded?.withdraw_tx);
  expect(await harness.gatewayEvents("WithdrawalCompleted", plan.pocket)).toHaveLength(1);
  expect(await harness.usdcTransfers(plan.pocket, plan.vault.vault)).toHaveLength(0);

  const returnRecorded = await crashed(`${tag}-return-recorded`, "before-send", transferSelector);
  expect(returnRecorded?.return_tx).toMatch(/^0x[0-9a-f]{64}$/);
  expect(returnRecorded?.state).toBe("pending");
  expect(await harness.usdcTransfers(plan.pocket, plan.vault.vault)).toHaveLength(0);

  const terminal =
    plan.plan.cap === DUST_CAP.toString() ? "returned-to-vault" : "manual-return-required";
  await passUntil(plan, terminal, pass);
  expect(await harness.gatewayEvents("WithdrawalInitiated", plan.pocket)).toHaveLength(1);
  expect(await harness.gatewayEvents("WithdrawalCompleted", plan.pocket)).toHaveLength(1);
  expect(await harness.usdcTransfers(plan.pocket, plan.vault.vault)).toHaveLength(1);
  expect((await harness.row(plan))?.return_tx).toBe(returnRecorded?.return_tx);
  expect(await harness.chain.reader.getTransactionCount({ address: plan.pocket })).toBe(
    nonceBefore + 3,
  );
  expect(await k4Order(plan.pocket)).toEqual(["initiate/withdraw", "initiate/withdraw", "return"]);
}
