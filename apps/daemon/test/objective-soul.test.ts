import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { soulVersionHash } from "@czar/hashing";
import { openMemoryDatabase } from "#src/database";
import { currentSoulVersionHash } from "#src/objective-soul";

const key = "0f".repeat(32);
const databasePath = () => join(mkdtempSync(join(tmpdir(), "czar-objective-soul-")), "memory.db");

describe("manual objective soul version", () => {
  it("creates one stable seed and reuses it across submissions", () => {
    const db = openMemoryDatabase(databasePath(), key);
    try {
      const first = new Date("2026-10-27T00:00:00.000Z");
      const hash = currentSoulVersionHash(db, first);
      expect(hash).toBe(
        soulVersionHash({ version: 0, compiledAt: first.toISOString(), sections: {} }),
      );
      expect(currentSoulVersionHash(db, new Date("2026-10-28T00:00:00.000Z"))).toBe(hash);
      const count = db.prepare("SELECT count(*) AS count FROM soul_versions").get() as {
        count: number;
      };
      expect(count.count).toBe(1);
    } finally {
      db.close();
    }
  });

  it("does not fabricate a hash for an unreadable stored soul", () => {
    const db = openMemoryDatabase(databasePath(), key);
    try {
      db.prepare(
        `INSERT INTO soul_versions (version,compiled_at,soul_version_hash,soul_json)
         VALUES (0,0,?,?)`,
      ).run(Buffer.alloc(32), "bad json");
      expect(() => currentSoulVersionHash(db, new Date())).toThrow(/unreadable/);
    } finally {
      db.close();
    }
  });
});
