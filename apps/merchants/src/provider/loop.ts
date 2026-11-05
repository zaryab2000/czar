// One CZ-20 §5.11 test-provider instance: the loop, one job at a time, with its behaviour mode.
//
//   1. watch `JobCreated` with `provider == own key`
//   2. fetch the brief with a signed `BriefRequest`; recompute `inputCommit` and `descriptionHash`
//   3. refuse an evaluator other than K7, or a `submitBy` closer than `minWorkSeconds`
//   4. `setBudget(jobId, targetBudget, "")`
//   5. wait for `JobFunded`
//   6. do the work for its work mode
//   7. upload the bytes (`DeliverableUpload`), then `submit(jobId, keccak256(bytes), "")` before `submitBy`
//
// Every signature comes from the signer's `provider-call` kind (CZ-27); this module holds key references only.
import { jobKey as jobKeyOf, type Address, type Hash32 } from "@czar/hashing";
import type { Logger } from "@czar/logging";
import type { JobBrief } from "@czar/schemas";
import type { SignResult } from "@czar/signer";
import { keccak256, recoverAddress, type Hex } from "viem";
import { BriefRefused, verifyBrief } from "#src/provider/brief";
import {
  PROVIDER_INSTANCES,
  parseModes,
  type BehaviourMode,
  type ProviderInstanceId,
} from "#src/provider/modes";
import type { JobCreated, JobServer, ProviderChain, ProviderSigner } from "#src/provider/ports";
import { DEFAULT_WORK_MODES, junkDeliverable, type WorkMode } from "#src/provider/work";

const MS_PER_SECOND = 1000;

/** How a job ended for this instance. `rule` names why, in the log vocabulary (one lowercase token). */
export interface JobOutcome {
  readonly jobId: bigint;
  readonly jobKey: Hash32;
  readonly behaviour: BehaviourMode;
  /**
   * `submitted`: the escrow accepted `submit`. `stopped`: the behaviour mode ended the job on purpose (`silent`).
   * `refused`: the instance or the signer refused a step. `abandoned`: the job was not funded, or ran past
   * `submitBy`, in time. `failed`: a call failed (server, chain or signer error).
   */
  readonly outcome: "submitted" | "stopped" | "refused" | "abandoned" | "failed";
  readonly rule: string;
  readonly budget?: bigint;
  readonly contentHash?: Hash32;
}

export interface ProviderInstanceOptions {
  readonly instance: ProviderInstanceId;
  /** `merchants.provider.<instance>.modes`. */
  readonly modes: readonly string[];
  /** `merchants.provider.<instance>.minWorkSeconds`. */
  readonly minWorkSeconds: number;
  /** `merchants.provider.pollMs`. */
  readonly pollMs: number;
  /** The chain the signer and the escrow are on; the brief's `network` must be `eip155:<chainId>`. */
  readonly chainId: number;
  /** Czar's evaluator K7: a job with any other evaluator is refused before any signature. */
  readonly evaluator: Address;
  readonly signer: ProviderSigner;
  readonly chain: ProviderChain;
  readonly server: JobServer;
  /**
   * The instance key's public address. Left out, `start` asks the signer's `keyAddress`. CZ-27's `keyAddress` row
   * (SCR-129) does not list K21a/K21b yet, so the signer answers `key-not-allowed` until that row is extended
   * (PM-046 spec problem); every signature still comes from the signer and is checked against this address.
   */
  readonly providerAddress?: Address;
  /** The work modes this instance can run. Default: the ones this build ships. */
  readonly workModes?: readonly WorkMode[];
  /** Wall clock, milliseconds: `issuedAt` of `BriefRequest` and `DeliverableUpload` (the server checks its age). */
  readonly nowMs?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly logger?: Pick<Logger, "info" | "warn">;
  readonly onOutcome?: (outcome: JobOutcome) => void;
}

export interface ProviderInstance {
  readonly instance: ProviderInstanceId;
  readonly behaviour: BehaviourMode;
  readonly workMode: string;
  /** Resolves the instance's own address through the signer and starts watching after the latest block. */
  start(): Promise<Address>;
  /** One watch step: reads new `JobCreated` events, then runs every queued job to its end, oldest first. */
  tick(): Promise<readonly JobOutcome[]>;
  /** Calls `tick` every `pollMs` until `stop`. */
  run(): Promise<void>;
  stop(): void;
  /** Runs the loop for one job (steps 2–7). Exposed for tests; `tick` is the production path. */
  handle(job: JobCreated): Promise<JobOutcome>;
}

