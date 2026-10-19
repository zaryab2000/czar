// Layer 1: secrets. Runs the vendored gitleaks v8.30.1 rules and replaces each secret with
// `[[R:S:<rule>]]` (CZ-26 §4, 02 §3.1). Detection mirrors gitleaks detect.go `detectRule` for text
// without a file path: keyword prefilter, secret group, entropy, global and rule allowlists.
// Never calls any live verification service (C2-07).
import { formatMarker, parseMarkers } from "./markers.ts";
import { GLOBAL_ALLOWLIST, RULES } from "./generated/gitleaks-rules.ts";
import type { CompiledAllowlist, CompiledRule, RedactionResult, RuleHit } from "./types.ts";

const ALLOW_SIGNATURE = "gitleaks:allow";

export interface Finding {
  readonly rule: string;
  /** Offsets of the whole rule match inside the scanned text; the redacted span. */
  readonly start: number;
  readonly end: number;
  /** The secret as gitleaks reports it (a capture group of the match, or the match). */
  readonly secret: string;
}

interface Prepared {
  readonly rule: CompiledRule;
  readonly global: RegExp;
  readonly single: RegExp;
  readonly allowlists: readonly PreparedAllowlist[];
}

interface PreparedAllowlist {
  readonly source: CompiledAllowlist;
  readonly regexes: readonly RegExp[];
}

const prepareAllowlist = (allowlist: CompiledAllowlist): PreparedAllowlist => ({
  source: allowlist,
  regexes: allowlist.regexes.map((source) => new RegExp(source)),
});

const PREPARED_GLOBAL = prepareAllowlist(GLOBAL_ALLOWLIST);
const PREPARED: readonly Prepared[] = RULES.filter(
  (rule) => rule.regex !== null && !rule.pathRule,
).map((rule) => ({
  rule,
  global: new RegExp(rule.regex as string, "g"),
  single: new RegExp(rule.regex as string),
  allowlists: rule.allowlists.map(prepareAllowlist),
}));

/** Rules that can fire on text (path-gated and path-only rules cannot). */
export const TEXT_RULE_IDS: readonly string[] = PREPARED.map((prepared) => prepared.rule.id);

/** Shannon entropy as gitleaks computes it: counts per code point, divided by the UTF-8 byte length. */
export function shannonEntropy(data: string): number {
  if (data === "") return 0;
  const counts = new Map<string, number>();
  for (const char of data) counts.set(char, (counts.get(char) ?? 0) + 1);
  const invLength = 1 / Buffer.byteLength(data, "utf8");
  let entropy = 0;
  for (const count of counts.values()) {
    const freq = count * invLength;
    entropy -= freq * Math.log2(freq);
  }
  return entropy;
}

function isAllowed(
  allowlist: PreparedAllowlist,
  secret: string,
  match: string,
  line: string,
): boolean {
  const { source } = allowlist;
  const target = source.target === "match" ? match : source.target === "line" ? line : secret;
  const regexAllowed = target !== "" && allowlist.regexes.some((regex) => regex.test(target));
  const lowerSecret = secret.toLowerCase();
  const stopword = secret !== "" && source.stopwords.some((word) => lowerSecret.includes(word));
  if (source.condition === "AND") {
    const checks: boolean[] = [];
    if (source.hasPathOrCommitCheck) checks.push(false);
    if (source.regexes.length > 0) checks.push(regexAllowed);
    if (source.stopwords.length > 0) checks.push(stopword);
    return checks.every(Boolean);
  }
  return regexAllowed || stopword;
}

function lineAround(text: string, start: number, end: number): string {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const next = text.indexOf("\n", end);
  return text.slice(lineStart, next < 0 ? text.length : next);
}

function trimNewlines(value: string): { text: string; lead: number } {
  let a = 0;
  let b = value.length;
  while (a < b && value[a] === "\n") a += 1;
  while (b > a && value[b - 1] === "\n") b -= 1;
  return { text: value.slice(a, b), lead: a };
}

function detectWith(text: string, lower: string, prepared: Prepared): Finding[] {
  const { rule } = prepared;
  if (rule.keywords.length > 0 && !rule.keywords.some((keyword) => lower.includes(keyword)))
    return [];
  const findings: Finding[] = [];
  prepared.global.lastIndex = 0;
  for (const found of text.matchAll(prepared.global)) {
    if (found[0] === "") continue;
    const { text: match, lead } = trimNewlines(found[0]);
    const matchStart = found.index + lead;
    const line = lineAround(text, matchStart, matchStart + match.length);
    if (line.includes(ALLOW_SIGNATURE)) continue;

    let secret = match;
    const groups = prepared.single.exec(match);
    if (groups !== null && groups.length >= 2) {
      if (rule.secretGroup > 0) {
        if (groups.length <= rule.secretGroup) continue;
        secret = groups[rule.secretGroup] ?? "";
      } else {
        const firstGroup = groups.slice(1).find((group) => group !== undefined && group.length > 0);
        if (firstGroup !== undefined) secret = firstGroup;
      }
    }
    if (rule.entropy !== 0 && shannonEntropy(secret) <= rule.entropy) continue;
    if (isAllowed(PREPARED_GLOBAL, secret, match, line)) continue;
    if (prepared.allowlists.some((allowlist) => isAllowed(allowlist, secret, match, line)))
      continue;
    findings.push({ rule: rule.id, start: matchStart, end: matchStart + match.length, secret });
  }
  return findings;
}

/** All layer-1 findings in `text`, optionally limited to some rule ids. */
export function detectSecrets(text: string, ruleIds?: readonly string[]): Finding[] {
  const lower = text.toLowerCase();
  const wanted = ruleIds === undefined ? undefined : new Set(ruleIds);
  return PREPARED.filter(
    (prepared) => wanted === undefined || wanted.has(prepared.rule.id),
  ).flatMap((prepared) => detectWith(text, lower, prepared));
}

/**
 * `redactSecrets(text) → {text, hits}` (CZ-26 §4). Every rule match is replaced whole (cross-cutting §2),
 * not only the capture group gitleaks reports, so no part of a token is left behind. Overlapping matches
 * merge into one span marked with the earliest rule; every merged rule is counted. Findings that touch an
 * existing marker are ignored, so redacting twice changes nothing.
 */
export function redactSecrets(text: string, ruleIds?: readonly string[]): RedactionResult {
  const existing = parseMarkers(text);
  const candidates = detectSecrets(text, ruleIds)
    .filter(
      (finding) =>
        !existing.some((marker) => finding.start < marker.end && finding.end > marker.start),
    )
    .toSorted(
      (a, b) =>
        a.start - b.start || b.end - b.start - (a.end - a.start) || (a.rule < b.rule ? -1 : 1),
    );

  const spans: { start: number; end: number; rule: string }[] = [];
  const counts = new Map<string, number>();
  for (const finding of candidates) {
    counts.set(finding.rule, (counts.get(finding.rule) ?? 0) + 1);
    const last = spans.at(-1);
    if (last !== undefined && finding.start < last.end) {
      last.end = Math.max(last.end, finding.end);
    } else {
      spans.push({ start: finding.start, end: finding.end, rule: finding.rule });
    }
  }

  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start) + formatMarker("S", span.rule);
    cursor = span.end;
  }
  out += text.slice(cursor);
  const hits: RuleHit[] = [...counts.entries()]
    .map(([rule, count]) => ({ rule, count }))
    .toSorted((a, b) => (a.rule < b.rule ? -1 : 1));
  return { text: out, hits };
}
