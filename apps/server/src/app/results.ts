import type { Config } from "@czar/config";
import type { Result } from "@czar/schemas";
import type { Pool } from "pg";
import {
  RequestValidationError,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  PAGE_LIMIT_MIN,
  CURSOR_MAX_LENGTH,
} from "#src/http/validate";

export interface RatingPromptStep {
  readonly stepIndex: number;
  readonly merchantLabel: string;
  readonly merchantIsCzar: boolean;
  readonly receipts: number;
  readonly effectiveRating: "good" | "bad" | "none";
  readonly ratingId?: string;
  readonly canRate: boolean;
  readonly canCorrect: boolean;
}

export interface RatingPrompt {
  readonly objectiveId: string;
  readonly deliveredAt: string;
  readonly windowClosesAt: string;
  readonly steps: RatingPromptStep[];
}

export interface AppResultCard {
  readonly objectiveId: string;
  readonly deliveredAt: string;
  readonly kind: string;
  readonly stepCount: number;
  readonly suppliers: RatingPromptStep[];
  readonly amountDisplay?: string;
  readonly windowClosesAt: string;
}

interface ResultRow {
  readonly objective_id: string;
  readonly provenance: Result["provenance"];
  readonly created_at: Date;
  readonly kind: string | null;
  readonly controlled: boolean;
  readonly plan: { readonly steps?: readonly { stepIndex: number; payee?: string }[] } | null;
}

interface ReceiptCount {
  readonly objective_id: string;
  readonly step_index: number;
  readonly count: string;
}

interface RatingState {
  readonly objective_id: string;
  readonly step_index: number;
  readonly rating_id: string;
  readonly value: "good" | "bad";
  readonly supersedes: string | null;
}

interface Cursor {
  readonly deliveredAt: string;
  readonly objectiveId: string;
}

const stepKey = (objectiveId: string, stepIndex: number) => `${objectiveId}:${stepIndex}`;

/** Return the producing suppliers and rating eligibility of one owner's result. */
export async function getRatingPrompt(
  pool: Pool,
  config: Config,
  userId: string,
  objectiveId: string,
  now: Date,
): Promise<RatingPrompt | null> {
  const rows = await loadResultRows(pool, userId, [objectiveId]);
  const row = rows[0];
  if (!row) return null;
  const facts = await loadStepFacts(pool, userId, rows);
  return buildPrompt(row, facts, config, now);
}

/** Page delivered result cards without exposing bodies, subjects, or file names. */
export async function listAppResults(
  pool: Pool,
  config: Config,
  userId: string,
  now: Date,
  url: URL,
): Promise<{ readonly items: AppResultCard[]; readonly nextCursor: string | null }> {
  const limit = parseLimit(url.searchParams.get("limit"));
  const cursor = parseCursor(url.searchParams.get("cursor"));
  const rows = await pool.query<ResultRow>(
    `SELECT o.objective_id,o.submission #>> '{taskSpec,kind}' AS kind,
       u.controlled,p.plan,r.provenance,r.created_at
     FROM results r JOIN objectives o ON o.objective_id=r.objective_id
     JOIN users u ON u.user_id=o.user_id
     LEFT JOIN plans p ON p.plan_id=o.plan_id
     WHERE o.user_id=$1 AND o.state='delivered' AND o.result_id=r.result_id
       AND ($2::timestamptz IS NULL OR (r.created_at,o.objective_id)<($2,$3))
     ORDER BY r.created_at DESC,o.objective_id DESC LIMIT $4`,
    [userId, cursor?.deliveredAt ?? null, cursor?.objectiveId ?? null, limit + 1],
  );
  const page = rows.rows.slice(0, limit);
  const facts = await loadStepFacts(pool, userId, page);
  const items = page.map((row) => {
    const prompt = buildPrompt(row, facts, config, now);
    return {
      objectiveId: row.objective_id,
      deliveredAt: prompt.deliveredAt,
      kind: row.kind ?? "unknown",
      stepCount: row.plan?.steps?.length ?? row.provenance.length,
      suppliers: prompt.steps,
      windowClosesAt: prompt.windowClosesAt,
    };
  });
  const last = page.at(-1);
  const nextCursor =
    rows.rows.length > limit && last
      ? encodeCursor({
          deliveredAt: last.created_at.toISOString(),
          objectiveId: last.objective_id,
        })
      : null;
  return { items, nextCursor };
}

async function loadResultRows(
  pool: Pool,
  userId: string,
  objectives: string[],
): Promise<ResultRow[]> {
  const result = await pool.query<ResultRow>(
    `SELECT o.objective_id,o.submission #>> '{taskSpec,kind}' AS kind,
       u.controlled,p.plan,r.provenance,r.created_at
     FROM objectives o JOIN results r ON r.objective_id=o.objective_id AND r.result_id=o.result_id
     JOIN users u ON u.user_id=o.user_id
     LEFT JOIN plans p ON p.plan_id=o.plan_id
     WHERE o.user_id=$1 AND o.state='delivered' AND o.objective_id=ANY($2::text[])`,
    [userId, objectives],
  );
  return result.rows;
}

