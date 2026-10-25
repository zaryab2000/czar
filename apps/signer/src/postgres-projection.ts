import type { Address, Hash32 } from "@czar/hashing";
import type { PaymentRef } from "@czar/schemas";
import type { Config } from "@czar/config";
import { czarVaultAbi, czarVaultFactoryAbi } from "@czar/vault-client";
import { keccak256, stringToHex, type PublicClient } from "viem";
import type { AuditQueryExecutor } from "./postgres-audit.ts";
import type {
  AutonomyView,
  EnvelopeView,
  FreezeState,
  PlanLeaf,
  PocketBalances,
  PocketView,
  Projection,
  PullbackView,
  ReservationView,
  StoredPlan,
} from "./projection.ts";

type SqlRows = { readonly rows: readonly Record<string, unknown>[] };
type Sql = (query: string, values?: unknown[]) => Promise<SqlRows>;
type ChainClient = Pick<
  PublicClient,
  "getBlock" | "getBlockNumber" | "getBalance" | "readContract"
>;
type ProjectionInput = {
  readonly config: Config;
  readonly database: AuditQueryExecutor;
  readonly chain: ChainClient;
  readonly factory: Address;
};

const VAULT = czarVaultAbi;
const FACTORY = czarVaultFactoryAbi;
const BPS_BASE = 10_000n;
const ZERO32 = `0x${"0".repeat(64)}` as Hash32;

/** Production T-040 projection backed by the existing indexer and server Postgres tables. */
export function createPostgresProjection(input: ProjectionInput): Projection {
  const sql: Sql = async (query, values = []) =>
    (await input.database.query(query, values)) as SqlRows;
  return {
    ...chainProjection(input),
    ...indexerProjection(sql),
    ...serverProjection(sql),
  };
}

function chainProjection(
  input: ProjectionInput,
): Pick<
  Projection,
  | "freezeState"
  | "isVault"
  | "reservation"
  | "pullback"
  | "blockNumber"
  | "autonomy"
  | "nativeBalance"
> {
  return {
    async freezeState(vault) {
      const [frozen, guardianPaused, block] = await Promise.all([
        input.chain.readContract({ address: vault, abi: VAULT, functionName: "frozen" }),
        input.chain.readContract({
          address: input.factory,
          abi: FACTORY,
          functionName: "guardianPaused",
        }),
        input.chain.getBlock(),
      ]);
      return { frozen, guardianPaused, observedAt: Number(block.timestamp) } satisfies FreezeState;
    },
    isVault: (vault) =>
      input.chain.readContract({
        address: input.factory,
        abi: FACTORY,
        functionName: "isVault",
        args: [vault],
      }),
    reservation: (vault, id) => readReservation(input.chain, vault, id),
    pullback: (vault, id) => readPullback(input.chain, vault, id),
    blockNumber: () => input.chain.getBlockNumber(),
    autonomy: (vault, categoryId) => readAutonomy(input, vault, categoryId),
    nativeBalance: (address) => input.chain.getBalance({ address }),
  };
}

async function readReservation(
  chain: ChainClient,
  vault: Address,
  reservationId: bigint,
): Promise<ReservationView | undefined> {
  const row = await chain.readContract({
    address: vault,
    abi: VAULT,
    functionName: "getReservation",
    args: [reservationId],
  });
  if (row.state === 0) return undefined;
  return {
    envelopeId: row.envelopeId,
    stepIndex: row.stepIndex,
    payee: row.payee,
    unitAmount: row.unitAmount,
    count: row.count,
    validBefore: row.validBefore,
    state: enumValue(["", "Active", "Finalizing", "Final"], row.state),
  };
}

async function readPullback(
  chain: ChainClient,
  vault: Address,
  pullbackId: bigint,
): Promise<PullbackView | undefined> {
  const row = await chain.readContract({
    address: vault,
    abi: VAULT,
    functionName: "getPullback",
    args: [pullbackId],
  });
  if (row.state === 0) return undefined;
  return {
    pocket: row.pocket,
    value: row.value,
    maxFee: row.maxFee,
    maxBlockHeight: row.maxBlockHeight,
    salt: row.salt,
    state: enumValue(["", "Pending", "Confirmed", "Cancelled"], row.state),
  };
}

