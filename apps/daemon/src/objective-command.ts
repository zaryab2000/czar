import { createHash } from "node:crypto";
import type { Config } from "@czar/config";
import type { Layer2Client } from "@czar/redaction";
import type { MemoryDatabase } from "#src/database";
import type { Keychain } from "#src/keychain";
import {
  getStatus,
  pollManualObjective,
  submitManualObjective,
  TERMINAL_STATUSES,
  type ObjectiveFetch,
  type ObjectiveStatus,
} from "#src/objective-http";
import { newObjectiveId } from "#src/objective-id";
import type { ObjectiveOptions } from "#src/objective-options";
import { redactObjectiveInput } from "#src/objective-redaction";
import { currentSoulVersionHash } from "#src/objective-soul";
import { buildObjectiveSubmission } from "#src/objective-submission";
import { saveObjectiveMeta, writeBackResult } from "#src/results/write-back";

export interface ResultCommandDeps {
  readonly database: MemoryDatabase;
  readonly deviceToken: string;
  readonly keychain: Keychain;
  readonly config: Config;
  readonly serverOrigin: URL;
  readonly cwd: string;
  readonly pollSeconds: number;
  readonly print: (line: string) => void;
  readonly fetcher?: ObjectiveFetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface ObjectiveCommandDeps extends ResultCommandDeps {
  readonly deviceId: string;
  readonly layer2: Layer2Client;
  readonly now?: () => Date;
  readonly confirmFallback?: (redactedGoal: string) => Promise<boolean>;
}

/**
 * Submits one redacted objective, watches it through approval to a terminal state, then writes the
 * result back into the project and acknowledges it (SCR-147, SCR-149 §2).
 */
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
  await submitManualObjective(body, deps.deviceToken, deps.serverOrigin, deps.fetcher);
  saveObjectiveMeta(deps.database, body.objectiveId, { minutesSaved: body.minutesSaved });
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
  await finishObjective(body.objectiveId, deps);
}

/**
 * `czar result <objectiveId>`: polls a non-final objective to its terminal state, then writes
 * back; for a final one the write-back and ack are idempotent (SCR-149 §2).
 */
export async function runResultCommand(
  objectiveId: string,
  deps: ResultCommandDeps,
): Promise<void> {
  const fetcher = deps.fetcher ?? fetch;
  const current = await getStatus(objectiveId, deps.deviceToken, deps.serverOrigin, fetcher);
  if (TERMINAL_STATUSES.has(current.status)) {
    deps.print(`${current.objectiveId}: ${current.status}`);
    await writeBackIfResult(current, deps);
    return;
  }
  await finishObjective(objectiveId, deps);
}

async function finishObjective(objectiveId: string, deps: ResultCommandDeps): Promise<void> {
  const final = await pollManualObjective({
    objectiveId,
    token: deps.deviceToken,
    serverOrigin: deps.serverOrigin,
    intervalSeconds: deps.pollSeconds,
    print: deps.print,
    ...(deps.fetcher === undefined ? {} : { fetcher: deps.fetcher }),
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
  });
  await writeBackIfResult(final, deps);
}

async function writeBackIfResult(status: ObjectiveStatus, deps: ResultCommandDeps): Promise<void> {
  if (status.resultId === undefined) {
    deps.print("No result to write back.");
    return;
  }
  await writeBackResult(
    {
      objectiveId: status.objectiveId,
      resultId: status.resultId,
      ...(status.planSummary?.spent === undefined ? {} : { spent: status.planSummary.spent }),
    },
    {
      database: deps.database,
      keychain: deps.keychain,
      config: deps.config,
      serverOrigin: deps.serverOrigin,
      deviceToken: deps.deviceToken,
      cwd: deps.cwd,
      print: deps.print,
      ...(deps.fetcher === undefined ? {} : { fetcher: deps.fetcher }),
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    },
  );
}