async function loadStepFacts(
  pool: Pool,
  userId: string,
  rows: readonly ResultRow[],
): Promise<{ counts: Map<string, number>; ratings: Map<string, RatingState> }> {
  const objectives = rows.map((row) => row.objective_id);
  if (objectives.length === 0) return { counts: new Map(), ratings: new Map() };
  const [counts, ratings] = await Promise.all([
    pool.query<ReceiptCount>(
      `SELECT ob.objective_id,ob.step_index,COUNT(*)::text AS count
       FROM observations ob
       JOIN objectives o ON o.objective_id=ob.objective_id AND o.user_id=ob.user_id
       JOIN plans p ON p.plan_id=o.plan_id
       WHERE ob.objective_id=ANY($1::text[]) AND ob.user_id=$2
         AND o.envelope_ref IS NOT NULL AND lower(ob.envelope_ref)=lower(o.envelope_ref)
         AND lower(ob.vault)=lower(split_part(o.envelope_ref,':',3))
         AND ob.settled_at IS NOT NULL AND ob.released_at IS NULL
         AND (ob.rail <> 'erc8183-job' OR ob.job_state='Completed')
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(coalesce(p.plan->'steps','[]'::jsonb)) step
           WHERE step->>'stepIndex'=ob.step_index::text
             AND (ob.rail='erc8183-job' OR (
               ob.rail IN ('x402-exact','gateway-batched')
              AND ob.dedup_key ~ (
                '^(x402-exact|gateway-batched):eip155:[0-9]+:' ||
                '0x[0-9a-f]{40}:0x[0-9a-f]{40}:0x[0-9a-f]{64}$'
              )
               AND split_part(ob.dedup_key,':',1)=ob.rail
               AND split_part(ob.dedup_key,':',2)||':'||split_part(ob.dedup_key,':',3)=ob.network
               AND split_part(ob.dedup_key,':',5)=lower(step->>'payee')
             ))
         )
       GROUP BY ob.objective_id,ob.step_index`,
      [objectives, userId],
    ),
    pool.query<RatingState>(
      `SELECT objective_id,step_index,rating_id,value,supersedes FROM ratings_effective
       WHERE objective_id=ANY($1::text[]) AND user_id=$2`,
      [objectives, userId],
    ),
  ]);
  return {
    counts: new Map(
      counts.rows.map((row) => [stepKey(row.objective_id, row.step_index), Number(row.count)]),
    ),
    ratings: new Map(ratings.rows.map((row) => [stepKey(row.objective_id, row.step_index), row])),
  };
}

function buildPrompt(
  row: ResultRow,
  facts: { counts: Map<string, number>; ratings: Map<string, RatingState> },
  config: Config,
  now: Date,
): RatingPrompt {
  const deliveredAt = row.created_at.toISOString();
  const closes = new Date(
    row.created_at.getTime() + Number(config.get("rating.windowDays")) * 86_400_000,
  );
  const insideWindow = now.getTime() <= closes.getTime();
  const czarPayees = new Set(
    (config.get("indexer.merchantPayoutAddresses") as readonly string[]).map((address) =>
      address.toLowerCase(),
    ),
  );
  const steps = new Map<number, RatingPromptStep>();
  for (const provenance of row.provenance) {
    if (!provenance.accepted || steps.has(provenance.stepIndex)) continue;
    const key = `${row.objective_id}:${provenance.stepIndex}`;
    const rating = facts.ratings.get(key);
    const receipts = facts.counts.get(key) ?? 0;
    const payee = row.plan?.steps?.find((step) => step.stepIndex === provenance.stepIndex)?.payee;
    steps.set(provenance.stepIndex, {
      stepIndex: provenance.stepIndex,
      merchantLabel: hostLabel(provenance.origin),
      merchantIsCzar: payee !== undefined && czarPayees.has(payee.toLowerCase()),
      receipts,
      effectiveRating: rating?.value ?? "none",
      ...(rating ? { ratingId: rating.rating_id } : {}),
      canRate: !row.controlled && insideWindow && receipts > 0 && !rating,
      canCorrect:
        !row.controlled && insideWindow && rating !== undefined && rating.supersedes === null,
    });
  }
  return {
    objectiveId: row.objective_id,
    deliveredAt,
    windowClosesAt: closes.toISOString(),
    steps: [...steps.values()].toSorted((a, b) => a.stepIndex - b.stepIndex),
  };
}

function hostLabel(origin: string): string {
  try {
    return new URL(origin.includes("://") ? origin : `https://${origin}`).hostname.slice(0, 253);
  } catch {
    return "unknown merchant";
  }
}

function parseLimit(value: string | null): number {
  const limit = value === null ? PAGE_LIMIT_DEFAULT : Number(value);
  if (!Number.isSafeInteger(limit) || limit < PAGE_LIMIT_MIN || limit > PAGE_LIMIT_MAX)
    throw new RequestValidationError();
  return limit;
}

function parseCursor(value: string | null): Cursor | null {
  if (value === null) return null;
  if (value.length > CURSOR_MAX_LENGTH) throw new RequestValidationError();
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor;
    if (
      !parsed ||
      Number.isNaN(Date.parse(parsed.deliveredAt)) ||
      !/^obj_[0-9A-HJKMNP-TV-Z]{26}$/.test(parsed.objectiveId)
    )
      throw new RequestValidationError();
    return parsed;
  } catch {
    throw new RequestValidationError();
  }
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}