async function readAutonomy(
  input: ProjectionInput,
  vault: Address,
  categoryId: Hash32,
): Promise<AutonomyView | undefined> {
  const limits = await input.chain.readContract({
    address: vault,
    abi: VAULT,
    functionName: "getLimits",
    args: [categoryId],
  });
  if (limits.userMax === 0n) return undefined;
  return {
    autoLimit: limits.autoLimit,
    userMax: limits.userMax,
    maxStepTo:
      limits.autoLimit +
      (limits.autoLimit * BigInt(Number(input.config.get("signer.projection.maxRaiseStepBps")))) /
        BPS_BASE,
    lastRaiseAt: Number(limits.lastRaiseAt),
    periodLength: Number(input.config.get("signer.projection.periodLengthSeconds")),
    nonce: await input.chain.readContract({
      address: vault,
      abi: VAULT,
      functionName: "autonomyNonce",
    }),
  };
}

function indexerProjection(
  sql: Sql,
): Pick<
  Projection,
  "envelope" | "pocket" | "pocketBalances" | "nanoSpent" | "slowWithdrawAllowed"
> {
  return {
    envelope: (vault, id) => readEnvelope(sql, vault, id),
    pocket: (address) => readPocket(sql, address),
    pocketBalances: (address) => unavailablePocketBalances(sql, address),
    nanoSpent: (pocket, payTo) => nanoSpend(sql, pocket, payTo),
    async slowWithdrawAllowed() {
      return false;
    },
  };
}

