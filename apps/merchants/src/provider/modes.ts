// CZ-20 §5.11 modes: one work mode (what work is done) and one behaviour mode (how the instance behaves on the
// job path, for the scenario and tests). `merchants.provider.<instance>.modes` lists both.

/** The behaviour modes CZ-20 §5.11 names, with the effect each one is for. */
export const BEHAVIOUR_MODES = [
  /** The full loop. */
  "honest",
  /** Well-formed bytes that fail the profile: the reject path. */
  "junk",
  /** Never sets a budget: H2 cancel and alternate. */
  "silent",
  /** Submits with a zero budget, before any funding: H1. */
  "early-submit",
  /** Sets a budget above the brief's `budgetCap`: H2. */
  "over-budget",
  /** Submits after `submitBy`: M4. */
  "late",
  /** Asks to submit a hash it never uploaded: N5. The signer refuses it (`deliverable-not-accepted`). */
  "no-upload",
] as const;
export type BehaviourMode = (typeof BEHAVIOUR_MODES)[number];

/** The two CZ-20 §5.11 instances (N12) and the signer key each one owns (CZ-27 §5.1). */
export const PROVIDER_INSTANCES = {
  "czar-provider-a": "K21a",
  "czar-provider-b": "K21b",
} as const;
export type ProviderInstanceId = keyof typeof PROVIDER_INSTANCES;
export type ProviderKeyId = (typeof PROVIDER_INSTANCES)[ProviderInstanceId];

export class ProviderModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderModeError";
  }
}

export interface ParsedModes {
  readonly work: string;
  readonly behaviour: BehaviourMode;
}

/**
 * Splits a `modes` list into exactly one known work mode and exactly one behaviour mode. Anything else (an
 * unknown name, a duplicate, two of either kind, none of either kind) is refused, so a typo never runs a job.
 */
export function parseModes(modes: readonly string[], workModes: readonly string[]): ParsedModes {
  const behaviours = modes.filter((mode): mode is BehaviourMode =>
    (BEHAVIOUR_MODES as readonly string[]).includes(mode),
  );
  const works = modes.filter((mode) => workModes.includes(mode));
  const unknown = modes.filter(
    (mode) => !(BEHAVIOUR_MODES as readonly string[]).includes(mode) && !workModes.includes(mode),
  );
  if (unknown.length > 0) throw new ProviderModeError(`unknown provider mode ${unknown[0]}`);
  if (new Set(modes).size !== modes.length) throw new ProviderModeError("duplicate provider mode");
  if (behaviours.length !== 1)
    throw new ProviderModeError("provider modes need exactly one behaviour mode");
  if (works.length !== 1) throw new ProviderModeError("provider modes need exactly one work mode");
  return { work: works[0] as string, behaviour: behaviours[0] as BehaviourMode };
}
