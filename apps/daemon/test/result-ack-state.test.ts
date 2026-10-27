import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openMemoryDatabase } from "#src/database";
import { getOrCreateResultAck } from "#src/result-ack-state";

const resultId = "res_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const key = "0f".repeat(32);

describe("result acknowledgment state", () => {
  it("persists a UUID and unchanged body across separate runs", () => {
    const path = join(mkdtempSync(join(tmpdir(), "czar-result-ack-")), "memory.db");
    const firstDb = openMemoryDatabase(path, key);
    const first = getOrCreateResultAck(firstDb, resultId);
    expect(first.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(first.resultAck).toMatchObject({ resultId, surface: "claude-code-file" });
    expect(getOrCreateResultAck(firstDb, resultId)).toEqual(first);
    firstDb.close();

    const laterDb = openMemoryDatabase(path, key);
    try {
      expect(getOrCreateResultAck(laterDb, resultId)).toEqual(first);
    } finally {
      laterDb.close();
    }
  });

  it("refuses invalid stored state instead of generating a second key", () => {
    const path = join(mkdtempSync(join(tmpdir(), "czar-result-ack-")), "memory.db");
    const db = openMemoryDatabase(path, key);
    try {
      db.prepare("INSERT INTO settings (key,value_json) VALUES (?,?)").run(
        `result-ack-request:${resultId}`,
        JSON.stringify({ idempotencyKey: "wrong" }),
      );
      expect(() => getOrCreateResultAck(db, resultId)).toThrow(/invalid/);
      expect(() => getOrCreateResultAck(db, "bad-id")).toThrow(/Invalid result identifier/);
    } finally {
      db.close();
    }
  });
});
