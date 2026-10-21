import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const live = args.includes("--live");
const regexOnly = args.includes("--regex-only");
const selected = args.filter((arg) => /^P-0[12]$/.test(arg));
const prompts = regexOnly ? ["P-01"] : selected.length ? selected : ["P-01", "P-02"];

if (live && regexOnly) {
  process.stderr.write("Choose either --live or --regex-only.\n");
  process.exitCode = 1;
} else if (
  live &&
  (process.env["CZAR_G0_16_RECORDED"] !== "1" || process.env["CZAR_K18_APPROVED"] !== "1")
) {
  process.stderr.write("Refusing live eval: G0-16 and K18 approval are not recorded.\n");
  process.exitCode = 1;
} else if (live) {
  process.stderr.write(
    "Live eval requires a separately approved model adapter; no hosted calls are enabled here.\n",
  );
  process.exitCode = 1;
} else {
  const { regexScreen } = await import(pathToFileURL(resolve(root, "src/boundary/index.ts")));
  const source = await readFile(
    resolve(root, "../../docs/specs/04-components/shared/ai-prompts.md"),
    "utf8",
  );
  for (const prompt of prompts) {
    await verifyPrompt(prompt, source);
    const fixture = JSON.parse(
      await readFile(resolve(root, `../../models/evals/${prompt}/cases.json`), "utf8"),
    );
    if (prompt === "P-01" && regexOnly) evalRegexCases(fixture.cases, regexScreen);
    else if (prompt === "P-01") await evalScreenCases(fixture.cases, regexScreen);
    if (prompt === "P-02") evalReaderCases(fixture.cases);
    const caseCount = regexOnly ? 6 : fixture.cases.length;
    const mode = regexOnly ? "regex-only" : "offline";
    process.stdout.write(`${prompt}: ${caseCount}/${caseCount} ${mode} cases passed\n`);
  }
}

async function verifyPrompt(prompt, source) {
  const section = source.slice(source.indexOf(`## ${prompt} `));
  const match = section.match(/\*\*System prompt \(full text\):\*\*\s*```\n([\s\S]*?)\n```/);
  assert.ok(match, `${prompt} prompt missing from ai-prompts.md`);
  const stored = await readFile(resolve(root, `../../models/${prompt}.md`), "utf8");
  assert.equal(stored, `${match[1]}\n`, `${prompt}.md differs from ai-prompts.md`);
}

async function evalScreenCases(cases, regexScreen) {
  for (const fixture of cases) {
    const regexFlags = regexScreen(fixture.body);
    const union = new Set([...regexFlags, ...fixture.recordedReply.flags]);
    assert.ok(union.has(fixture.expected), `P-01 case ${fixture.id} missing ${fixture.expected}`);
    if ([2, 3, 4, 5, 6, 9].includes(fixture.id))
      assert.ok(
        regexFlags.includes("injection-suspect"),
        `P-01 regex-only case ${fixture.id} missed`,
      );
  }
}

function evalRegexCases(cases, regexScreen) {
  const required = new Set([2, 3, 4, 5, 6, 9]);
  for (const fixture of cases.filter((item) => required.has(item.id))) {
    assert.ok(
      regexScreen(fixture.body).includes("injection-suspect"),
      `P-01 regex-only case ${fixture.id} missed`,
    );
  }
}

function evalReaderCases(cases) {
  for (const fixture of cases) {
    const allowed = new Set(fixture.expectedFields);
    if (fixture.adversarialReply) {
      const replyKeys = new Set(["status", "fields", "flags", "missing"]);
      assert.ok(
        Object.keys(fixture.adversarialReply).some((key) => !replyKeys.has(key)),
        `P-02 case ${fixture.id} lacks a protected-field mutation fixture`,
      );
    }
    const fields = fixture.reply.fields.filter((field) => allowed.has(field.name));
    const expectedType = fixture.id === 4 ? "number" : null;
    const accepted = fields.filter((field) => {
      if (expectedType === "number" && field.name === "price")
        return Number.isFinite(Number(field.value));
      return !/0x[a-f0-9]{6,}|\b\d+(?:\.\d+)?\s*USDC\b|https?:\/\//i.test(field.value);
    });
    const status = accepted.length === fixture.expectedFields.length ? "delivered" : "unknown";
    assert.equal(status, fixture.expectedStatus, `P-02 case ${fixture.id} status`);
    assert.deepEqual(
      fixture.codeFields,
      fixture.protectedFieldsExpected,
      `P-02 case ${fixture.id} modified protected fields`,
    );
    for (const field of accepted)
      assert.ok(allowed.has(field.name), `P-02 case ${fixture.id} added a field`);
  }
}
