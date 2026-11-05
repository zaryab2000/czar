// PM-046 test doubles shared by the unit and arc-anvil provider tests: a `JobBrief` built the way the server's
// `buildJobBrief` builds it, and a stand-in for the server's two provider routes (02 §9.2) served as a `fetch`.
import { readFileSync } from "node:fs";
import {
  briefRequestDigest,
  deliverableUploadDigest,
  descriptionHashFromBrief,
  inputCommit,
  jobKey,
  type Address,
  type Hash32,
} from "@czar/hashing";
import type { JobBrief } from "@czar/schemas";
import { keccak256, recoverAddress, type Hex } from "viem";

const EXAMPLE = JSON.parse(
  readFileSync(
    new URL(
      "../../../docs/specs/02-data-and-protocol/examples/job-brief.example.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as JobBrief;

export interface BriefInput {
  readonly escrow: Address;
  readonly jobId: bigint;
  readonly chainId: number;
  readonly evaluator: Address;
  readonly expiredAt: number;
  readonly submitBy: number;
  readonly budgetCap: bigint;
  readonly targetBudget: bigint;
  readonly expectedKeys?: readonly string[];
  readonly mimeType?: string;
}

/** A schema-valid brief for the job, and the on-chain `description` that matches it. */
export function makeBrief(input: BriefInput): { brief: JobBrief; description: string } {
  const inputs = { q: `provider test job ${input.jobId}` };
  const inputSalt = keccak256(new TextEncoder().encode(`salt:${input.escrow}:${input.jobId}`));
  const brief: JobBrief = {
    ...EXAMPLE,
    network: `eip155:${input.chainId}`,
    jobEscrow: input.escrow,
    jobId: input.jobId.toString(),
    jobKey: jobKey(input.escrow, input.jobId),
    inputs,
    inputSalt,
    inputCommit: inputCommit(inputs, inputSalt),
    deliverable: {
      ...EXAMPLE.deliverable,
      mimeType: input.mimeType ?? "application/json",
      expectedKeys: [...(input.expectedKeys ?? ["price"])],
    },
    budgetCap: input.budgetCap.toString(),
    targetBudget: input.targetBudget.toString(),
    evaluator: input.evaluator,
    expiredAt: input.expiredAt,
    submitBy: input.submitBy,
    decisionCutoff: input.expiredAt - 60,
  };
  return { brief, description: `czar:${descriptionHashFromBrief(brief)}` };
}

const notFound = () => new Response(JSON.stringify({ title: "validation" }), { status: 404 });

export interface ServerDouble {
  readonly fetch: typeof fetch;
  /** Briefs by lowercase job key, with the on-chain provider each one belongs to. */
  readonly briefs: Map<string, { brief: unknown; provider: Address }>;
  /** `${jobKey}:${contentHash}` pairs the upload route accepted (the signer's `deliverableAccepted`). */
  readonly accepted: Set<string>;
  readonly uploads: { jobKey: Hash32; contentHash: Hash32; bytes: Uint8Array }[];
  readonly requests: string[];
}

/**
 * The server's `getJobBrief` and `uploadJobDeliverable` rules that matter to a provider: the signer of the
 * `BriefRequest` / `DeliverableUpload` digest must be the job's provider (`verify: true`, checked with
 * `recoverAddress`), `issuedAt` no older than `maxAgeSeconds`, any other caller gets 404, uploads answer
 * `201 {contentHash}` with `contentHash = keccak256(body)`.
 */
export function serverDouble(options: {
  readonly chainId: number;
  readonly verify: boolean;
  readonly nowSeconds: () => number;
  readonly maxAgeSeconds?: number;
}): ServerDouble {
  const briefs = new Map<string, { brief: unknown; provider: Address }>();
  const accepted = new Set<string>();
  const uploads: ServerDouble["uploads"] = [];
  const requests: string[] = [];
  const maxAge = options.maxAgeSeconds ?? 300;
  const signedBy = async (
    digest: Hash32,
    signature: string,
    claimed: string,
    provider: Address,
  ) => {
    if (claimed.toLowerCase() !== provider.toLowerCase()) return false;
    if (!options.verify) return /^0x[0-9a-fA-F]+$/.test(signature);
    const recovered = await recoverAddress({ hash: digest, signature: signature as Hex });
    return recovered.toLowerCase() === provider.toLowerCase();
  };
  const fresh = (issuedAt: string) => {
    if (!/^\d+$/.test(issuedAt)) return false;
    const at = Number(issuedAt);
    const now = options.nowSeconds();
    return at > 0 && at <= now && now - at <= maxAge;
  };
  const handler = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    const match = /\/v1\/jobs\/(0x[0-9a-fA-F]{64})\/(brief|deliverable)$/.exec(url);
    if (match === null) return notFound();
    const key = (match[1] as string).toLowerCase() as Hash32;
    const route = match[2] as "brief" | "deliverable";
    requests.push(`${init.method ?? "GET"} ${route}`);
    const entry = briefs.get(key);
    if (entry === undefined) return notFound();
    const claimed = headers.get("X-Czar-Provider-Address") ?? "";
    if (route === "brief") {
      const issuedAt = headers.get("X-Czar-Brief-Issued-At") ?? "";
      if (!fresh(issuedAt)) return notFound();
      const digest = briefRequestDigest(options.chainId, {
        jobKey: key,
        issuedAt: BigInt(issuedAt),
      });
      if (
        !(await signedBy(
          digest,
          headers.get("X-Czar-Brief-Signature") ?? "",
          claimed,
          entry.provider,
        ))
      )
        return notFound();
      return new Response(JSON.stringify(entry.brief), { status: 200 });
    }
    if (headers.get("Content-Type") !== "application/octet-stream")
      return new Response(null, { status: 400 });
    const bytes = new Uint8Array(init.body as Uint8Array);
    const issuedAt = headers.get("X-Czar-Upload-Issued-At") ?? "";
    if (!fresh(issuedAt)) return notFound();
    const contentHash = keccak256(bytes) as Hash32;
    const digest = deliverableUploadDigest(options.chainId, {
      jobKey: key,
      contentHash,
      issuedAt: BigInt(issuedAt),
    });
    if (
      !(await signedBy(
        digest,
        headers.get("X-Czar-Upload-Signature") ?? "",
        claimed,
        entry.provider,
      ))
    )
      return notFound();
    accepted.add(`${key}:${contentHash}`);
    uploads.push({ jobKey: key, contentHash, bytes });
    return new Response(JSON.stringify({ contentHash }), { status: 201 });
  };
  return {
    fetch: ((input: string | URL | Request, init?: RequestInit) =>
      handler(String(input), init)) as typeof fetch,
    briefs,
    accepted,
    uploads,
    requests,
  };
}
