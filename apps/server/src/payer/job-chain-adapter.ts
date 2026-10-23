import { decodeEventLog, type Address, type Hex, type PublicClient } from "viem";
import { czarJobEscrowAbi, czarVaultAbi, czarVaultFactoryAbi } from "@czar/vault-client";
import type { Config } from "@czar/config";
import type { JobBrief } from "@czar/schemas";
import type { Pool } from "pg";
import type { Hash32 } from "@czar/hashing";
import type { JobChain, JobChainView } from "#src/payer/job";

const VAULT_OPEN = 1;
const VAULT_FUNDED = 2;
const VAULT_SUBMITTED = 3;
const VAULT_COMPLETED = 4;
const VAULT_REFUNDED = 5;
const VAULT_RELEASED = 6;
const ESCROW_OPEN = 0;
const ESCROW_FUNDED = 1;
const ESCROW_SUBMITTED = 2;
const ESCROW_COMPLETED = 3;
const ESCROW_REJECTED = 4;
const ESCROW_EXPIRED = 5;
const MILLISECONDS_PER_SECOND = 1_000;

export function createJobChainAdapter(input: {
  readonly client: PublicClient;
  readonly pool: Pool;
  readonly config: Config;
  readonly vault: Address;
  readonly jobEscrow: Address;
  readonly usdc: Address;
  readonly now: () => Date;
}): JobChain {
  async function send(transaction: Hex): Promise<string> {
    const hash = await input.client.sendRawTransaction({ serializedTransaction: transaction });
    const receipt = await input.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`Job transaction reverted: ${hash}`);
    return hash;
  }

  async function readView(jobKeyValue: Hash32): Promise<JobChainView & { readonly jobId: bigint }> {
    const vaultJob = await input.client.readContract({
      address: input.vault,
      abi: czarVaultAbi,
      functionName: "getJob",
      args: [jobKeyValue],
    });
    const escrowJob = await input.client.readContract({
      address: input.jobEscrow,
      abi: czarJobEscrowAbi,
      functionName: "getJob",
      args: [vaultJob.jobId],
    });
    return {
      vaultState: mapVaultState(Number(vaultJob.state)),
      escrowState: mapEscrowState(Number(escrowJob.status)),
      ...(BigInt(escrowJob.budget) > 0n ? { budget: BigInt(escrowJob.budget) } : {}),
      expiredAt: Number(vaultJob.expiredAt),
      jobId: BigInt(vaultJob.jobId),
    };
  }

  async function waitForStatus(
    jobKeyValue: Hash32,
    isComplete: (view: JobChainView) => boolean,
    timeoutMs: number,
  ): Promise<JobChainView> {
    const first = await readView(jobKeyValue);
    if (isComplete(first)) return first;
    const pollingInterval = Number(input.config.get("payer.vaultEventPollMs"));
    return new Promise((resolve, reject) => {
      let closed = false;
      let stop: (() => void) | undefined;
      const timer = setTimeout(() => {
        void readView(jobKeyValue).then(finish, fail);
      }, timeoutMs);
      timer.unref();
      const finish = (view: JobChainView) => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        stop?.();
        resolve(view);
      };
      const fail = (error: Error) => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        stop?.();
        reject(error);
      };
      stop = input.client.watchContractEvent({
        address: input.jobEscrow,
        abi: czarJobEscrowAbi,
        pollingInterval,
        onLogs: () => {
          void readView(jobKeyValue).then((view) => {
            if (isComplete(view)) finish(view);
          }, fail);
        },
        onError: fail,
      });
    });
  }

  return {
    async findJob(search) {
      const rows = await input.pool.query<{ readonly job_key: Hash32; readonly job_id: string }>(
        `SELECT payload->>'jobKey' AS job_key,payload->>'jobId' AS job_id
         FROM step_executions
         WHERE plan_id=$1 AND step_index=$2 AND phase='job.opened'
           AND lower(payload->>'provider')=lower($3)
         ORDER BY execution_id DESC LIMIT 1`,
        [search.planId, search.stepIndex, search.provider],
      );
      const row = rows.rows[0];
      return row ? { jobKey: row.job_key, jobId: BigInt(row.job_id) } : undefined;
    },
    async openJob(transaction) {
      const hash = await send(transaction);
      const receipt = await input.client.getTransactionReceipt({ hash: hash as Hex });
      const event = receipt.logs
        .filter((log) => log.address.toLowerCase() === input.vault.toLowerCase())
        .map((log) => {
          try {
            return decodeEventLog({
              abi: czarVaultAbi,
              eventName: "JobOpened",
              data: log.data,
              topics: log.topics,
            });
          } catch {
            return undefined;
          }
        })
        .find((decoded) => decoded !== undefined);
      if (!event) throw new Error("Mined openJob did not emit JobOpened.");
      return { jobKey: event.args.jobKey, jobId: BigInt(event.args.jobId), txHash: hash };
    },
    getJob: async (jobKeyValue) => readView(jobKeyValue),
    waitForBudget: async (jobKeyValue, timeoutMs) => {
      const current = await readView(jobKeyValue);
      if (current.budget && current.budget > 0n) return current.budget;
      if (timeoutMs <= 0) return undefined;
      const result = await waitForStatus(
        jobKeyValue,
        (view) => Boolean(view.budget && view.budget > 0n),
        timeoutMs,
      );
      return result.budget && result.budget > 0n ? result.budget : undefined;
    },
    fundJob: async (args) => send(args.transaction),
    async syncJob(args) {
      const txHash = await send(args.transaction);
      const state = (await readView(args.jobKey)).vaultState;
      return { state, txHash };
    },
    cancelJob: async (args) => send(args.transaction),
    claimJobRefund: async (args) => send(args.transaction),
    async waitForResult(jobKeyValue, expiredAt) {
      const timeoutMs = Math.max(0, expiredAt * 1000 - input.now().getTime());
      return waitForStatus(
        jobKeyValue,
        (view) =>
          view.escrowState === "Submitted" ||
          view.escrowState === "Completed" ||
          view.escrowState === "Rejected" ||
          view.escrowState === "Expired",
        timeoutMs,
      );
    },
    async isFrozenOrPaused(vault) {
      const [frozen, factory] = await Promise.all([
        input.client.readContract({ address: vault, abi: czarVaultAbi, functionName: "frozen" }),
        input.client.readContract({ address: vault, abi: czarVaultAbi, functionName: "factory" }),
      ]);
      const paused = await input.client.readContract({
        address: factory,
        abi: czarVaultFactoryAbi,
        functionName: "guardianPaused",
      });
      return frozen || paused;
    },
    async envelopeOpen(envelopeId) {
      const envelope = await input.client.readContract({
        address: input.vault,
        abi: czarVaultAbi,
        functionName: "getEnvelope",
        args: [envelopeId],
      });
      return Number(envelope.state) === VAULT_OPEN;
    },
    async hasDecisionPending(jobKeyValue) {
      const view = await readView(jobKeyValue);
      if (view.escrowState !== "Submitted") return false;
      const rows = await input.pool.query<{ readonly brief: JobBrief }>(
        "SELECT brief FROM payer_job_briefs WHERE lower(job_key)=lower($1)",
        [jobKeyValue],
      );
      const cutoff = rows.rows[0]?.brief.decisionCutoff;
      if (typeof cutoff !== "number" || !Number.isSafeInteger(cutoff)) return true;
      return input.now().getTime() < cutoff * MILLISECONDS_PER_SECOND;
    },
  };
}

function mapVaultState(state: number): JobChainView["vaultState"] {
  if (state === VAULT_OPEN) return "Opened";
  if (state === VAULT_FUNDED) return "Funded";
  if (state === VAULT_SUBMITTED) return "Submitted";
  if (state === VAULT_COMPLETED) return "Completed";
  if (state === VAULT_REFUNDED) return "Expired";
  if (state === VAULT_RELEASED) return "Released";
  throw new Error(`Unknown vault job state ${state}.`);
}

function mapEscrowState(state: number): NonNullable<JobChainView["escrowState"]> {
  if (state === ESCROW_OPEN) return "Open";
  if (state === ESCROW_FUNDED) return "Funded";
  if (state === ESCROW_SUBMITTED) return "Submitted";
  if (state === ESCROW_COMPLETED) return "Completed";
  if (state === ESCROW_REJECTED) return "Rejected";
  if (state === ESCROW_EXPIRED) return "Expired";
  throw new Error(`Unknown external escrow state ${state}.`);
}
