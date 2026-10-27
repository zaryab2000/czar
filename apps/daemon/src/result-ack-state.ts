import { randomUUID } from "node:crypto";
import type { MemoryDatabase } from "#src/database";

const RESULT_ID = /^res_[0-9A-HJKMNP-TV-Z]{26}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface StoredResultAck {
  readonly idempotencyKey: string;
  readonly resultAck: {
    readonly resultId: string;
    readonly writtenAt: string;
    readonly surface: "claude-code-file";
  };
}

/** Persists the first ack key and body before a result can be acknowledged. */
export function getOrCreateResultAck(db: MemoryDatabase, resultId: string): StoredResultAck {
  if (!RESULT_ID.test(resultId)) throw new Error("Invalid result identifier for acknowledgment.");
  const key = `result-ack-request:${resultId}`;
  const select = db.prepare("SELECT value_json FROM settings WHERE key=?");
  const existing = select.get(key) as { value_json: string } | undefined;
  if (existing !== undefined) return readStoredAck(existing.value_json, resultId);
  const value: StoredResultAck = {
    idempotencyKey: randomUUID(),
    resultAck: { resultId, writtenAt: new Date().toISOString(), surface: "claude-code-file" },
  };
  db.prepare("INSERT OR IGNORE INTO settings (key,value_json) VALUES (?,?)").run(
    key,
    JSON.stringify(value),
  );
  const row = select.get(key) as { value_json: string } | undefined;
  if (row === undefined) throw new Error("Result acknowledgment could not be stored.");
  return readStoredAck(row.value_json, resultId);
}

function readStoredAck(valueJson: string, resultId: string): StoredResultAck {
  let stored: unknown;
  try {
    stored = JSON.parse(valueJson);
  } catch {
    throw new Error("Stored result acknowledgment is invalid.");
  }
  if (!isStoredResultAck(stored, resultId)) {
    throw new Error("Stored result acknowledgment is invalid.");
  }
  return stored;
}

function isStoredResultAck(value: unknown, resultId: string): value is StoredResultAck {
  if (!isRecord(value)) return false;
  if (typeof value["idempotencyKey"] !== "string") return false;
  if (!UUID_V4.test(value["idempotencyKey"])) return false;
  return isResultAck(value["resultAck"], resultId);
}

function isResultAck(value: unknown, resultId: string): value is StoredResultAck["resultAck"] {
  if (!isRecord(value)) return false;
  if (value["resultId"] !== resultId) return false;
  if (typeof value["writtenAt"] !== "string") return false;
  if (!Number.isFinite(Date.parse(value["writtenAt"]))) return false;
  return value["surface"] === "claude-code-file";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
