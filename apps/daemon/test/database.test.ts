import { statSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { describe, expect, it } from "vitest";
import { DatabaseLockedError, openMemoryDatabase, SCHEMA_VERSION, TABLES } from "@czar/daemon";
import { tempDir } from "./support.ts";

const KEY = "0f".repeat(32);

describe("encrypted memory database (CZ-02 §5.3)", () => {
  it("creates every table of the schema, mode 0600", () => {
    const path = join(tempDir("czar-db-"), "memory.db");
    const db = openMemoryDatabase(path, KEY);
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((row) => row.name);
    expect(names.toSorted()).toEqual([...TABLES].toSorted());
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    db.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("cannot be opened without the keychain key", () => {
    const path = join(tempDir("czar-db-"), "memory.db");
    openMemoryDatabase(path, KEY).close();
    const raw = new Database(path);
    expect(() => raw.prepare("SELECT count(*) FROM sqlite_master").get()).toThrow();
    raw.close();
    expect(() => openMemoryDatabase(path, "1e".repeat(32))).toThrow(DatabaseLockedError);
  });

  it("reopens with the right key and keeps data", () => {
    const path = join(tempDir("czar-db-"), "memory.db");
    const db = openMemoryDatabase(path, KEY);
    db.prepare("INSERT INTO settings (key, value_json) VALUES ('paused', 'false')").run();
    db.close();
    const again = openMemoryDatabase(path, KEY);
    expect(again.prepare("SELECT value_json FROM settings WHERE key = 'paused'").get()).toEqual({
      value_json: "false",
    });
    expect(again.pragma("cipher", { simple: true })).toBe("sqlcipher");
    again.close();
  });

  it("stores no plaintext on disk", async () => {
    const { readFileSync } = await import("node:fs");
    const path = join(tempDir("czar-db-"), "memory.db");
    const db = openMemoryDatabase(path, KEY);
    db.prepare(
      "INSERT INTO settings (key, value_json) VALUES ('marker', '\"czar-plaintext-probe\"')",
    ).run();
    db.close();
    expect(readFileSync(path).includes(Buffer.from("czar-plaintext-probe"))).toBe(false);
    expect(readFileSync(path).subarray(0, 15).toString()).not.toBe("SQLite format 3");
  });

  it("rejects a malformed key", () => {
    expect(() => openMemoryDatabase(join(tempDir("czar-db-"), "m.db"), "short")).toThrow(
      "64 lowercase hex",
    );
  });
});
