import { createHash } from "node:crypto";
import type { Config } from "@czar/config";
import { jcsString } from "@czar/hashing";
import type { Result } from "@czar/schemas";
import type { Pool, PoolClient } from "pg";
import { findOrCreateIdempotency, fingerprintRequest } from "#src/http/idempotency";
import { ulid, type RandomSource } from "#src/http/ids";
import type { CzarCode } from "#src/http/problem";

export interface RatingRequest {
  readonly objectiveId: string;
  readonly stepIndex: number;
  readonly value: "good" | "bad";
  readonly supersedes?: string;
}

export interface RatingAccepted {
  readonly ratingId: string;
  readonly objectiveId: string;
  readonly stepIndex: number;
  readonly value: "good" | "bad";
  readonly receipts: number;
  readonly windowClosesAt: string;
}

export class RatingRejected extends Error {
  readonly status: number;
  readonly code: CzarCode;

  constructor(status: number, code: CzarCode) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

interface RatingInput {
  readonly userId: string;
  readonly surface: "cli" | "web";
  readonly request: RatingRequest;
  readonly rawBody: Buffer;
  readonly key: string;
  readonly now: Date;
  readonly random: RandomSource;
}

interface OwnerResult {
  readonly controlled: boolean;
  readonly envelope_ref: string | null;
  readonly plan: {
    readonly steps?: readonly { readonly stepIndex: number; readonly payee: string }[];
  } | null;
  readonly provenance: Result["provenance"];
  readonly created_at: Date;
}

interface EligibleObservation {
  readonly obs_id: string;
  readonly user_id: string;
  readonly vault: string;
  readonly envelope_ref: string;
  readonly rail: string;
  readonly dedup_key: string;
  readonly network: string;
  readonly service_id: string;
  readonly version_id: string;
  readonly task_class: string;
}

interface EffectiveRating {
  readonly rating_id: string;
  readonly user_id: string;
  readonly supersedes: string | null;
}

/** Store one owner rating and its settled receipts as one transaction. */
export async function submitRating(
  pool: Pool,
  config: Config,
  input: RatingInput,
): Promise<{
  readonly accepted: RatingAccepted;
  readonly correction: boolean;
  readonly replayed: boolean;
}> {
  const client = await pool.connect();
  let outcome: Awaited<ReturnType<typeof submitWithinTransaction>>;
  try {
    await client.query("BEGIN");
    outcome = await submitWithinTransaction(client, config, input);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  if (!outcome.replayed) requestRankingRefresh(outcome.accepted);
  return outcome;
}

interface RankingRefreshHandler {
  readonly signal: () => void;
  readonly onError: (error: unknown) => void;
}

const rankingRefreshHandlers = new Set<RankingRefreshHandler>();

/** Registers a process-local refresh signal; periodic workers cover restarts. */
export function registerRankingRefreshHandler(
  signal: () => void,
  onError: (error: unknown) => void,
): () => void {
  const handler = { signal, onError };
  rankingRefreshHandlers.add(handler);
  return () => rankingRefreshHandlers.delete(handler);
}

export function requestRankingRefresh(_accepted: RatingAccepted): void {
  for (const handler of rankingRefreshHandlers) {
    try {
      handler.signal();
    } catch (error) {
      handler.onError(error);
    }
  }
}

async function submitWithinTransaction(
  client: PoolClient,
  config: Config,
  input: RatingInput,
): Promise<{
  readonly accepted: RatingAccepted;
  readonly correction: boolean;
  readonly replayed: boolean;
}> {
  const owner = await loadOwnerResult(client, input);
  if (owner.controlled) throw new RatingRejected(403, "controlled-user");
  if (
    !owner.provenance.some((entry) => entry.stepIndex === input.request.stepIndex && entry.accepted)
  )
    throw new RatingRejected(422, "not-producing");
  const payee = owner.plan?.steps?.find(
    (step) => step.stepIndex === input.request.stepIndex,
  )?.payee;
  const settled = await loadEligibleObservations(client, input.request);
  if (settled.length === 0) throw new RatingRejected(409, "nothing-settled");
  assertPayingVault(settled, owner.envelope_ref, input.userId);
  const observations = settled.filter((observation) => isAttributedToPayee(observation, payee));
  if (observations.length === 0) throw new RatingRejected(409, "nothing-settled");
  const windowClosesAt = new Date(
    owner.created_at.getTime() + Number(config.get("rating.windowDays")) * 86_400_000,
  );
  const scope = [
    "submitRating",
    input.userId,
    input.request.objectiveId,
    input.request.stepIndex,
  ].join(":");
  const fingerprint = fingerprintRequest(input.rawBody);
  const saved = await findOrCreateIdempotency(client, config, {
    scope,
    key: input.key,
    fingerprint,
    now: input.now,
  });
  if (!saved.fingerprint.equals(fingerprint)) throw new RatingRejected(409, "idempotency-conflict");
  if (saved.status !== null) {
    if (
      saved.status !== 202 ||
      !saved.response_body ||
      !saved.response_hash ||
      !sameHash(saved.response_body, saved.response_hash)
    )
      throw new RatingRejected(409, "replay-not-stored");
    return {
      accepted: saved.response_body as unknown as RatingAccepted,
      correction: input.request.supersedes !== undefined,
      replayed: true,
    };
  }
  if (input.now.getTime() > windowClosesAt.getTime())
    throw new RatingRejected(409, "window-closed");
  const previous = await loadEffectiveRating(client, input.request);
  validateSupersedes(previous, input);
  const reference = observations[0];
  if (!reference) throw new Error("Eligible rating observation disappeared.");
  assertOneSupplier(observations, reference);
  const ratingId = ulid("rtg_", input.now, input.random);
  await insertRating(client, ratingId, input, reference);
  await bindReceipts(client, ratingId, input.request.supersedes, observations);
  await client.query(
    `INSERT INTO outbox_events(name,objective_id,payload)
     VALUES('rating.recorded',$1,$2::jsonb)`,
    [
      input.request.objectiveId,
      JSON.stringify({
        ratingId,
        objectiveId: input.request.objectiveId,
        stepIndex: input.request.stepIndex,
      }),
    ],
  );
  const accepted: RatingAccepted = {
    ratingId,
    objectiveId: input.request.objectiveId,
    stepIndex: input.request.stepIndex,
    value: input.request.value,
    receipts: observations.length,
    windowClosesAt: windowClosesAt.toISOString(),
  };
  const responseHash = createHash("sha256").update(jcsString(accepted)).digest();
  await client.query(
    `UPDATE idempotency SET status=202,response_body=$3::jsonb,response_hash=$4
     WHERE scope=$1 AND key=$2`,
    [scope, input.key, JSON.stringify(accepted), responseHash],
  );
  return { accepted, correction: previous !== null, replayed: false };
}

async function loadOwnerResult(client: PoolClient, input: RatingInput): Promise<OwnerResult> {
  const found = await client.query<OwnerResult>(
    `SELECT u.controlled,o.envelope_ref,p.plan,r.provenance,r.created_at
     FROM objectives o JOIN users u ON u.user_id=o.user_id
     JOIN results r ON r.objective_id=o.objective_id AND r.result_id=o.result_id
     LEFT JOIN plans p ON p.plan_id=o.plan_id
     WHERE o.objective_id=$1 AND o.user_id=$2 FOR UPDATE OF o`,
    [input.request.objectiveId, input.userId],
  );
  const owner = found.rows[0];
  if (!owner) throw new RatingRejected(404, "unknown-objective");
  return owner;
}

async function loadEligibleObservations(
  client: PoolClient,
  request: RatingRequest,
): Promise<EligibleObservation[]> {
  const found = await client.query<EligibleObservation>(
    `SELECT obs_id,user_id,vault,envelope_ref,rail,dedup_key,network,service_id,
       version_id,task_class
     FROM observations WHERE objective_id=$1 AND step_index=$2
       AND settled_at IS NOT NULL AND released_at IS NULL
       AND (rail <> 'erc8183-job' OR job_state='Completed') ORDER BY call_index,obs_id`,
    [request.objectiveId, request.stepIndex],
  );
  return found.rows;
}

function assertPayingVault(
  observations: readonly EligibleObservation[],
  envelopeRef: string | null,
  userId: string,
): void {
  const vault = envelopeRef?.split(":")[2];
  if (
    !envelopeRef ||
    !vault ||
    !/^eip155:[0-9]+:0x[0-9a-f]{40}:[0-9]+$/i.test(envelopeRef) ||
    observations.some(
      (row) =>
        row.user_id !== userId ||
        row.envelope_ref.toLowerCase() !== envelopeRef.toLowerCase() ||
        row.vault.toLowerCase() !== vault.toLowerCase(),
    )
  ) {
    throw new RatingRejected(403, "not-your-payment");
  }
}

const PAYMENT_DEDUP_KEY =
  /^(x402-exact|gateway-batched):(eip155:[0-9]+):0x[0-9a-f]{40}:(0x[0-9a-f]{40}):0x[0-9a-f]{64}$/;

function isAttributedToPayee(observation: EligibleObservation, payee: string | undefined): boolean {
  if (!payee || !/^0x[0-9a-fA-F]{40}$/.test(payee)) return false;
  if (observation.rail === "erc8183-job") return true;
  const match = PAYMENT_DEDUP_KEY.exec(observation.dedup_key);
  return (
    match !== null &&
    match[1] === observation.rail &&
    match[2] === observation.network &&
    match[3] === payee.toLowerCase()
  );
}

function assertOneSupplier(
  observations: readonly EligibleObservation[],
  reference: EligibleObservation,
): void {
  if (
    observations.some(
      (row) =>
        row.network !== reference.network ||
        row.service_id !== reference.service_id ||
        row.version_id !== reference.version_id ||
        row.task_class !== reference.task_class,
    )
  ) {
    throw new Error("Producing step contains receipts from multiple suppliers.");
  }
}

async function loadEffectiveRating(
  client: PoolClient,
  request: RatingRequest,
): Promise<EffectiveRating | null> {
  const found = await client.query<EffectiveRating>(
    `SELECT rating_id,user_id,supersedes FROM ratings_effective
     WHERE objective_id=$1 AND step_index=$2`,
    [request.objectiveId, request.stepIndex],
  );
  return found.rows[0] ?? null;
}

function validateSupersedes(previous: EffectiveRating | null, input: RatingInput): void {
  const named = input.request.supersedes;
  if (previous && !named) throw new RatingRejected(422, "supersedes-required");
  if (
    named &&
    (!previous ||
      previous.rating_id !== named ||
      previous.user_id !== input.userId ||
      previous.supersedes !== null)
  )
    throw new RatingRejected(422, "bad-supersedes");
}

async function insertRating(
  client: PoolClient,
  ratingId: string,
  input: RatingInput,
  observation: EligibleObservation,
): Promise<void> {
  await client.query(
    `INSERT INTO ratings(rating_id,user_id,vault,objective_id,step_index,network,
      service_id,version_id,task_class,value,surface,supersedes,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      ratingId,
      input.userId,
      observation.vault,
      input.request.objectiveId,
      input.request.stepIndex,
      observation.network,
      observation.service_id,
      observation.version_id,
      observation.task_class,
      input.request.value,
      input.surface,
      input.request.supersedes ?? null,
      input.now,
    ],
  );
}

async function bindReceipts(
  client: PoolClient,
  ratingId: string,
  supersedes: string | undefined,
  observations: readonly EligibleObservation[],
): Promise<void> {
  if (supersedes) {
    await client.query("UPDATE rating_receipts SET rating_id=$1 WHERE rating_id=$2", [
      ratingId,
      supersedes,
    ]);
  }
  await client.query(
    `INSERT INTO rating_receipts(obs_id,rating_id)
     SELECT unnest($1::text[]),$2 ON CONFLICT (obs_id) DO NOTHING`,
    [observations.map((row) => row.obs_id), ratingId],
  );
  const bound = await client.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM rating_receipts WHERE rating_id=$1",
    [ratingId],
  );
  if (Number(bound.rows[0]?.count) !== observations.length)
    throw new Error("Rating receipt binding does not match eligible settled receipts.");
}

function sameHash(body: Record<string, unknown>, hash: Buffer): boolean {
  return createHash("sha256").update(jcsString(body)).digest().equals(hash);
}
