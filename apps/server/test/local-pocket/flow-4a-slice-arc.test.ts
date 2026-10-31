// SCR-160 §16: the Flow 4A end-to-end slice on a CLEAN pinned arc-anvil with the real CZ-27 signer and the
// D92 stand-ins. Two suppliers are paid through the real CZ-15 payer; the owner rates them through the same
// rating service the `czar result` prompt calls (POST /v1/ratings); counts refresh and the ranking flips; a
// supplier that settles and delivers nothing gets an H1 fact; one correction lands and a third rating is
// refused. Every payment is a real chain settlement: observations settle from the vault's `Settled` facts.
// Run: CZAR_LOCAL_CHAIN=1 pnpm --filter @czar/server exec vitest run test/local-pocket/flow-4a-slice-arc.test.ts
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "@czar/config";
import { paymentRefHash } from "@czar/hashing";
import type { StepResult } from "@czar/schemas";
import type { SafeFetch } from "@czar/x402";
import { keccak256 } from "viem";
import { setupDatabase } from "#test/db";
import { fillResponse } from "#src/evidence/observations";
import { openOwnerFacts } from "#src/evidence/health";
import { RatingRejected, submitRating, type RatingRequest } from "#src/evidence/ratings";
import { executeVaultDirectStep, type BoundaryInput } from "#src/payer/vault-direct";
import { createViemVaultDirectChain } from "#src/payer/viem-chain";
import { refreshSupplierCounts } from "#src/selection/ranking/counts";
import { rankingPolicyVersion } from "#src/selection/ranking/decision";
import { orderCandidates, type RankCandidate } from "#src/selection/ranking/order";
import { ARC_USDC } from "#test/local-pocket/arc-chain";
import {
  localChainEnabled,
  startLocalPocketHarness,
  type LocalPocketHarness,
  type VaultFixture,
} from "#test/local-pocket/harness";
import { openX402Plan, type X402Plan } from "#test/local-pocket/vault-direct-harness";
import { MERCHANT_ORIGIN } from "#test/local-pocket/x402-merchant";

const BASE_PORT = 18730;
// The steady supplier costs more, so unrated price order and rated order disagree: the flip is ratings-driven.
const STEADY_PRICE = 2_000n;
const FLAKY_PRICE = 1_000n;
const OFFER_TIMEOUT_SECONDS = 300;
const NETWORK = "eip155:5042002";
const CONFIDENCE_Z = 1.959964;
const CONSECUTIVE_FAILURES = 3;
const STEADY = `svc_${"a".repeat(32)}`;
const FLAKY = `svc_${"b".repeat(32)}`;
const getPool = setupDatabase();
let harness: LocalPocketHarness;

describe.skipIf(!localChainEnabled)("Flow 4A slice on a local Arc chain (SCR-160 §16)", () => {
  beforeAll(async () => {
    harness = await startLocalPocketHarness({
      pool: getPool(),
      basePort: BASE_PORT,
    });
  }, 300_000);

  afterAll(async () => {
    await harness?.stop();
  });

  it("rates two paid suppliers, flips the ranking, records H1, accepts one correction and refuses a third", async () => {
    const vault = await harness.createVault();

    // 1. Two objectives paid through the real payer; observations settle from chain facts.
    const steady = await supplierPlan(vault, STEADY, STEADY_PRICE, 1);
    const flaky = await supplierPlan(vault, FLAKY, FLAKY_PRICE, 1);
    expect((await pay(steady, "deliver")).state).toBe("done");
    expect((await pay(flaky, "deliver")).state).toBe("done");
    for (const plan of [steady, flaky]) {
      const rows = await observations(plan);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.settled).toBe(true);
      expect(rows[0]?.version_id).toMatch(/^ver_[0-9a-f]{32}$/);
      await deliver(plan);
    }

    // 2. Both suppliers start unrated: never ranked, listed for approval in price order (flaky first).
    let order = await rank(vault);
    expect(order.ranked).toEqual([]);
    expect(order.unverified.map((row) => row.service_id)).toEqual([FLAKY, STEADY]);
    expect(order.unverified.every((row) => row.reason === "unrated")).toBe(true);

    // 3. The owner rates through the rating service the CLI prompt calls.
    const steadyGood = await rate(vault, steady, { value: "good" });
    await rate(vault, flaky, { value: "bad" });
    order = await rank(vault);
    expect(order.ranked.map((row) => row.service_id)).toEqual([STEADY, FLAKY]);
    expect(order.ranked[0]?.score).toBeCloseTo(0.2065, 4);
    expect(order.ranked[1]?.score).toBe(0);

    // 4. A third objective with the flaky supplier settles three calls and delivers nothing: H1.
    const broken = await supplierPlan(vault, FLAKY, FLAKY_PRICE, CONSECUTIVE_FAILURES);
    await pay(broken, "empty");
    const settledUndelivered = (await observations(broken)).filter(
      (row) => row.settled && row.delivered === 0,
    );
    expect(settledUndelivered.length).toBeGreaterThan(0);
    expect(await openOwnerFacts(getPool(), vault.userId, NETWORK, FLAKY)).toContain(
      "settled-not-delivered",
    );
    order = await rank(vault);
    expect(order.ranked.find((row) => row.service_id === FLAKY)?.badges).toContain(
      "health-flagged",
    );

    // 5. One correction lands (steady good → bad): both score 0, so price order returns and the ranking
    // flips back to flaky first. A third rating is refused.
    await rate(vault, steady, { value: "bad", supersedes: steadyGood });
    order = await rank(vault);
    expect(order.ranked.map((row) => [row.service_id, row.score])).toEqual([
      [FLAKY, 0],
      [STEADY, 0],
    ]);
    const counts = await getPool().query<{ good: number; bad: number }>(
      "SELECT good,bad FROM supplier_counts WHERE network=$1 AND service_id=$2",
      [NETWORK, STEADY],
    );
    expect(counts.rows).toEqual([{ good: 0, bad: 1 }]);
    const effective = await getPool().query<{ rating_id: string }>(
      "SELECT rating_id FROM ratings_effective WHERE objective_id=$1",
      [await objectiveOf(steady)],
    );
    await expect(
      rate(vault, steady, {
        value: "good",
        supersedes: effective.rows[0]!.rating_id,
      }),
    ).rejects.toMatchObject({ code: "bad-supersedes" });
  }, 600_000);
});

