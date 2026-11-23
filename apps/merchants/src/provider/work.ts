// CZ-20 §5.11 work modes: what work an instance does for a job, from the brief's `taskSpec` and `inputs`.
//
// Which work modes ship in Phase 1 is OD-41. For the alpha only the deterministic `placeholder` ships (plan §2.3;
// T-108 allows it until OD-41); the AI work modes are SCR-178. A new work mode is one more `WorkMode` value
// handed to `createProviderInstance`; nothing outside `provider/` changes (T-108 acceptance).
import type { JobBrief } from "@czar/schemas";

export interface WorkMode {
  /** The name `merchants.provider.<instance>.modes` uses for it. */
  readonly id: string;
  /** Capability tags this mode serves, for the instance's index entry. Empty: no capability is claimed. */
  readonly capabilities: readonly string[];
  /** False when this mode cannot produce a profile-valid deliverable for the brief; the job is then refused. */
  accepts(brief: JobBrief): boolean;
  /** The deliverable bytes. Must be deterministic for a deterministic mode. */
  produce(brief: JobBrief): Promise<Uint8Array>;
}

const JSON_MIME = "application/json";
const encoder = new TextEncoder();

/** The media type without parameters, lower case (`application/json; charset=utf-8` → `application/json`). */
export const baseMimeType = (mimeType: string): string =>
  (mimeType.split(";")[0] ?? "").trim().toLowerCase();

/**
 * The placeholder work mode: a JSON object with a non-empty, deterministic value for every `expectedKeys` entry,
 * so the delivery, structural (JSON parses) and requirement (keys present, non-empty) checks pass. It accepts
 * only JSON deliverables without a `schema`: it cannot promise a schema-valid value, and it does not guess.
 */
export const placeholderWorkMode: WorkMode = {
  id: "placeholder",
  capabilities: [],
  accepts(brief) {
    return (
      baseMimeType(brief.deliverable.mimeType) === JSON_MIME &&
      brief.deliverable.schema === undefined
    );
  },
  async produce(brief) {
    const keys = brief.deliverable.expectedKeys ?? [];
    const body: Record<string, string> = {};
    if (keys.length === 0) body["czarPlaceholder"] = brief.jobKey;
    for (const key of keys) body[key] = `czar-placeholder:${key}:${brief.jobKey}`;
    return encoder.encode(JSON.stringify(body));
  },
};

/** The work modes this build ships (OD-41 partial). */
export const DEFAULT_WORK_MODES: readonly WorkMode[] = [placeholderWorkMode];

/**
 * The `junk` behaviour's bytes: well-formed JSON that names every expected key with an empty value, so it parses
 * (structural) but fails the requirement check (CZ-20 §5.11 "well-formed but fails the profile"). Undefined when
 * the brief has no expected keys: nothing would fail, so the junk instance refuses that job.
 */
export function junkDeliverable(brief: JobBrief): Uint8Array | undefined {
  const keys = brief.deliverable.expectedKeys ?? [];
  if (keys.length === 0) return undefined;
  return encoder.encode(JSON.stringify(Object.fromEntries(keys.map((key) => [key, ""]))));
}
