import type { Config } from "@czar/config";
import type { Pool, PoolClient } from "pg";
import { canTransition } from "#src/objectives/state";

export interface OpeningEnvelope {
  readonly envelope: {
    readonly envelopeRef: string;
    readonly vault: string;
    readonly planHash: string;
    readonly state: string;
  };
}

export interface OpeningWatcherDependencies {
  readonly pool: Pool;
  readonly config: Config;
  readonly lookup: { envelopeByPlanHash(planHash: string): Promise<OpeningEnvelope | null> };
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
}

export function createIndexerOpeningLookup(
  indexerUrl: string,
  timeoutMs: number,
  fetcher: typeof fetch = fetch,
): OpeningWatcherDependencies["lookup"] {
  const base = new URL(indexerUrl);
  if (base.protocol !== "http:" && base.protocol !== "https:")
    throw new TypeError("CZAR_INDEXER_URL must use HTTP or HTTPS.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new RangeError("fetch.timeoutMs must be a positive integer.");
  return {
    async envelopeByPlanHash(planHash) {
      const url = new URL(`/envelopes/by-plan-hash/${encodeURIComponent(planHash)}`, base);
      const response = await fetcher(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 404) return null;
      if (!response.ok)
        throw new Error(`Indexer envelope lookup returned HTTP ${response.status}.`);
      return parseOpeningEnvelope(await response.json());
    },
  };
}

function parseOpeningEnvelope(value: unknown): OpeningEnvelope {
  if (!isRecord(value) || !isRecord(value["envelope"]))
    throw new TypeError("Indexer envelope lookup returned an invalid response.");
  const envelope = value["envelope"];
  if (
    typeof envelope["envelopeRef"] !== "string" ||
    typeof envelope["vault"] !== "string" ||
    !/^0x[\da-fA-F]{40}$/.test(envelope["vault"]) ||
    typeof envelope["planHash"] !== "string" ||
    !/^0x[\da-fA-F]{64}$/.test(envelope["planHash"]) ||
    typeof envelope["state"] !== "string"
  ) {
    throw new TypeError("Indexer envelope lookup returned an invalid envelope.");
  }
  return {
    envelope: {
      envelopeRef: envelope["envelopeRef"],
      vault: envelope["vault"],
      planHash: envelope["planHash"],
      state: envelope["state"],
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface OpeningRow {
  readonly objective_id: string;
  readonly state: "opening" | "awaiting-approval";
  readonly updated_at: Date;
  readonly vault: string | null;
  readonly plan_id: string;
  readonly plan_hash: string;
  readonly plan: { readonly expiresAt: string };
}

export async function pollOpeningObjectives(
  dependencies: OpeningWatcherDependencies,
): Promise<void> {
  const now = (dependencies.now ?? (() => new Date()))();
  const result = await dependencies.pool.query<OpeningRow>(
    `SELECT o.objective_id,o.state,o.updated_at,u.vault,p.plan_id,p.plan_hash,p.plan
     FROM objectives o JOIN users u ON u.user_id=o.user_id
     JOIN plans p ON p.plan_id=o.plan_id
     WHERE p.state='approved'
       AND (o.state='opening' OR o.state='awaiting-approval')
     ORDER BY o.updated_at,o.objective_id`,
  );
  for (const row of result.rows) await processOpeningRow(row, dependencies, now);
}

async function processOpeningRow(
  row: OpeningRow,
  dependencies: OpeningWatcherDependencies,
  now: Date,
): Promise<void> {
  const expiresAt = new Date(row.plan.expiresAt);
  if (Number.isNaN(expiresAt.getTime()))
    throw new TypeError(`Plan ${row.plan_id} has an invalid expiresAt value.`);
  if (now.getTime() >= expiresAt.getTime()) {
    await expirePlan(row, dependencies.pool, now);
    return;
  }
  const found = await dependencies.lookup.envelopeByPlanHash(row.plan_hash);
  if (matchesEnvelope(found, row, now)) {
    await markExecuting(row, found.envelope.envelopeRef, dependencies.pool, now);
    return;
  }
  if (row.state === "opening" && approvalWaitElapsed(row, dependencies.config, now))
    await returnToApproval(row, dependencies.pool, now);
}

function matchesEnvelope(
  found: OpeningEnvelope | null,
  row: OpeningRow,
  now: Date,
): found is OpeningEnvelope {
  return Boolean(
    found &&
    row.vault &&
    found.envelope.state === "Open" &&
    found.envelope.vault.toLowerCase() === row.vault.toLowerCase() &&
    found.envelope.planHash.toLowerCase() === row.plan_hash.toLowerCase() &&
    found.envelope.envelopeRef.length > 0 &&
    now.getTime() < new Date(row.plan.expiresAt).getTime(),
  );
}

function approvalWaitElapsed(row: OpeningRow, config: Config, now: Date): boolean {
  const waitMinutes = Number(config.get("api.approvalWaitMinutes"));
  return now.getTime() - row.updated_at.getTime() >= waitMinutes * 60_000;
}

async function markExecuting(
  row: OpeningRow,
  envelopeRef: string,
  pool: Pool,
  now: Date,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await lockCurrentOpening(client, row.objective_id);
    if (!current || current.plan_id !== row.plan_id || current.plan_state !== "approved") {
      await client.query("COMMIT");
      return;
    }
    if (!canTransition(current.state, "executing"))
      throw new Error(`Invalid objective transition: ${current.state} -> executing`);
    const updated = await client.query(
      `UPDATE objectives SET state='executing',envelope_ref=$2,updated_at=$3
       WHERE objective_id=$1 AND plan_id=$4 AND state=$5`,
      [row.objective_id, envelopeRef, now, row.plan_id, current.state],
    );
    if (updated.rowCount !== 1) throw new Error("Objective changed while matching its envelope.");
    await client.query(
      `INSERT INTO outbox_events (name,objective_id,payload)
       VALUES ('plan.approved',$1,$2::jsonb)`,
      [row.objective_id, JSON.stringify({ planId: row.plan_id, envelopeRef })],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function returnToApproval(row: OpeningRow, pool: Pool, now: Date): Promise<void> {
  if (!canTransition("opening", "awaiting-approval"))
    throw new Error("Invalid objective transition: opening -> awaiting-approval");
  await pool.query(
    `UPDATE objectives SET state='awaiting-approval',updated_at=$2
     WHERE objective_id=$1 AND plan_id=$3 AND state='opening'`,
    [row.objective_id, now, row.plan_id],
  );
}

async function expirePlan(row: OpeningRow, pool: Pool, now: Date): Promise<void> {
  if (!canTransition(row.state, "expired"))
    throw new Error(`Invalid objective transition: ${row.state} -> expired`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await lockCurrentOpening(client, row.objective_id);
    if (
      !current ||
      current.plan_id !== row.plan_id ||
      current.plan_state !== "approved" ||
      now.getTime() < new Date(current.expires_at).getTime()
    ) {
      await client.query("COMMIT");
      return;
    }
    await client.query(
      "UPDATE plans SET state='expired',updated_at=$2 WHERE plan_id=$1 AND state='approved'",
      [row.plan_id, now],
    );
    await client.query(
      `UPDATE objectives SET state='expired',updated_at=$2
       WHERE objective_id=$1 AND plan_id=$3 AND state=$4`,
      [row.objective_id, now, row.plan_id, current.state],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function lockCurrentOpening(
  client: PoolClient,
  objectiveId: string,
): Promise<{
  readonly state: "opening" | "awaiting-approval";
  readonly plan_id: string;
  readonly plan_state: string;
  readonly expires_at: Date;
} | null> {
  const result = await client.query<{
    state: "opening" | "awaiting-approval";
    plan_id: string;
    plan_state: string;
    expires_at: Date;
  }>(
    `SELECT o.state,o.plan_id,p.state AS plan_state,(p.plan->>'expiresAt')::timestamptz AS expires_at
     FROM objectives o JOIN plans p ON p.plan_id=o.plan_id
     WHERE o.objective_id=$1 AND o.state IN ('opening','awaiting-approval')
     FOR UPDATE OF o,p`,
    [objectiveId],
  );
  return result.rows[0] ?? null;
}

export function startOpeningWatcher(dependencies: OpeningWatcherDependencies): {
  stop(): Promise<void>;
} {
  let stopped = false;
  let running: Promise<void> | undefined;
  const poll = () => {
    if (stopped || running) return;
    running = pollOpeningObjectives(dependencies)
      .catch((error: unknown) => dependencies.onError?.(error))
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(poll, Number(dependencies.config.get("api.openingPollMs")));
  poll();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
