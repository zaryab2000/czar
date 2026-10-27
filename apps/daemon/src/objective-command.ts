import { createHash } from "node:crypto";
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
import { deliverManualResult } from "#src/objective-result";

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
  readonly confirmFallback?: (redactedGoal: string) => Promise<boolean>;
  readonly projectRoot?: string;
  readonly acknowledge?: (
    objectiveId: string,
    resultId: string,
    writtenAt: string,
    idempotencyKey: string,
  ) => Promise<void>;
}

/** Submits one redacted objective and watches it until approval or a terminal state. */
export async function runManualObjective(
  options: ObjectiveOptions,
  deps: ObjectiveCommandDeps,
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const redacted = await redactObjectiveInput(options, deps.layer2);
  if (redacted.forcedReview && !(await deps.confirmFallback?.(redacted.options.goal))) {
    throw new Error("Redaction review declined; objective was not sent.");
  }
  const body = buildObjectiveSubmission({
    redacted,
    objectiveId: newObjectiveId(now),
    deviceId: deps.deviceId,
    soulVersionHash: currentSoulVersionHash(deps.database, now),
    submittedAt: now.toISOString(),
  });
  await submitManualObjective(body, deps.deviceToken, deps.fetcher);
  const payload = JSON.stringify(body);
  deps.database
    .prepare(
      `INSERT INTO audit_local (at,kind,payload_hash,bytes,destination,summary_counts_json)
     VALUES (?,?,?,?,?,?)`,
    )
    .run(
      now.getTime(),
      "objective-submit",
      createHash("sha256").update(payload).digest(),
      Buffer.byteLength(payload),
      "server",
      JSON.stringify({ forcedReview: redacted.forcedReview ? 1 : 0 }),
    );
  deps.print(body.objectiveId);
  const status = await pollManualObjective({
    objectiveId: body.objectiveId,
    token: deps.deviceToken,
    intervalSeconds: deps.pollSeconds,
    print: deps.print,
    ...(deps.fetcher === undefined ? {} : { fetcher: deps.fetcher }),
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
  });
  if (status.resultId !== undefined) {
    await deliverManualResult({
      objectiveId: body.objectiveId,
      resultId: status.resultId,
      token: deps.deviceToken,
      projectRoot: deps.projectRoot ?? process.cwd(),
      database: deps.database,
      print: deps.print,
      acknowledge:
        deps.acknowledge ??
        (async () => {
          throw new Error("Result acknowledgment client is unavailable.");
        }),
      ...(deps.fetcher === undefined ? {} : { fetcher: deps.fetcher }),
    });
  }
}
