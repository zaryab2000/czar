import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hex,
} from "viem";
import {
  derivedNonce,
  objectiveHash,
  slReceiptDigest,
  taskSpecHash,
  type SlReceipt,
} from "@czar/hashing";
import { czarVaultAbi, czarVaultFactoryAbi, withFeeFloor } from "@czar/vault-client";
import type { ObjectiveSubmission, Receipt, TaskSpec } from "@czar/schemas";
import { ulid } from "#src/http/ids";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");
const RPC_URL = process.env["CZAR_T050A_ARC_RPC_URL"] ?? "http://127.0.0.1:8545";
const SERVER_URL = process.env["CZAR_T050A_SERVER_URL"] ?? "http://127.0.0.1:3000";
const MERCHANT_URL = process.env["CZAR_T050A_MERCHANT_URL"] ?? "http://127.0.0.1:8787";
const DATABASE_URL =
  process.env["CZAR_T050A_DATABASE_URL"] ?? "postgres://postgres@127.0.0.1:15433/postgres";
const CHAIN_ID = 5_042_002;
const NETWORK = `eip155:${CHAIN_ID}`;
const USDC: Address = "0x3600000000000000000000000000000000000000";
const FUNDING_AMOUNT = 1_000_000n;
const USDC_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 value) returns (bool)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
]);
const chain = defineChain({
  id: CHAIN_ID,
  name: "Arc local",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
const walletClient = createWalletClient({ chain, transport: http(RPC_URL) });
const random = { bytes: randomBytes };
const pool = new Pool({ connectionString: DATABASE_URL });

interface LocalDeployment {
  readonly CzarVaultFactory: Address;
}

interface ObjectiveRow {
  readonly state: string;
  readonly plan_id: string | null;
  readonly plan: { readonly cap: string; readonly steps: readonly { serviceId: string }[] } | null;
  readonly envelope_ref: string | null;
  readonly result_id: string | null;
}

const RECEIPT_OUTCOME: Readonly<Record<Receipt["outcome"], number>> = {
  delivered: 0,
  "http-error": 1,
  timeout: 2,
  "no-response": 3,
  unknown: 4,
  skipped: 5,
};

async function main(): Promise<void> {
  const startedAt = await publicClient.getBlockNumber();
  await assertServiceHealth(`${SERVER_URL}/health`);
  await assertServiceHealth(`${MERCHANT_URL}/health`);
  assert.equal(await publicClient.getChainId(), CHAIN_ID, "Arc local chain id mismatch");

  const deployment = await readDeployment();
  const owner = await testOwner();
  const vault = await ensureVault(deployment.CzarVaultFactory, owner);
  await fundVault(owner, vault);
  const identity = await createTestIdentity(owner, vault);
  const submission = makeSubmission(identity.deviceId);
  const accepted = await submitObjective(identity.deviceToken, submission);
  assert.equal(accepted.status, 202, "objective submission failed");

  const planned = await waitForPlan(submission.objectiveId);
  assert.ok(planned.plan_id, "objective did not receive a plan");
  assert.ok(
    planned.plan?.steps.some((step) => step.serviceId === "svc_223349701b9428c8a6dc42d8a7c99c4a"),
  );
  const approval = await createApprovalIntent(identity.sessionToken, planned.plan_id);
  const approvalTx = await walletClient.sendTransaction({
    account: owner,
    to: approval.to,
    data: approval.calldata,
    value: BigInt(approval.value),
    ...withFeeFloor({ maxFeePerGas: await publicClient.getGasPrice() }),
  });
  await publicClient.waitForTransactionReceipt({ hash: approvalTx });
  await notifySubmitted(identity.sessionToken, planned.plan_id, approvalTx);

  const completed = await waitForCompletion(submission.objectiveId);
  assert.ok(completed.envelope_ref, "objective has no opened envelope");
  assert.ok(completed.result_id, "objective has no result row");
  const evidence = await verifyEvidence(completed, startedAt, vault, submission.objectiveId);
  const trace = await readExecutionTransactions(planned.plan_id);
  process.stdout.write(
    `${JSON.stringify(
      {
        task: "T-050a",
        objectiveId: submission.objectiveId,
        planId: planned.plan_id,
        userId: identity.userId,
        vault,
        objectiveState: completed.state,
        resultId: completed.result_id,
        approvalTx,
        transactionHashes: trace,
        events: evidence.events,
        eventTransactionHashes: evidence.eventTransactionHashes,
        authorizationUsed: evidence.authorizationUsed,
        receiptRows: evidence.receiptRows,
        receiptVerified: evidence.receiptVerified,
        failedReason: evidence.failedReason,
      },
      null,
      2,
    )}\n`,
  );
}

async function readDeployment(): Promise<LocalDeployment> {
  const contents = await readFile(resolve(ROOT, "deployments/arc-local.json"), "utf8");
  const manifest = JSON.parse(contents) as Partial<LocalDeployment>;
  assert.ok(manifest.CzarVaultFactory, "local deployment manifest has no CzarVaultFactory");
  return { CzarVaultFactory: manifest.CzarVaultFactory };
}

async function testOwner(): Promise<Address> {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_accounts", params: [] }),
  });
  assert.equal(response.status, 200, "local Arc RPC is unavailable");
  const payload = (await response.json()) as { result?: Address[] };
  const owner = payload.result?.[1];
  assert.ok(owner, "Arc Anvil has no unlocked test-owner account");
  return owner;
}