/** A one-step plan for `serviceId` with `calls` paid calls; the step row carries the service id. */
async function supplierPlan(
  vault: VaultFixture,
  serviceId: string,
  unitAmount: bigint,
  calls: number,
): Promise<X402Plan> {
  const plan = await openX402Plan(harness, vault, {
    unitAmount,
    calls,
    maxTimeoutSeconds: OFFER_TIMEOUT_SECONDS,
  });
  const step = { ...plan.input.step, serviceId };
  await getPool().query("UPDATE steps SET step=$2::jsonb WHERE plan_id=$1 AND step_index=0", [
    plan.planId,
    JSON.stringify(step),
  ]);
  return { ...plan, input: { ...plan.input, step } };
}

/**
 * Runs the real payer. `deliver`: the seller's settled response is usable. `empty`: the seller settles and
 * returns an empty 200 body, which the CZ-16 delivery check fails (delivered = 0), as in production.
 */
function pay(plan: X402Plan, mode: "deliver" | "empty") {
  const fetch: SafeFetch = async (url, options) => {
    const response = await plan.merchant.fetch(url, options);
    if (mode === "empty" && typeof options?.headers?.["payment-signature"] === "string")
      return { ...response, body: new Uint8Array() };
    return response;
  };
  return executeVaultDirectStep(plan.input, {
    pool: harness.pool,
    config: harness.config,
    signer: harness.signer.signer,
    chain: createViemVaultDirectChain({
      client: harness.chain.payerClient,
      vault: plan.vault.vault,
      usdc: ARC_USDC,
    }),
    safeFetch: fetch,
    now: () => harness.clock.now(),
    sleep: (milliseconds) => harness.clock.advance(milliseconds),
    boundary: async (context) => boundary(context),
    recordReceipt: async () => true,
    objects: plan.objects,
  });
}

/** Mirrors the production boundary's observation write: delivery pass → 1, fail → 0 (main.ts). */
async function boundary(context: BoundaryInput): Promise<StepResult> {
  const usable =
    context.response.status >= 200 &&
    context.response.status < 300 &&
    context.response.body.byteLength > 0;
  await fillResponse(harness.pool, context.obsId, harness.clock.now(), usable ? 1 : 0);
  return {
    schemaVersion: "1.1",
    stepIndex: context.input.step.stepIndex,
    callIndex: context.index,
    obsId: context.obsId,
    status: usable ? "delivered" : "http-error",
    source: {
      origin: MERCHANT_ORIGIN,
      payTo: context.paymentPayload.payload.authorization.to,
      paymentRefHash: paymentRefHash(context.paymentRef as unknown as Record<string, unknown>),
    },
    fields: [],
    flags: [],
    bodyCommit: keccak256(context.response.body),
  };
}

