// Every `section.name` parameter named in specs/04-components exists in the registry (T-004).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PARAMETERS } from "@czar/config";
import { NON_PARAMETERS, WILDCARDS } from "@czar/config/non-parameters";

const SPEC_DIR = fileURLToPath(new URL("../../../specs/04-components", import.meta.url));
const SECTIONS = [...new Set(PARAMETERS.map((spec) => spec.key.split(".")[0]))];
const TOKEN = new RegExp(
  `(?<![\\w.-])(?:${SECTIONS.join("|")})\\.[A-Za-z0-9*<>_-]+(?:\\.[A-Za-z0-9*<>_-]+)*`,
  "g",
);

function specTokens(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of readdirSync(SPEC_DIR).filter((name) => name.endsWith(".md"))) {
    const text = readFileSync(join(SPEC_DIR, file), "utf8");
    for (const span of text.matchAll(/`([^`\n]+)`/g)) {
      for (const match of (span[1] ?? "").matchAll(TOKEN)) {
        let token = match[0].replace(/[.-]+$/, "");
        // `<daemon.hookPort>` is a placeholder around a key; drop an unbalanced closing bracket.
        if (token.endsWith(">") && !token.includes("<")) token = token.slice(0, -1);
        if (!found.has(token)) found.set(token, file);
      }
    }
  }
  return found;
}

describe("spec coverage", () => {
  it("finds parameter names in the specs", () => {
    expect(specTokens().size).toBeGreaterThan(250);
  });

  it("every parameter named in specs/04-components is in the registry (0 missing)", () => {
    const keys = new Set<string>(PARAMETERS.map((spec) => spec.key));
    const excluded = new Set([
      ...NON_PARAMETERS.map((entry) => entry.token),
      ...Object.keys(WILDCARDS),
    ]);
    const missing = [...specTokens()]
      .filter(([token]) => !keys.has(token) && !excluded.has(token))
      .map(([token, file]) => `${token} (${file})`);
    expect(missing).toEqual([]);
  });

  it("every wildcard expands to registry keys", () => {
    const keys = new Set<string>(PARAMETERS.map((spec) => spec.key));
    for (const [wildcard, expanded] of Object.entries(WILDCARDS)) {
      for (const key of expanded) expect(keys.has(key), `${wildcard} → ${key}`).toBe(true);
    }
  });
});
