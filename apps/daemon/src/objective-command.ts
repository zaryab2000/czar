import type { Layer2Client } from "@czar/redaction";
import type { MemoryDatabase } from "#src/database";
import {
  pollManualObjective,
  submitManualObjective,
  type ObjectiveFetch,
} from "#src/objective-http";
import { newObjectiveId } from "#src/objective-id";
import type { ObjectiveOptions } from "#src/objective-options";
import { redactObjectiveInput } from "#src/objective-redaction";
import { currentSoulVersionHash } from "#src/objective-soul";
import { buildObjectiveSubmission } from "#src/objective-submission";

export interface ObjectiveCommandDeps {
  readonly database: MemoryDatabase;
  readonly deviceId: string;
  readonly deviceToken: string;
  readonly layer2: Layer2Client;
  readonly pollSeconds: number;
  readonly print: (line: string) => void;
  readonly fetcher?: ObjectiveFetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => Date;
}

/** Submits one redacted objective and watches it until approval or a terminal state. */
export async function runManualObjective(
  options: ObjectiveOptions,
  deps: ObjectiveCommandDeps,
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const redacted = await redactObjectiveInput(options, deps.layer2);
  const body = buildObjectiveSubmission({
    redacted,
    objectiveId: newObjectiveId(now),
    deviceId: deps.deviceId,
    soulVersionHash: currentSoulVersionHash(deps.database, now),
    submittedAt: now.toISOString(),
  });
  await submitManualObjective(body, deps.deviceToken, deps.fetcher);
  deps.print(body.objectiveId);
  await pollManualObjective({
    objectiveId: body.objectiveId,
    token: deps.deviceToken,
    intervalSeconds: deps.pollSeconds,
    print: deps.print,
    ...(deps.fetcher === undefined ? {} : { fetcher: deps.fetcher }),
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
  });
}