/** Writes the delivered result the way CZ-15 completion does: provenance names the producing step. */
async function deliver(plan: X402Plan): Promise<void> {
  const objectiveId = await objectiveOf(plan);
  const resultId = `res_${randomBytes(16)
    .toString("hex")
    .toUpperCase()
    .replace(/[ILOU]/g, "A")
    .slice(0, 26)}`;
  await getPool().query(
    `INSERT INTO results(result_id,objective_id,rendered_body,provenance,created_at)
     VALUES($1,$2,'{}',$3::jsonb,$4)`,
    [
      resultId,
      objectiveId,
      JSON.stringify([
        {
          stepIndex: 0,
          origin: MERCHANT_ORIGIN,
          paymentRefHash: `0x${"0".repeat(64)}`,
          accepted: true,
        },
      ]),
      harness.clock.now(),
    ],
  );
  await getPool().query(
    "UPDATE objectives SET state='delivered',result_id=$2 WHERE objective_id=$1",
    [objectiveId, resultId],
  );
}

async function rate(
  vault: VaultFixture,
  plan: X402Plan,
  request: Omit<RatingRequest, "objectiveId" | "stepIndex">,
): Promise<string> {
  const body: RatingRequest = {
    objectiveId: await objectiveOf(plan),
    stepIndex: 0,
    ...request,
  };
  try {
    const outcome = await submitRating(getPool(), loadConfig(), {
      userId: vault.userId,
      surface: "cli",
      request: body,
      rawBody: Buffer.from(JSON.stringify(body)),
      key: randomUUID(),
      now: harness.clock.now(),
      random: { bytes: (length) => randomBytes(length) },
    });
    return outcome.accepted.ratingId;
  } catch (error) {
    if (error instanceof RatingRejected) throw { code: error.code, status: error.status };
    throw error;
  }
}

/** Refreshes counts and orders both suppliers at their current versions, as CZ-18 does per query. */
async function rank(vault: VaultFixture) {
  const policyVersion = rankingPolicyVersion({
    confidenceZ: CONFIDENCE_Z,
    consecutiveFailures: CONSECUTIVE_FAILURES,
  });
  await refreshSupplierCounts({
    pool: getPool(),
    network: NETWORK,
    policyVersion,
    confidenceZ: CONFIDENCE_Z,
    workerId: "flow-4a-slice",
    leaseSeconds: 30,
    now: harness.clock.now(),
  });
  const candidates: RankCandidate[] = [];
  for (const [serviceId, price] of [
    [STEADY, STEADY_PRICE],
    [FLAKY, FLAKY_PRICE],
  ] as const) {
    const version = await getPool().query<{ version_id: string }>(
      `SELECT version_id FROM observations WHERE service_id=$1 AND version_id<>'ver_unknown'
       ORDER BY created_at DESC LIMIT 1`,
      [serviceId],
    );
    const versionId = version.rows[0]!.version_id;
    const count = await getPool().query<{
      good: number;
      bad: number;
      owners_rated: number;
      owners_bad: number;
      lower_bound: number | null;
    }>(
      `SELECT good,bad,owners_rated,owners_bad,lower_bound FROM supplier_counts
       WHERE network=$1 AND service_id=$2 AND version_id=$3`,
      [NETWORK, serviceId, versionId],
    );
    const row = count.rows[0];
    candidates.push({
      serviceId,
      versionId,
      priceAtomic: price.toString(),
      good: row?.good ?? 0,
      bad: row?.bad ?? 0,
      lowerBound: row?.lower_bound ?? null,
      ownersRated: row?.owners_rated ?? 0,
      ownersBad: row?.owners_bad ?? 0,
      computedAt: harness.clock.now(),
      healthFacts: await openOwnerFacts(getPool(), vault.userId, NETWORK, serviceId),
      injectionBlocked: false,
    });
  }
  return orderCandidates(candidates, CONFIDENCE_Z, harness.clock.now(), CONSECUTIVE_FAILURES);
}

async function observations(plan: X402Plan) {
  const rows = await getPool().query<{
    settled: boolean;
    delivered: number | null;
    version_id: string;
  }>(
    `SELECT settled_at IS NOT NULL AS settled,delivered,version_id FROM observations
     WHERE objective_id=$1 ORDER BY call_index`,
    [await objectiveOf(plan)],
  );
  return rows.rows;
}

async function objectiveOf(plan: X402Plan): Promise<string> {
  const row = await getPool().query<{ objective_id: string }>(
    "SELECT objective_id FROM plans WHERE plan_id=$1",
    [plan.planId],
  );
  return row.rows[0]!.objective_id;
}
