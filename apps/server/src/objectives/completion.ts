import type { Config } from "@czar/config";
import { validateSchema, type StepResult } from "@czar/schemas";
import type { Signer } from "@czar/signer";
import type { Pool, PoolClient } from "pg";
import { keccak256 } from "viem";
import { appendExecutionPhase, getExecutionTrace } from "#src/payer/executions";
import { savedTransactionState, type SavedTransactionChain } from "#src/payer/saved-transaction";
import { ulid, type RandomSource } from "#src/http/ids";
import { canTransition } from "#src/objectives/state";

const RESULT_QUARANTINE_NOTICE = "All merchant results were quarantined and withheld.";

export interface CompletionInput {
  readonly objectiveId: string;
  readonly planId: string;
  readonly envelopeRef: string;
  readonly vault: `0x${string}`;
  readonly envelopeId: bigint;
}

export interface CompletionChain extends SavedTransactionChain {
  readEnvelope(
    vault: `0x${string}`,
    envelopeId: bigint,
  ): Promise<{
    readonly state: "Open" | "Closed";
    readonly openReservations: bigint;
    readonly openPockets: bigint;
    readonly openJobs: bigint;
  }>;
  closeEnvelope(input: {
    readonly vault: `0x${string}`;
    readonly envelopeId: bigint;
    readonly transaction: `0x${string}`;
  }): Promise<string>;
}

export interface CompletionDependencies {
  readonly pool: Pool;
  readonly config: Config;
  readonly signer: Pick<Signer, "sign">;
  readonly chain: CompletionChain;
  readonly now: () => Date;
  readonly random: RandomSource;
}

interface StoredStepResult {
  readonly stepIndex: number;
  readonly result: StepResult;
}

export async function completeObjective(
  input: CompletionInput,
  dependencies: CompletionDependencies,
): Promise<boolean> {
  const steps = await readTerminalSteps(dependencies.pool, input.planId);
  if (steps.length === 0 || steps.some(({ state }) => state !== "done" && state !== "failed"))
    return false;
  if (!(await closeEnvelopeWhenIdle(input, dependencies, steps[0]!.stepIndex))) return false;
  await persistCompletion(
    input,
    await readStepResults(dependencies.pool, input.planId),
    dependencies,
  );
  return true;
}

async function readTerminalSteps(
  pool: Pool,
  planId: string,
): Promise<
  {
    stepIndex: number;
    state: string;
  }[]
> {
  const result = await pool.query<{ step_index: number; state: string }>(
    "SELECT step_index,state FROM steps WHERE plan_id=$1 ORDER BY step_index",
    [planId],
  );
  return result.rows.map((row) => ({ stepIndex: row.step_index, state: row.state }));
}

async function closeEnvelopeWhenIdle(
  input: CompletionInput,
  dependencies: CompletionDependencies,
  journalStepIndex: number,
): Promise<boolean> {
  const envelope = await dependencies.chain.readEnvelope(input.vault, input.envelopeId);
  if (envelope.state === "Closed") return true;
  if (envelope.openReservations > 0n || envelope.openPockets > 0n || envelope.openJobs > 0n)
    return false;
  const trace = await getExecutionTrace(dependencies.pool, input.planId, journalStepIndex, 0);
  const transaction = await nextCloseTransaction(input, dependencies, trace, journalStepIndex);
  const txHash =
    typeof transaction === "string"
      ? await dependencies.chain.closeEnvelope({
          vault: input.vault,
          envelopeId: input.envelopeId,
          transaction,
        })
      : transaction.txHash;
  await appendExecutionPhase(dependencies.pool, {
    planId: input.planId,
    stepIndex: journalStepIndex,
    attempt: 0,
    phase: "envelope.close.mined",
    payload: { txHash },
  });
  return (await dependencies.chain.readEnvelope(input.vault, input.envelopeId)).state === "Closed";
}

/**
 * SCR-159 §2 for the saved `closeEnvelope`: its bytes again while they can still land, its receipt when it has
 * one, else the close signed again and saved with a new `envelope.close.sent`. A reverted close is recorded
 * once and fails; it is never sent again.
 */
async function nextCloseTransaction(
  input: CompletionInput,
  dependencies: CompletionDependencies,
  trace: Awaited<ReturnType<typeof getExecutionTrace>>,
  journalStepIndex: number,
): Promise<`0x${string}` | { readonly txHash: string }> {
  const saved = trace.findLast((row) => row.phase === "envelope.close.sent")?.payload[
    "transaction"
  ];
  if (typeof saved === "string") {
    const savedTransaction = saved as `0x${string}`;
    const txHash = keccak256(savedTransaction);
    const state = await savedTransactionState(dependencies.chain, savedTransaction);
    if (state === "pending") return savedTransaction;
    if (state === "mined") return { txHash };
    if (state === "reverted") {
      const recorded = trace.some(
        (row) => row.phase === "envelope.close.mined" && row.payload["txHash"] === txHash,
      );
      if (!recorded)
        await appendExecutionPhase(dependencies.pool, {
          planId: input.planId,
          stepIndex: journalStepIndex,
          attempt: 0,
          phase: "envelope.close.mined",
          payload: { txHash, outcome: "reverted" },
        });
      throw new Error(`closeEnvelope reverted: ${txHash}`);
    }
  }
  const transaction = await signCloseEnvelope(input, dependencies);
  await appendExecutionPhase(dependencies.pool, {
    planId: input.planId,
    stepIndex: journalStepIndex,
    attempt: 0,
    phase: "envelope.close.sent",
    payload: { transaction },
  });
  return transaction;
}

