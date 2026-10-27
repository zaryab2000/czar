import { objectiveHash, taskSpecHash } from "@czar/hashing";
import { validateSchema, type ObjectiveSubmission } from "@czar/schemas";
import type { RedactedObjective } from "#src/objective-redaction";

export interface SubmissionInput {
  readonly redacted: RedactedObjective;
  readonly objectiveId: string;
  readonly deviceId: string;
  readonly soulVersionHash: string;
  readonly submittedAt: string;
}

/** Builds the exact ObjectiveSubmission preimage accepted by the server. */
export function buildObjectiveSubmission(input: SubmissionInput): ObjectiveSubmission {
  const { options } = input.redacted;
  const body: ObjectiveSubmission = {
    schemaVersion: "1.0",
    objectiveId: input.objectiveId,
    objectiveHash: objectiveHash({
      objectiveId: input.objectiveId,
      soulVersionHash: input.soulVersionHash,
      observationHashes: [],
      detector: "placeholder",
      goal: options.goal,
      capabilities: options.capabilities,
      minutesSaved: options.minutesSaved,
      hourlyBand: options.hourlyBand,
      taskSpecHash: taskSpecHash(options.taskSpec),
    }),
    soulVersionHash: input.soulVersionHash,
    observationHashes: [],
    detector: "placeholder",
    goal: options.goal,
    capabilities: [...options.capabilities],
    minutesSaved: options.minutesSaved,
    hourlyBand: options.hourlyBand,
    ...(options.maxTotal === undefined ? {} : { constraints: { maxTotal: options.maxTotal } }),
    redaction: { layer2: input.redacted.layer2 },
    deviceId: input.deviceId,
    submittedAt: input.submittedAt,
    taskSpec: options.taskSpec,
  };
  if (!validateSchema("objective-submission", body)) {
    throw new Error("Objective submission failed schema validation; nothing was sent.");
  }
  return body;
}
