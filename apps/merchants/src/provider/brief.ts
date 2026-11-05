// CZ-20 §5.11 step 2: a fetched brief is trusted only when it is a valid `JobBrief` for this job and its
// `inputCommit` and `descriptionHash` recompute to what the brief and the chain say.
import {
  descriptionHashFromBrief,
  inputCommit,
  jobKey as jobKeyOf,
  type Address,
  type Hash32,
} from "@czar/hashing";
import { validateJobBrief, type JobBrief } from "@czar/schemas";
import type { JobCreated } from "#src/provider/ports";

const AMOUNT6 = /^(0|[1-9][0-9]{0,77})$/;
const DESCRIPTION_PREFIX = "czar:";

export class BriefRefused extends Error {
  readonly rule: string;
  constructor(rule: string) {
    super(`brief refused: ${rule}`);
    this.name = "BriefRefused";
    this.rule = rule;
  }
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export interface VerifiedBrief {
  readonly brief: JobBrief;
  readonly budgetCap: bigint;
  readonly targetBudget: bigint;
}

/**
 * Checks the brief against the `JobCreated` event and the job's on-chain `description`. Throws `BriefRefused`
 * naming the first rule that fails: `brief-invalid` (schema), `brief-mismatch` (another job, chain or escrow),
 * `input-commit-mismatch`, `description-hash-mismatch`, `budget-invalid`.
 */
export function verifyBrief(input: {
  readonly raw: unknown;
  readonly job: JobCreated;
  readonly chainId: number;
  readonly onChainDescription: string;
}): VerifiedBrief {
  const { raw, job } = input;
  if (!validateJobBrief(raw)) throw new BriefRefused("brief-invalid");
  const brief = raw;
  const key: Hash32 = jobKeyOf(job.escrow, job.jobId);
  if (
    !eq(brief.jobKey, key) ||
    !eq(brief.jobEscrow, job.escrow) ||
    brief.jobId !== job.jobId.toString() ||
    brief.network !== `eip155:${input.chainId}` ||
    !eq(brief.evaluator, job.evaluator as Address) ||
    BigInt(brief.expiredAt) !== job.expiredAt
  )
    throw new BriefRefused("brief-mismatch");
  if (!eq(inputCommit(brief.inputs, brief.inputSalt), brief.inputCommit))
    throw new BriefRefused("input-commit-mismatch");
  const expected = `${DESCRIPTION_PREFIX}${descriptionHashFromBrief(brief)}`;
  if (!eq(input.onChainDescription, expected)) throw new BriefRefused("description-hash-mismatch");
  if (!AMOUNT6.test(brief.budgetCap) || !AMOUNT6.test(brief.targetBudget))
    throw new BriefRefused("budget-invalid");
  const budgetCap = BigInt(brief.budgetCap);
  const targetBudget = BigInt(brief.targetBudget);
  if (targetBudget > budgetCap) throw new BriefRefused("budget-invalid");
  return { brief, budgetCap, targetBudget };
}