async function signCloseEnvelope(
  input: CompletionInput,
  dependencies: CompletionDependencies,
): Promise<`0x${string}`> {
  const signed = await dependencies.signer.sign("cz-15", {
    keyId: "K3",
    kind: "vault-call",
    payload: {
      vault: input.vault,
      selector: "closeEnvelope",
      args: { envelopeId: input.envelopeId.toString() },
    },
  });
  if (!("signedTransaction" in signed))
    throw new Error("K3 did not return a signed closeEnvelope transaction.");
  return signed.signedTransaction;
}

async function readStepResults(pool: Pool, planId: string): Promise<StoredStepResult[]> {
  const result = await pool.query<{ step_index: number; payload: Record<string, unknown> }>(
    `SELECT DISTINCT ON (step_index, (payload->>'index')) step_index,payload
     FROM step_executions WHERE plan_id=$1 AND phase='step.result'
     ORDER BY step_index,(payload->>'index'),execution_id DESC`,
    [planId],
  );
  const stored: StoredStepResult[] = [];
  for (const row of result.rows) {
    const candidate = row.payload["stepResult"];
    if (!validateSchema("step-result", candidate))
      throw new Error(`Step ${row.step_index} has an invalid stored StepResult.`);
    stored.push({ stepIndex: row.step_index, result: candidate });
  }
  return stored;
}

async function persistCompletion(
  input: CompletionInput,
  results: readonly StoredStepResult[],
  dependencies: CompletionDependencies,
): Promise<void> {
  const hasDeliveredContent = results.some(({ result }) => result.status === "delivered");
  const allQuarantined = results.length > 0 && results.every(isQuarantined);
  const nextState = hasDeliveredContent ? "delivered" : "failed";
  const reason = allQuarantined ? "result-quarantined" : undefined;
  const renderedBody = renderBody(results, hasDeliveredContent, allQuarantined);
  const provenance = results.map(({ stepIndex, result }) => ({
    stepIndex,
    origin: result.source.origin,
    paymentRefHash: result.source.paymentRefHash,
    accepted: result.status === "delivered",
  }));
  const resultId = currentResultId(dependencies);
  const client = await dependencies.pool.connect();
  try {
    await client.query("BEGIN");
    const objective = await lockObjective(client, input.objectiveId);
    if (!objective || objective.result_id) {
      await client.query("COMMIT");
      return;
    }
    if (objective.state !== "executing" || !canTransition(objective.state, nextState))
      throw new Error(`Invalid objective transition: ${objective.state} -> ${nextState}`);
    await insertResult(client, input, resultId, renderedBody, provenance, dependencies.now());
    await updateObjective(client, input, nextState, resultId, dependencies.now());
    await insertCompletionEvent(client, input.objectiveId, resultId, nextState, reason);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function renderBody(
  results: readonly StoredStepResult[],
  hasDeliveredContent: boolean,
  allQuarantined: boolean,
): string {
  if (allQuarantined) return RESULT_QUARANTINE_NOTICE;
  if (!hasDeliveredContent) return "No content was delivered.";
  const steps = results
    .filter(({ result }) => result.status === "delivered")
    .map(({ stepIndex, result }) => ({
      stepIndex,
      origin: result.source.origin,
      label: "Unverified merchant data",
      fields: result.fields.map(({ name, value }) => ({ name, value })),
    }));
  return JSON.stringify({ steps });
}

function isQuarantined({ result }: StoredStepResult): boolean {
  return result.status === "unknown" && result.fields.length === 0;
}

interface ObjectiveRow {
  readonly state: string;
  readonly result_id: string | null;
}

async function lockObjective(
  client: PoolClient,
  objectiveId: string,
): Promise<ObjectiveRow | null> {
  const result = await client.query<ObjectiveRow>(
    "SELECT state,result_id FROM objectives WHERE objective_id=$1 FOR UPDATE",
    [objectiveId],
  );
  return result.rows[0] ?? null;
}

function currentResultId(dependencies: CompletionDependencies): string {
  return ulid("res_", dependencies.now(), dependencies.random);
}

async function insertResult(
  client: PoolClient,
  input: CompletionInput,
  resultId: string,
  renderedBody: string,
  provenance: readonly Record<string, unknown>[],
  createdAt: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO results(result_id,objective_id,rendered_body,provenance,created_at)
     VALUES($1,$2,$3,$4::jsonb,$5)`,
    [resultId, input.objectiveId, renderedBody, JSON.stringify(provenance), createdAt],
  );
}

async function updateObjective(
  client: PoolClient,
  input: CompletionInput,
  state: "delivered" | "failed",
  resultId: string,
  now: Date,
): Promise<void> {
  const updated = await client.query(
    "UPDATE objectives SET state=$2,result_id=$3,updated_at=$4 WHERE objective_id=$1 AND state='executing'",
    [input.objectiveId, state, resultId, now],
  );
  if (updated.rowCount !== 1) throw new Error("Objective changed during result completion.");
}

async function insertCompletionEvent(
  client: PoolClient,
  objectiveId: string,
  resultId: string,
  state: "delivered" | "failed",
  reason: string | undefined,
): Promise<void> {
  const name = state === "delivered" ? "objective.delivered" : "objective.failed";
  await client.query(
    "INSERT INTO outbox_events(name,objective_id,payload) VALUES($1,$2,$3::jsonb)",
    [name, objectiveId, JSON.stringify({ resultId, ...(reason ? { reason } : {}) })],
  );
}