class Stop extends Error {
  readonly outcome: JobOutcome["outcome"];
  readonly rule: string;
  constructor(outcome: JobOutcome["outcome"], rule: string) {
    super(rule);
    this.name = "Stop";
    this.outcome = outcome;
    this.rule = rule;
  }
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const isDenied = (error: unknown): error is { rule: string } =>
  error instanceof Error &&
  error.name === "Denied" &&
  typeof (error as { rule?: unknown }).rule === "string";

/** The digest signature, checked to come from this instance's address (an injected address must be the key's). */
async function signature(result: SignResult, provider: Address): Promise<Hex> {
  if (!("signature" in result)) throw new Stop("failed", "signer-no-signature");
  const recovered = await recoverAddress({ hash: result.digest, signature: result.signature });
  if (!eq(recovered, provider)) throw new Stop("failed", "provider-address-mismatch");
  return result.signature;
}

export function createProviderInstance(options: ProviderInstanceOptions): ProviderInstance {
  const workModes = options.workModes ?? DEFAULT_WORK_MODES;
  const ids = workModes.map((mode) => mode.id);
  if (new Set(ids).size !== ids.length) throw new Error("duplicate work mode id");
  const modes = parseModes(options.modes, ids);
  const work = workModes.find((mode) => mode.id === modes.work) as WorkMode;
  const behaviour = modes.behaviour;
  const keyId = PROVIDER_INSTANCES[options.instance];
  const caller = options.instance;
  const nowMs = options.nowMs ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const queue: JobCreated[] = [];
  const seen = new Set<string>();
  let self: Address | undefined;
  let nextBlock: bigint | undefined;
  const lifecycle = { stopped: false };

  const issuedAt = () => BigInt(Math.floor(nowMs() / MS_PER_SECOND));

  async function sign(job: JobCreated, action: string, args: Record<string, string>) {
    return options.signer.sign(caller, {
      keyId,
      kind: "provider-call",
      payload: { escrow: job.escrow, jobId: job.jobId.toString(), action, args },
    });
  }

  async function transact(
    job: JobCreated,
    action: "setBudget" | "submit",
    args: Record<string, string>,
  ) {
    let result: SignResult;
    try {
      result = await sign(job, action, args);
    } catch (error) {
      if (isDenied(error)) throw new Stop("refused", error.rule);
      throw error;
    }
    if (!("signedTransaction" in result)) throw new Stop("failed", "signer-no-transaction");
    const sent = await options.chain.send(result.signedTransaction);
    if (sent.status !== "success") throw new Stop("failed", `${action.toLowerCase()}-reverted`);
  }

  /** Polls until `done` is true; false when chain time reaches `deadline` (unix seconds) first. */
  async function waitUntil(done: () => Promise<boolean>, deadline: number): Promise<boolean> {
    while (!lifecycle.stopped) {
      if (await done()) return true;
      if ((await options.chain.now()) >= deadline) return false;
      await sleep(options.pollMs);
    }
    throw new Stop("abandoned", "instance-stopped");
  }

  async function fetchBrief(job: JobCreated, provider: Address, key: Hash32) {
    const at = issuedAt();
    const sig = await signature(
      await sign(job, "brief-request", { issuedAt: at.toString() }),
      provider,
    );
    const raw = await options.server.brief({
      jobKey: key,
      providerAddress: provider,
      issuedAt: at,
      signature: sig,
    });
    const description = await options.chain.description(job);
    return verifyBrief({ raw, job, chainId: options.chainId, onChainDescription: description });
  }

  async function deliverable(brief: JobBrief): Promise<Uint8Array> {
    const bytes = behaviour === "junk" ? junkDeliverable(brief) : await work.produce(brief);
    if (bytes === undefined) throw new Stop("refused", "junk-needs-expected-keys");
    const maxBytes = brief.deliverable.maxBytes;
    if (maxBytes !== undefined && bytes.byteLength > maxBytes)
      throw new Stop("refused", "deliverable-too-large");
    return bytes;
  }

  async function upload(job: JobCreated, provider: Address, key: Hash32, bytes: Uint8Array) {
    const contentHash = keccak256(bytes) as Hash32;
    const at = issuedAt();
    const sig = await signature(
      await sign(job, "deliverable-upload", { contentHash, issuedAt: at.toString() }),
      provider,
    );
    const stored = await options.server.upload(
      { jobKey: key, providerAddress: provider, issuedAt: at, signature: sig },
      bytes,
    );
    if (!eq(stored, contentHash)) throw new Stop("failed", "upload-hash-mismatch");
    return contentHash;
  }

  async function steps(
    job: JobCreated,
    key: Hash32,
    record: { budget?: bigint; contentHash?: Hash32 },
  ) {
    const provider = self;
    if (provider === undefined) throw new Error("provider instance not started");
    if (!eq(job.provider, provider)) throw new Stop("refused", "not-job-provider");
    // Step 3 first for the evaluator: the event already names it, so no signature is spent on another's job.
    if (!eq(job.evaluator, options.evaluator)) throw new Stop("refused", "evaluator-not-k7");
    // Step 2.
    const { brief, budgetCap, targetBudget } = await fetchBrief(job, provider, key);
    // Step 3.
    if (!eq(brief.evaluator, options.evaluator)) throw new Stop("refused", "evaluator-not-k7");
    if (brief.submitBy - (await options.chain.now()) < options.minWorkSeconds)
      throw new Stop("refused", "submit-by-too-close");
    if (!work.accepts(brief)) throw new Stop("refused", "work-mode-cannot-deliver");
    if (behaviour === "silent") throw new Stop("stopped", "silent-no-budget");
    if (behaviour === "early-submit") {
      // H1: submit at once with a zero budget, before any setBudget or funding.
      const bytes = await deliverable(brief);
      record.contentHash = await upload(job, provider, key, bytes);
      await transact(job, "submit", { contentHash: record.contentHash });
      return;
    }
    // Step 4.
    const amount = behaviour === "over-budget" ? budgetCap + 1n : targetBudget;
    await transact(job, "setBudget", { amount: amount.toString() });
    record.budget = amount;
    // Step 5: an over-budget job is never funded; the wait ends at submitBy either way.
    if (!(await waitUntil(() => options.chain.funded(job), brief.submitBy)))
      throw new Stop("abandoned", "not-funded");
    // Step 6.
    const bytes = await deliverable(brief);
    if (behaviour === "late") {
      // M4: wait until chain time is past submitBy (but before expiredAt, so the escrow still takes it).
      await waitUntil(async () => (await options.chain.now()) > brief.submitBy, brief.expiredAt);
      if ((await options.chain.now()) <= brief.submitBy)
        throw new Stop("abandoned", "late-window-missed");
    }
    if (behaviour === "no-upload") {
      // N5: ask to submit a hash that was never uploaded. The signer refuses it (`deliverable-not-accepted`),
      // so the job is never submitted (architect ruling, PM-046).
      record.contentHash = keccak256(bytes) as Hash32;
      await transact(job, "submit", { contentHash: record.contentHash });
      return;
    }
    // Step 7.
    record.contentHash = await upload(job, provider, key, bytes);
    if (behaviour !== "late" && (await options.chain.now()) >= brief.submitBy)
      throw new Stop("abandoned", "past-submit-by");
    await transact(job, "submit", { contentHash: record.contentHash });
  }

  async function handle(job: JobCreated): Promise<JobOutcome> {
    const key = jobKeyOf(job.escrow, job.jobId);
    const record: { budget?: bigint; contentHash?: Hash32 } = {};
    let outcome: JobOutcome["outcome"] = "submitted";
    let rule = "submitted";
    try {
      await steps(job, key, record);
    } catch (error) {
      if (error instanceof Stop) {
        outcome = error.outcome;
        rule = error.rule;
      } else if (error instanceof BriefRefused) {
        outcome = "refused";
        rule = error.rule;
      } else if (isDenied(error)) {
        outcome = "refused";
        rule = error.rule;
      } else {
        outcome = "failed";
        rule = "provider-error";
      }
    }
    const result: JobOutcome = {
      jobId: job.jobId,
      jobKey: key,
      behaviour,
      outcome,
      rule,
      ...(record.budget === undefined ? {} : { budget: record.budget }),
      ...(record.contentHash === undefined ? {} : { contentHash: record.contentHash }),
    };
    options.logger?.info("provider_job_done", {
      jobKey: key,
      jobId: job.jobId.toString(),
      keyId,
      mode: behaviour,
      outcome,
      rule,
    });
    options.onOutcome?.(result);
    return result;
  }

  return {
    instance: options.instance,
    behaviour,
    workMode: work.id,
    async start() {
      self = options.providerAddress ?? (await options.signer.keyAddress(caller, keyId));
      nextBlock = (await options.chain.latestBlock()) + 1n;
      return self;
    },
    async tick() {
      if (self === undefined || nextBlock === undefined)
        throw new Error("provider instance not started");
      const latest = await options.chain.latestBlock();
      if (latest >= nextBlock) {
        for (const job of await options.chain.jobsCreated(self, nextBlock, latest)) {
          const id = `${job.escrow.toLowerCase()}:${job.jobId}`;
          if (seen.has(id)) continue;
          seen.add(id);
          queue.push(job);
        }
        nextBlock = latest + 1n;
      }
      const done: JobOutcome[] = [];
      // One job at a time per instance (CZ-20 §5.11 Limits).
      while (queue.length > 0 && !lifecycle.stopped)
        done.push(await handle(queue.shift() as JobCreated));
      return done;
    },
    async run() {
      while (!lifecycle.stopped) {
        try {
          await this.tick();
        } catch {
          options.logger?.warn("provider_watch_failed", { keyId, rule: "watch-error" });
        }
        if (!lifecycle.stopped) await sleep(options.pollMs);
      }
    },
    stop() {
      lifecycle.stopped = true;
    },
    handle,
  };
}