async function ensureVault(factory: Address, owner: Address): Promise<Address> {
  const existing = await publicClient.readContract({
    address: factory,
    abi: czarVaultFactoryAbi,
    functionName: "vaultOf",
    args: [owner],
  });
  if (existing !== "0x0000000000000000000000000000000000000000") return existing;
  const hash = await walletClient.writeContract({
    account: owner,
    address: factory,
    abi: czarVaultFactoryAbi,
    functionName: "createVault",
    args: [owner],
    ...withFeeFloor({ maxFeePerGas: await publicClient.getGasPrice() }),
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return publicClient.readContract({
    address: factory,
    abi: czarVaultFactoryAbi,
    functionName: "vaultOf",
    args: [owner],
  });
}

async function fundVault(owner: Address, vault: Address): Promise<void> {
  const balance = await publicClient.readContract({
    address: USDC,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: [vault],
  });
  if (balance >= FUNDING_AMOUNT) return;
  const ownerBalance = await publicClient.readContract({
    address: USDC,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: [owner],
  });
  const amount = FUNDING_AMOUNT - balance;
  assert.ok(ownerBalance >= amount, "test owner lacks local USDC to fund the test vault");
  const hash = await walletClient.writeContract({
    account: owner,
    address: USDC,
    abi: USDC_ABI,
    functionName: "transfer",
    args: [vault, amount],
    ...withFeeFloor({ maxFeePerGas: await publicClient.getGasPrice() }),
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", "local USDC funding transaction failed");
}

async function createTestIdentity(owner: Address, vault: Address) {
  const now = new Date();
  const userId = ulid("usr_", now, random);
  const deviceId = ulid("dev_", now, random);
  const token = randomBytes(32).toString("base64url");
  const session = randomBytes(32).toString("base64url");
  await pool.query(
    "INSERT INTO users(user_id,msca,vault,network,mode) VALUES($1,$2,$3,$4,'live')",
    [userId, owner, vault, NETWORK],
  );
  await pool.query(
    `INSERT INTO devices(device_id,user_id,device_name,platform,token_hash)
     VALUES($1,$2,'T-050a local owner fixture','macos',$3)`,
    [deviceId, userId, sha256(token)],
  );
  await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)", [
    sha256(session),
    userId,
    new Date(now.getTime() + 3_600_000),
  ]);
  return { userId, deviceId, deviceToken: token, sessionToken: session };
}

function makeSubmission(deviceId: string): ObjectiveSubmission {
  const now = new Date();
  const taskSpec: TaskSpec = {
    schemaVersion: "1.1",
    kind: "table-fill",
    topic: "Local fixture search",
    subjects: [{ label: "Czar local fixture" }],
    fields: ["title", "url", "snippet"],
    sourceTrust: "user-prompt",
  };
  const objectiveId = ulid("obj_", now, random);
  const taskHash = taskSpecHash(taskSpec);
  const fields = {
    objectiveId,
    soulVersionHash: `0x${"1".repeat(64)}` as const,
    observationHashes: [`0x${"2".repeat(64)}`],
    detector: "placeholder" as const,
    goal: "Find one result in the local fixture search backend",
    capabilities: ["web-search"],
    minutesSaved: 1,
    hourlyBand: "B" as const,
    taskSpecHash: taskHash,
  };
  const { taskSpecHash: computedTaskHash, ...submissionFields } = fields;
  return {
    schemaVersion: "1.0",
    ...submissionFields,
    objectiveHash: objectiveHash({ ...submissionFields, taskSpecHash: computedTaskHash }),
    redaction: { layer2: { hits: 0, entities: [] } },
    deviceId,
    submittedAt: now.toISOString(),
    taskSpec,
  };
}

async function submitObjective(token: string, body: ObjectiveSubmission) {
  return fetch(`${SERVER_URL}/v1/objectives`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify(body),
  });
}