async function readEnvelope(
  sql: Sql,
  vault: Address,
  envelopeId: bigint,
): Promise<EnvelopeView | undefined> {
  const result = await sql(
    "SELECT mirror FROM envelopes WHERE lower(vault)=lower($1) AND envelope_id=$2 LIMIT 1",
    [vault, envelopeId.toString()],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  const mirror = asRecord(row["mirror"]);
  const plan = await loadPlanByHash(sql, String(mirror["planHash"]));
  if (plan === undefined) throw new Error("indexer envelope references a missing stored plan");
  const usage = await sql(
    `SELECT r.step_index, count(*)::integer AS used_calls
     FROM authorizations a JOIN reservations r
       ON lower(r.vault)=lower(a.vault) AND r.reservation_id=a.reservation_id
     WHERE lower(r.vault)=lower($1) AND r.envelope_id=$2 AND a.used=true
     GROUP BY r.step_index`,
    [vault, envelopeId.toString()],
  );
  const used = new Map(
    usage.rows.map((item) => [Number(item["step_index"]), Number(item["used_calls"])]),
  );
  return {
    state: mirror["state"] === "Open" ? "Open" : "Closed",
    leaves: toPlanLeaves(plan).map((leaf) => ({
      ...leaf,
      usedCalls: used.get(leaf.stepIndex) ?? 0,
    })),
  };
}

async function readPocket(sql: Sql, pocket: Address): Promise<PocketView | undefined> {
  const result = await sql(
    "SELECT vault, mirror FROM pockets WHERE lower(pocket)=lower($1) LIMIT 1",
    [pocket],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  const mirror = asRecord(row["mirror"]);
  return {
    vault: row["vault"] as Address,
    envelopeId: BigInt(String(mirror["envelopeId"])),
    state: pocketState(mirror["state"]),
    funded: BigInt(String(mirror["funded"])),
    slowWithdrawalOpen: mirror["slowWithdrawalOpen"] !== false,
  };
}

async function unavailablePocketBalances(sql: Sql, pocket: Address): Promise<PocketBalances> {
  const result = await sql(
    "SELECT state FROM pullbacks WHERE lower(pocket)=lower($1) AND state='Pending' LIMIT 1",
    [pocket],
  );
  if (result.rows.length > 0)
    throw new Error("Gateway balances unavailable; pending pullback prevents retirement");
  throw new Error(`Gateway balance projection unavailable for ${pocket}`);
}

async function nanoSpend(sql: Sql, pocket: Address, payTo: Address) {
  const [stepRows, pocketRows] = await Promise.all([
    sql(
      `SELECT COALESCE(sum(amount::numeric), 0)::text AS total
       FROM gateway_transfers WHERE lower(from_address)=lower($1)
         AND lower(to_address)=lower($2) AND status='completed'`,
      [pocket, payTo],
    ),
    sql(
      `SELECT COALESCE(sum(amount::numeric), 0)::text AS total
       FROM gateway_transfers WHERE lower(from_address)=lower($1) AND status='completed'`,
      [pocket],
    ),
  ]);
  return {
    step: BigInt(String(stepRows.rows[0]?.["total"] ?? "0")),
    pocket: BigInt(String(pocketRows.rows[0]?.["total"] ?? "0")),
  };
}

function serverProjection(
  sql: Sql,
): Pick<
  Projection,
  | "storedPlan"
  | "settledPayment"
  | "job"
  | "reportExists"
  | "checksCommitExists"
  | "latestEvidenceRoot"
  | "evidenceBatchExists"
> {
  return {
    storedPlan: async (vault, hash) => {
      const result = await sql(
        `SELECT p.plan, p.state, o.state AS objective_state
         FROM plans p JOIN objectives o USING (objective_id)
         JOIN users u USING (user_id)
         WHERE lower(p.plan_hash)=lower($1) AND lower(u.vault)=lower($2)
           AND NOT EXISTS (
             SELECT 1 FROM envelopes e WHERE lower(e.mirror->>'planHash')=lower(p.plan_hash)
           )
         LIMIT 1`,
        [hash, vault],
      );
      const row = result.rows[0];
      return row === undefined
        ? undefined
        : readStoredPlan(row["plan"], row["state"], row["objective_state"]);
    },
    settledPayment: (vault, paymentRef) => hasSettledPayment(sql, vault, paymentRef),
    job: (escrow, id) => readJob(sql, escrow, id),
    reportExists: (hash) => exists(sql, "acceptance_reports", "report_hash", hash),
    checksCommitExists: (hash) => checksCommitExists(sql, hash),
    latestEvidenceRoot: (publisher, kind) => latestEvidenceRoot(sql, publisher, kind),
    evidenceBatchExists: (root) => evidenceBatchExists(sql, root),
  };
}

async function hasSettledPayment(
  sql: Sql,
  vault: Address,
  paymentRef: PaymentRef,
): Promise<boolean> {
  const result = await settledPaymentQuery(sql, vault, paymentRef);
  return result.rows.length > 0;
}

async function settledPaymentQuery(
  sql: Sql,
  vault: Address,
  paymentRef: PaymentRef,
): Promise<SqlRows> {
  switch (paymentRef.rail) {
    case "x402-exact":
      return sql(
        `SELECT 1 FROM authorizations
         WHERE lower(vault)=lower($1) AND lower(nonce)=lower($2)
           AND amount::numeric=$3::numeric AND settled=true LIMIT 1`,
        [vault, paymentRef.nonce, paymentRef.amount],
      );
    case "gateway-batched":
      return sql(
        `SELECT 1 FROM gateway_transfers
         WHERE lower(from_address)=lower($1) AND lower(nonce)=lower($2)
           AND lower(to_address)=lower($3) AND amount::numeric=$4::numeric
           AND status='completed' LIMIT 1`,
        [paymentRef.payer, paymentRef.nonce, paymentRef.payTo, paymentRef.amount],
      );
    case "erc8183-job":
      return sql(
        `SELECT 1 FROM jobs
         WHERE lower(job_escrow)=lower($1) AND job_id=$2 AND state='Completed'
           AND lower(mirror->>'provider')=lower($3)
           AND (mirror->>'budget')::numeric=$4::numeric LIMIT 1`,
        [paymentRef.contract, paymentRef.jobId, paymentRef.provider, paymentRef.budget],
      );
    case "mpp":
      return { rows: [] };
  }
}

async function readJob(sql: Sql, escrow: Address, jobId: bigint) {
  const result = await sql(
    "SELECT mirror FROM jobs WHERE lower(job_escrow)=lower($1) AND job_id=$2 LIMIT 1",
    [escrow, jobId.toString()],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  const mirror = asRecord(row["mirror"]);
  return {
    evaluator: String(mirror["evaluator"]) as Address,
    clientVault: String(mirror["vault"]) as Address,
  };
}

async function exists(sql: Sql, table: string, column: string, value: string): Promise<boolean> {
  const result = await sql(`SELECT 1 FROM ${table} WHERE lower(${column})=lower($1) LIMIT 1`, [
    value,
  ]);
  return result.rows.length > 0;
}

async function checksCommitExists(sql: Sql, hash: Hash32): Promise<boolean> {
  const result = await sql(
    "SELECT 1 FROM evidence_receipts WHERE lower(receipt->>'localChecksCommit')=lower($1) LIMIT 1",
    [hash],
  );
  return result.rows.length > 0;
}

async function latestEvidenceRoot(sql: Sql, publisher: Address, kind: number): Promise<Hash32> {
  const result = await sql(
    `SELECT root FROM anchors WHERE lower(publisher)=lower($1) AND kind=$2
     ORDER BY seq::numeric DESC LIMIT 1`,
    [publisher, kind],
  );
  return (result.rows[0]?.["root"] as Hash32 | undefined) ?? ZERO32;
}

async function evidenceBatchExists(sql: Sql, root: Hash32): Promise<boolean> {
  const result = await sql(
    "SELECT 1 FROM anchors WHERE lower(batch_root)=lower($1) OR lower(root)=lower($1) LIMIT 1",
    [root],
  );
  return result.rows.length > 0;
}

async function loadPlanByHash(sql: Sql, hash: string): Promise<unknown> {
  const result = await sql("SELECT plan FROM plans WHERE lower(plan_hash)=lower($1) LIMIT 1", [
    hash,
  ]);
  return result.rows[0]?.["plan"];
}

function readStoredPlan(raw: unknown, state: unknown, objectiveState: unknown): StoredPlan {
  const plan = asRecord(raw);
  const steps = Array.isArray(plan["steps"]) ? plan["steps"].map(asRecord) : [];
  const auto = state === "offered" && objectiveState === "opening";
  return {
    planHash: String(plan["planHash"]) as Hash32,
    payeeRoot: String(plan["payeeRoot"]) as Hash32,
    objectiveHash: String(plan["objectiveHash"]) as Hash32,
    categoryId: keccak256(stringToHex(String(plan["category"]))) as Hash32,
    cap: BigInt(String(plan["cap"])),
    maxStepAmount: BigInt(String(plan["maxStepAmount"])),
    pocketCapBps: Number(plan["pocketCapBps"]),
    expiresAt: BigInt(String(plan["expiresAt"])),
    approval: auto ? "auto-approvable" : state === "approved" ? "owner-approved" : "needs-approval",
    hasNanoStep: steps.some((step) => step["kind"] === "gateway-nano"),
  };
}

function toPlanLeaves(raw: unknown): PlanLeaf[] {
  const plan = asRecord(raw);
  const steps = Array.isArray(plan["steps"]) ? plan["steps"].map(asRecord) : [];
  const leaves = Array.isArray(plan["payeeLeaves"]) ? plan["payeeLeaves"].map(asRecord) : [];
  const stepByIndex = new Map(steps.map((step) => [Number(step["stepIndex"]), step]));
  return leaves.map((leaf) => planLeaf(leaf, stepByIndex));
}

function planLeaf(
  leaf: Record<string, unknown>,
  steps: Map<number, Record<string, unknown>>,
): PlanLeaf {
  const stepIndex = Number(leaf["stepIndex"]);
  if (Number(leaf["kind"]) === 4)
    return {
      stepIndex,
      payee: String(leaf["payee"]) as Address,
      kind: 4,
      stepCap: 0n,
      stepKind: "pocket",
      expectedCalls: 1,
      usedCalls: 0,
    };
  const step = steps.get(stepIndex);
  if (step === undefined) throw new Error(`plan leaf references missing step ${stepIndex}`);
  return {
    stepIndex,
    payee: String(leaf["payee"]) as Address,
    kind: Number(leaf["kind"]),
    stepCap: BigInt(String(leaf["stepCap"])),
    stepKind: String(step["kind"]) as PlanLeaf["stepKind"],
    expectedCalls: Number(step["expectedCalls"]),
    usedCalls: 0,
  };
}

function enumValue<const T extends readonly string[]>(
  values: T,
  index: number,
): Exclude<T[number], ""> {
  const value = values[index];
  if (value === undefined || value === "")
    throw new Error(`unsupported on-chain enum value ${index}`);
  return value as Exclude<T[number], "">;
}

function pocketState(value: unknown): PocketView["state"] {
  if (value === "DelegateReady") return "Registered";
  if (["Registered", "Funded", "Draining", "Closed"].includes(String(value)))
    return value as PocketView["state"];
  throw new Error(`unsupported indexed pocket state ${String(value)}`);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return asRecord(JSON.parse(value) as unknown);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("projection row contains malformed JSON");
  return value as Record<string, unknown>;
}
