import { soulVersionHash, type SoulVersionInput } from "@czar/hashing";
import type { MemoryDatabase } from "#src/database";

interface SoulRow {
  readonly soul_json: string;
}

/** Returns the current soul hash, creating the SCR-147 seed only on first use. */
export function currentSoulVersionHash(db: MemoryDatabase, now: Date): string {
  const row = db
    .prepare("SELECT soul_json FROM soul_versions ORDER BY version DESC LIMIT 1")
    .get() as SoulRow | undefined;
  if (row !== undefined) return soulVersionHash(readSoul(row.soul_json));
  const seed: SoulVersionInput = { version: 0, compiledAt: now.toISOString(), sections: {} };
  const hash = soulVersionHash(seed);
  db.prepare(
    `INSERT INTO soul_versions
     (version,compiled_at,soul_version_hash,soul_json)
     VALUES (0,?,?,?)`,
  ).run(now.getTime(), Buffer.from(hash.slice(2), "hex"), JSON.stringify(seed));
  return hash;
}

function readSoul(json: string): SoulVersionInput {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("Stored soul version is unreadable; objective was not sent.");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    !Number.isSafeInteger(value.version) ||
    !("compiledAt" in value) ||
    typeof value.compiledAt !== "string" ||
    !("sections" in value) ||
    typeof value.sections !== "object" ||
    value.sections === null ||
    Array.isArray(value.sections)
  ) {
    throw new Error("Stored soul version has an invalid shape; objective was not sent.");
  }
  return value as SoulVersionInput;
}