async function waitForPlan(objectiveId: string): Promise<ObjectiveRow> {
  return pollObjective(objectiveId, (row) => row.plan_id !== null || row.state === "no-supplier");
}

async function createApprovalIntent(session: string, planId: string) {
  const response = await fetch(`${SERVER_URL}/v1/approvals/${planId}/intent`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session}`,
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify({ fillInPlace: true }),
  });
  assert.equal(response.status, 200, `approval intent failed: ${response.status}`);
  return (await response.json()) as {
    readonly to: Address;
    readonly calldata: Hex;
    readonly value: string;
  };
}

async function notifySubmitted(session: string, planId: string, transaction: Hex): Promise<void> {
  const response = await fetch(`${SERVER_URL}/v1/approvals/${planId}/submitted`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session}`,
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify({ userOpHash: transaction, bundler: "arc-anvil-test-owner" }),
  });
  assert.equal(response.status, 202, `approval submission notice failed: ${response.status}`);
}

async function waitForCompletion(objectiveId: string): Promise<ObjectiveRow> {
  return pollObjective(objectiveId, (row) => row.state === "delivered" || row.state === "failed");
}

async function pollObjective(
  objectiveId: string,
  done: (row: ObjectiveRow) => boolean,
): Promise<ObjectiveRow> {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const result = await pool.query<ObjectiveRow>(
      `SELECT o.state,o.plan_id,o.envelope_ref,o.result_id,p.plan
       FROM objectives o LEFT JOIN plans p ON p.plan_id=o.plan_id
       WHERE o.objective_id=$1`,
      [objectiveId],
    );
    const row = result.rows[0];
    assert.ok(row, `objective disappeared: ${objectiveId}`);
    if (row.state === "no-supplier") throw new Error("planner found no supplier for T-050a");
    if (done(row)) return row;
    await delay(1_000);
  }
  throw new Error(`timed out waiting for objective ${objectiveId}`);
}

async function verifyEvidence(
  objective: ObjectiveRow,
  fromBlock: bigint,
  vault: Address,
  objectiveId: string,
) {
  const logs = await publicClient.getLogs({ address: vault, fromBlock, toBlock: "latest" });
  const parsed = parseEventLogs({ abi: czarVaultAbi, logs, strict: false });
  const events = parsed.map((event): string => event.eventName);
  for (const required of ["Reserved", "Settled", "ReservationFinal", "EnvelopeClosed"])
    assert.ok(
      events.some((event) => event === required),
      `missing ${required} event`,
    );
  const final = parsed.find((event) => event.eventName === "ReservationFinal");
  assert.ok(final && final.args.settledCount === 1 && final.args.releasedCount === 0);
  const closed = parsed.find((event) => event.eventName === "EnvelopeClosed");
  assert.ok(closed, "missing EnvelopeClosed event");

  const receipts = await pool.query<{ receipt: Receipt }>(
    "SELECT receipt FROM evidence_receipts WHERE envelope_ref=$1",
    [objective.envelope_ref],
  );
  assert.equal(receipts.rowCount, 1, "expected one evidence_receipts row");
  const receipt = receipts.rows[0]?.receipt;
  assert.ok(receipt?.sig && receipt.payment.rail === "x402-exact");
  const reservationId = receipt.payment.reservationId;
  const authorizationIndex = receipt.payment.index;
  assert.ok(reservationId !== undefined && authorizationIndex !== undefined);
  assert.equal(authorizationIndex, 0, "expected the first authorization in one-call slice");
  assertEventReservation(parsed, BigInt(reservationId), authorizationIndex);
  const authorization = await verifyAuthorization(receipt, fromBlock, vault);
  const verified = await verifyReceiptSignature(receipt, vault);
  assert.equal(verified, "0x1626ba7e", "receipt signature failed SL_RECEIPT validation");
  const result = await pool.query<{ result_id: string }>(
    "SELECT result_id FROM results WHERE objective_id=$1",
    [objectiveId],
  );
  assert.equal(result.rowCount, 1, "expected one results row");
  assert.equal(result.rows[0]?.result_id, objective.result_id);
  const failure = await pool.query<{ payload: { reason?: string } }>(
    "SELECT payload FROM outbox_events WHERE name='objective.failed' AND objective_id=$1",
    [objectiveId],
  );
  const failedReason = failure.rows[0]?.payload.reason;
  assert.ok(
    objective.state === "delivered" ||
      (objective.state === "failed" && failedReason === "result-quarantined"),
    "unexpected objective completion state",
  );
  return {
    events,
    eventTransactionHashes: [
      ...new Set(
        parsed.map((event) => event.transactionHash).filter((hash): hash is Hex => !!hash),
      ),
    ],
    authorizationUsed: authorization,
    receiptRows: receipts.rowCount,
    receiptVerified: true,
    failedReason,
  };
}

