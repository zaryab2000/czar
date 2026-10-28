// SCR-146 §3.3 run 4 (SCR-150 §5): the CZ-15 pocket path on a CLEAN pinned arc-anvil with the SCR-150
// Gateway doubles, the real CZ-27 signer and the D92 `/v1/transfer` stand-in. Gateway routing stays off; the
// executor is driven directly. Every outcome is asserted on chain: events counted over the whole block range,
// and balances. Covers TA-21 halt drain (freeze, guardian pause) and SCR-127 §5 late funds on a Closed pocket.
// Run: CZAR_LOCAL_CHAIN=1 pnpm --filter @czar/server exec vitest run test/local-pocket/pocket-arc.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { czarVaultAbi, czarVaultFactoryAbi, withFeeFloor } from "@czar/vault-client";
import { setupDatabase } from "#test/db";
import { createDatabaseVaultEventSource } from "#src/payer/database-vault-event-source";
import { startPayerRuntime } from "#src/payer/runtime";
import { walletFor } from "#test/local-pocket/arc-chain";
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
const WAIT_TIMEOUT_MS = 60_000;
const WAIT_STEP_MS = 100;
const getPool = setupDatabase();
let harness: LocalPocketHarness;

describe.skipIf(!localChainEnabled)("pocket path on a local Arc chain (SCR-146 run 4)", () => {
  beforeAll(async () => {
    harness = await startLocalPocketHarness({ pool: getPool(), basePort: BASE_PORT });
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
    it("recovers a late Gateway deposit to free vault balance with one recovery pullback", async () => {
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
      expect(await harness.vaultEvents(plan.vault.vault, "PocketClosed", plan.pocket)).toHaveLength(
        1,
      );
    });
  });
});

async function withRuntime(body: () => Promise<void>): Promise<void> {
  const runtime = startPayerRuntime({
    events: createDatabaseVaultEventSource({
      pool: getPool(),
      publicClient: harness.chain.reader,
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
  expect((await pocketRecord(plan)).state).toBe(POCKET_CLOSED);
  expect(await harness.gatewayAvailable(plan.pocket)).toBe(DUST_STEP_CAP);
  return plan;
}

function confirmed(plan: PocketPlan) {
  return harness.vaultEvents(plan.vault.vault, "PullbackConfirmed", plan.pocket);
}

function pocketRecord(plan: PocketPlan) {
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
  const record = await pocketRecord(plan);
  expect(record.outstanding).toBe(FUNDED_STEP_CAP - value);
  expect(record.pendingPullback).toBe(0n);
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

function dustLimit(): bigint {
  return (
    BigInt(Number(harness.config.get("payer.pullbackMaxFeeAtomic"))) +
    BigInt(Number(harness.config.get("payer.pullbackSafetyAtomic")))
  );
}

function gatewayFee(): bigint {
  return BigInt(Number(harness.config.get("routing.gatewayFeeAtomic")));
}

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
  }
  throw new Error(`Condition not met in time; payer runtime errors: ${harness.errors.join(", ")}`);
}
