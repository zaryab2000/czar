import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { validateRecordedExchange } from "@czar/api-contract";
import type { ObjectiveFetch } from "#src/objective-http";
import type { MemoryDatabase } from "#src/database";

const SERVER_ORIGIN = "http://localhost";
const OBJECTIVE_ID = /^obj_[0-9A-HJKMNP-TV-Z]{26}$/;
const RESULT_ID = /^res_[0-9A-HJKMNP-TV-Z]{26}$/;

interface Result {
  readonly resultId: string;
  readonly objectiveId: string;
  readonly body: string;
}

export interface DeliverResultInput {
  readonly objectiveId: string;
  readonly resultId: string;
  readonly token: string;
  readonly projectRoot: string;
  readonly database: MemoryDatabase;
  readonly print: (line: string) => void;
  readonly fetcher?: ObjectiveFetch;
  readonly acknowledge: (
    objectiveId: string,
    resultId: string,
    writtenAt: string,
    idempotencyKey: string,
  ) => Promise<void>;
}

/** Fetches one final result, writes its served body, then acknowledges the local write. */
export async function deliverManualResult(input: DeliverResultInput): Promise<void> {
  if (!OBJECTIVE_ID.test(input.objectiveId) || !RESULT_ID.test(input.resultId)) {
    throw new Error("Invalid objective or result identifier.");
  }
  const result = await fetchResult(input, input.fetcher ?? fetch);
  const path = writeResult(input.projectRoot, result);
  const ackKey = `result-ack:${result.resultId}`;
  const acked = input.database.prepare("SELECT key FROM settings WHERE key=?").get(ackKey);
  if (acked === undefined) {
    const pendingKey = `result-ack-pending:${result.resultId}`;
    const row = input.database
      .prepare("SELECT value_json FROM settings WHERE key=?")
      .get(pendingKey) as { value_json: string } | undefined;
    let pending: unknown = { writtenAt: new Date().toISOString(), idempotencyKey: randomUUID() };
    if (row !== undefined) {
      try {
        pending = JSON.parse(row.value_json);
      } catch {
        throw new Error("Stored result acknowledgment is invalid.");
      }
    }
    if (!isPendingAck(pending)) {
      throw new Error("Stored result acknowledgment is invalid.");
    }
    if (row === undefined) {
      input.database
        .prepare("INSERT INTO settings (key,value_json) VALUES (?,?)")
        .run(pendingKey, JSON.stringify(pending));
    }
    await input.acknowledge(
      result.objectiveId,
      result.resultId,
      pending.writtenAt,
      pending.idempotencyKey,
    );
    input.database
      .prepare("INSERT INTO settings (key,value_json) VALUES (?,?)")
      .run(ackKey, "true");
  }
  input.print(path);
}

function isPendingAck(value: unknown): value is { writtenAt: string; idempotencyKey: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "writtenAt" in value &&
    typeof value.writtenAt === "string" &&
    Number.isFinite(Date.parse(value.writtenAt)) &&
    "idempotencyKey" in value &&
    typeof value.idempotencyKey === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.idempotencyKey,
    )
  );
}

async function fetchResult(input: DeliverResultInput, fetcher: ObjectiveFetch): Promise<Result> {
  let response: Response;
  try {
    response = await fetcher(new URL(`/v1/results/${input.resultId}`, SERVER_ORIGIN), {
      method: "GET",
      headers: { Authorization: `Bearer ${input.token}` },
    });
  } catch {
    throw new Error("Could not reach Czar while fetching the result.");
  }
  if (response.status !== 200) throw new Error(`Result fetch failed (HTTP ${response.status}).`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Czar returned unreadable result JSON.");
  }
  const contract = validateRecordedExchange("getResult", {
    responseStatus: 200,
    responseBody: body,
  });
  if (!contract.valid || !isResult(body, input)) {
    throw new Error("Czar returned an invalid result response.");
  }
  return body;
}

function isResult(value: unknown, input: DeliverResultInput): value is Result {
  return (
    typeof value === "object" &&
    value !== null &&
    "resultId" in value &&
    value.resultId === input.resultId &&
    "objectiveId" in value &&
    value.objectiveId === input.objectiveId &&
    "body" in value &&
    typeof value.body === "string"
  );
}

function writeResult(projectRoot: string, result: Result): string {
  const czarDir = join(projectRoot, ".czar");
  const dir = join(czarDir, "results");
  for (const folder of [czarDir, dir]) {
    if (existsSync(folder) && !lstatSync(folder).isDirectory()) {
      throw new Error("Result directory is not a regular directory.");
    }
  }
  const path = join(dir, `${result.objectiveId}.md`);
  const hash = `0x${createHash("sha256").update(result.body).digest("hex")}`;
  const marker =
    `<!-- czar:result v=1 objective=${result.objectiveId}` +
    ` result=${result.resultId} hash=${hash} -->`;
  if (existsSync(path)) {
    if (!lstatSync(path).isFile()) throw new Error("Result file is not a regular file.");
    const firstLine = readFileSync(path, "utf8").split("\n", 1)[0];
    if (firstLine !== marker) throw new Error("Result file already exists with different content.");
    return path;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ignorePath = join(czarDir, ".gitignore");
  if (!existsSync(ignorePath)) writeFileSync(ignorePath, "*\n", { flag: "wx", mode: 0o600 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${marker}\n${result.body}`, { flag: "wx", mode: 0o600 });
  try {
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
  return path;
}
