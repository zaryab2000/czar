import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { redactSecrets, shannonEntropy } from "@czar/redaction";

// Assembled at run time so the source file itself holds no secret-shaped literal.
const FAKE_AWS = ["AKIA", "QYLPMN5HHHFPZAM2"].join("");
const FAKE_GITHUB = ["ghp_", "8Rx1Dq3aJmCz9vTgLwYp5Nk7HbEo2Ui4Fs6V"].join("");

describe("redactSecrets", () => {
  it("replaces a secret with its marker and counts hits by rule", () => {
    const result = redactSecrets(`deploy with ${FAKE_AWS} today`);
    expect(result.text).toBe("deploy with [[R:S:aws-access-token]] today");
    expect(result.hits).toEqual([{ rule: "aws-access-token", count: 1 }]);
  });

  it("is idempotent", () => {
    const once = redactSecrets(`token=${FAKE_GITHUB} and key ${FAKE_AWS}`).text;
    expect(redactSecrets(once).text).toBe(once);
    expect(redactSecrets(once).hits).toEqual([]);
  });

  it("leaves text without secrets unchanged", () => {
    const text = "Refactor the payment router; tests pass on Node 22.";
    expect(redactSecrets(text)).toEqual({ text, hits: [] });
  });

  it("honours the gitleaks:allow line signature like gitleaks does", () => {
    const text = `${FAKE_AWS} # gitleaks:allow`;
    expect(redactSecrets(text).text).toBe(text);
  });

  it("computes entropy like gitleaks (per code point over UTF-8 bytes)", () => {
    expect(shannonEntropy("")).toBe(0);
    expect(shannonEntropy("aaaa")).toBe(0);
    expect(shannonEntropy("ab")).toBeCloseTo(1, 10);
  });

  it("finds no secret in the clean corpus (this repo's specs and product docs)", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const files = ["product", "architecture", "specs/04-components", "specs/05-build-plan"].flatMap(
      (dir) =>
        readdirSync(join(root, dir))
          .filter((name) => name.endsWith(".md"))
          .map((name) => join(root, dir, name)),
    );
    expect(files.length).toBeGreaterThan(10);
    const hits = files.flatMap((file) =>
      redactSecrets(readFileSync(file, "utf8")).hits.map((hit) => `${file}: ${hit.rule}`),
    );
    expect(hits).toEqual([]);
  });

  it("meets the layer-1 budget of ≤ 20 ms per 10 KB on typical text (CZ-26 §13)", () => {
    const chunk =
      "const total = items.reduce((sum, item) => sum + item.price, 0); // user asked for a summary\n";
    const text = chunk.repeat(Math.ceil(10_240 / chunk.length)).slice(0, 10_240);
    redactSecrets(text);
    const runs = 10;
    const started = performance.now();
    for (let i = 0; i < runs; i += 1) redactSecrets(text);
    expect((performance.now() - started) / runs).toBeLessThan(20);
  });
});

describe("never calls live verification", () => {
  it("has no network client or trufflehog reference in the package source", () => {
    const src = fileURLToPath(new URL("../src", import.meta.url));
    const sources = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(join(src, name), "utf8"))
      .join("\n");
    for (const forbidden of [
      /trufflehog/i,
      /\bfetch\(/,
      /node:https?\b/,
      /node:net\b/,
      /XMLHttpRequest/,
      /\bverify(Secret|Key)\b/,
    ]) {
      expect(forbidden.test(sources), String(forbidden)).toBe(false);
    }
  });
});