function assertEventReservation(
  events: ReturnType<typeof parseEventLogs<typeof czarVaultAbi, false>>,
  reservationId: bigint,
  authorizationIndex: number,
): void {
  const reserved = events.find((event) => event.eventName === "Reserved");
  assert.ok(reserved && reserved.args.reservationId === reservationId);
  const settled = events.find((event) => event.eventName === "Settled");
  assert.ok(
    settled &&
      settled.args.reservationId === reservationId &&
      settled.args.index === authorizationIndex,
  );
  const finalized = events.find((event) => event.eventName === "ReservationFinal");
  assert.ok(finalized && finalized.args.reservationId === reservationId);
}

async function verifyAuthorization(
  receipt: Receipt,
  fromBlock: bigint,
  vault: Address,
): Promise<{ readonly authorizer: Address; readonly nonce: Hex }> {
  assert.equal(receipt.payment.rail, "x402-exact");
  const txHash = receipt.payment.settlementTx;
  assert.ok(txHash, "settled PaymentRef has no settlement transaction");
  const transactionReceipt = await publicClient.getTransactionReceipt({ hash: txHash as Hex });
  const parsed = parseEventLogs({ abi: USDC_ABI, logs: transactionReceipt.logs, strict: false });
  const event = parsed.find((log) => log.eventName === "AuthorizationUsed");
  assert.ok(event, "settlement transaction lacks USDC AuthorizationUsed");
  const authorizer = event.args.authorizer;
  const nonce = event.args.nonce;
  assert.ok(authorizer && nonce, "AuthorizationUsed event arguments are missing");
  assert.equal(authorizer.toLowerCase(), vault.toLowerCase());
  assert.equal(nonce.toLowerCase(), receipt.payment.nonce.toLowerCase());
  assert.ok(receipt.payment.reservationId !== undefined && receipt.payment.index !== undefined);
  assert.equal(
    nonce.toLowerCase(),
    derivedNonce(vault, BigInt(receipt.payment.reservationId), receipt.payment.index).toLowerCase(),
  );
  assert.ok(transactionReceipt.blockNumber >= fromBlock);
  return { authorizer, nonce };
}

async function verifyReceiptSignature(receipt: Receipt, vault: Address) {
  const timing = receipt.timing;
  const request = receipt.request;
  const response = receipt.response;
  const attestation: SlReceipt = {
    paymentRefHash: receipt.payment_ref_hash as `0x${string}`,
    requestCommit: request?.commit as `0x${string}`,
    responseCommit: response?.commit as `0x${string}`,
    statusCode: response?.status_code ?? 200,
    originAsserted: receipt.origin_asserted,
    requirementsHashSeen: (receipt.requirements_hash_seen ??
      `0x${"0".repeat(64)}`) as `0x${string}`,
    tRequest: BigInt(timing?.t_request ?? 0),
    tPaymentSigned: BigInt(timing?.t_payment_signed ?? 0),
    tComplete: BigInt(timing?.t_complete ?? 0),
    outcome: RECEIPT_OUTCOME[receipt.outcome],
    localChecksCommit: (receipt.local_checks?.checks_commit ??
      `0x${"0".repeat(64)}`) as `0x${string}`,
    disclosure:
      receipt.disclosure === "public" ? 0 : receipt.disclosure === "validator-only" ? 1 : 2,
    createdAt: BigInt(timing?.t_complete ?? 0),
  };
  return publicClient.readContract({
    address: vault,
    abi: czarVaultAbi,
    functionName: "isValidSignature",
    args: [slReceiptDigest(CHAIN_ID, attestation), receipt.sig as Hex],
  });
}

async function readExecutionTransactions(planId: string): Promise<string[]> {
  const result = await pool.query<{ payload: { txHash?: string } }>(
    "SELECT payload FROM step_executions WHERE plan_id=$1 ORDER BY execution_id",
    [planId],
  );
  return result.rows
    .map((row) => row.payload.txHash)
    .filter((hash): hash is string => typeof hash === "string");
}

async function assertServiceHealth(url: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
  assert.equal(response.status, 200, `${url} is not healthy`);
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown T-050a failure";
    process.stderr.write(`T-050a failed: ${message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => pool.end());
