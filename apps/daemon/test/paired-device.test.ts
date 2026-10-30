import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openMemoryDatabase } from "#src/database";
import { pairedDeviceId, savePairedDevice } from "#src/paired-device";

const deviceId = "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const databasePath = () => join(mkdtempSync(join(tmpdir(), "czar-paired-device-")), "memory.db");

describe("paired device settings", () => {
  it("persists the returned ID and binds it to the current K15 token", () => {
    const db = openMemoryDatabase(databasePath(), "0f".repeat(32));
    try {
      savePairedDevice(db, deviceId, "first-token");
      expect(pairedDeviceId(db, "first-token")).toBe(deviceId);
      expect(() => pairedDeviceId(db, "second-token")).toThrow(/does not match/);
      const row = db.prepare("SELECT value_json FROM settings WHERE key='paired-device'").get() as {
        value_json: string;
      };
      expect(row.value_json).not.toContain("first-token");
    } finally {
      db.close();
    }
  });

  it("asks for pairing again when older K15 state has no stored ID", () => {
    const db = openMemoryDatabase(databasePath(), "0f".repeat(32));
    try {
      expect(() => pairedDeviceId(db, "old-token")).toThrow(/czar pair/);
    } finally {
      db.close();
    }
  });
});
