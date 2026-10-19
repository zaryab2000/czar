// Vendored gitleaks v8.30.1 test corpus (T-008): every true positive is replaced with the right
// marker and no secret substring remains; no false positive is flagged.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detectSecrets, redactSecrets, RULES, TEXT_RULE_IDS } from "@czar/redaction";

interface CorpusRule {
  rule: string;
  pathRule: boolean;
  truePositives: { text: string; secrets: string[] }[];
  falsePositives: string[];
}

const decode = (value: string) => Buffer.from(value, "base64").toString("utf8");
const corpus = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../vendor/gitleaks-v8.30.1/corpus.json", import.meta.url)),
    "utf8",
  ),
) as { rules: CorpusRule[] };
const textRules = new Set(TEXT_RULE_IDS);
const covered = corpus.rules.filter((entry) => textRules.has(entry.rule));

describe("gitleaks v8.30.1 corpus", () => {
  it("covers every text rule except the two with no upstream samples", () => {
    const withSamples = new Set(
      covered.filter((entry) => entry.truePositives.length > 0).map((entry) => entry.rule),
    );
    const missing = TEXT_RULE_IDS.filter((id) => !withSamples.has(id)).toSorted();
    expect(RULES).toHaveLength(222);
    expect(missing).toEqual(["dropbox-long-lived-api-token", "dropbox-short-lived-api-token"]);
  });

  it.each(covered.map((entry) => [entry.rule, entry] as const))(
    "%s: true positives are redacted",
    (rule, entry) => {
      for (const sample of entry.truePositives) {
        const text = decode(sample.text);
        const secrets = sample.secrets.map(decode);
        expect(
          detectSecrets(text, [rule]).length,
          `rule ${rule} sample ${sample.text}`,
        ).toBeGreaterThan(0);
        const single = redactSecrets(text, [rule]);
        expect(single.text).toContain(`[[R:S:${rule}]]`);
        for (const secret of secrets)
          expect(single.text.includes(secret), `rule ${rule} leaked`).toBe(false);
        const all = redactSecrets(text);
        for (const secret of secrets)
          expect(all.text.includes(secret), `rule ${rule} leaked (all rules)`).toBe(false);
        expect(redactSecrets(all.text).text, `rule ${rule} not idempotent`).toBe(all.text);
      }
    },
  );

  it.each(covered.map((entry) => [entry.rule, entry] as const))(
    "%s: false positives are not flagged",
    (rule, entry) => {
      for (const sample of entry.falsePositives) {
        expect(detectSecrets(decode(sample), [rule]), `rule ${rule} sample ${sample}`).toEqual([]);
      }
    },
  );
});
