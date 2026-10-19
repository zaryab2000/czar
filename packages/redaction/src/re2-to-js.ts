// Translates a Go RE2 pattern (as used by gitleaks) into an equivalent JavaScript RegExp source (T-008).
// Node 22 has no scoped modifiers, so `(?i)`, `(?i:…)` and `(?-i:…)` are expanded into explicit ASCII
// case classes and the result needs no flags. RE2 semantics kept: `.` excludes only `\n`, `\s` is
// `[\t\n\f\r ]`, `\z` and `\A` anchor the whole input. Unsupported syntax throws, failing the build.

interface Scope {
  i: boolean;
  s: boolean;
}

const RE2_SPACE = "\\t\\n\\f\\r ";
const POSIX: Readonly<Record<string, string>> = {
  alnum: "0-9A-Za-z",
  alpha: "A-Za-z",
  ascii: "\\x00-\\x7F",
  blank: "\\t ",
  cntrl: "\\x00-\\x1F\\x7F",
  digit: "0-9",
  graph: "!-~",
  lower: "a-z",
  print: " -~",
  punct: "!-\\/:-@\\[-`{-~",
  space: RE2_SPACE + "\\v",
  upper: "A-Z",
  word: "0-9A-Za-z_",
  xdigit: "0-9A-Fa-f",
};

export class UnsupportedPatternError extends Error {
  constructor(pattern: string, at: number, what: string) {
    super(`unsupported RE2 syntax (${what}) at ${at} in ${pattern}`);
    this.name = "UnsupportedPatternError";
  }
}

const isLower = (c: string) => c >= "a" && c <= "z";
const isUpper = (c: string) => c >= "A" && c <= "Z";

function escapeClassChar(c: string): string {
  return /[\\\]^-]/.test(c) ? `\\${c}` : c;
}

/** Ranges of the other ASCII case for the letters inside lo..hi. */
function foldedRanges(lo: number, hi: number): string {
  const out: string[] = [];
  const add = (from: number, to: number, shift: number) => {
    const a = Math.max(lo, from);
    const b = Math.min(hi, to);
    if (a <= b) {
      const x = String.fromCharCode(a + shift);
      const y = String.fromCharCode(b + shift);
      out.push(a === b ? escapeClassChar(x) : `${escapeClassChar(x)}-${escapeClassChar(y)}`);
    }
  };
  add(0x61, 0x7a, -32);
  add(0x41, 0x5a, 32);
  return out.join("");
}

export function translateRe2(pattern: string): string {
  const stack: Scope[] = [{ i: false, s: false }];
  let out = "";
  let p = 0;
  const scope = (): Scope => stack[stack.length - 1] as Scope;

  let classHasNonSpace = false;
  const readEscapeInClass = (): { text: string; code?: number } => {
    const c = pattern[p + 1];
    if (c === undefined) throw new UnsupportedPatternError(pattern, p, "trailing backslash");
    p += 2;
    if (c === "s") return { text: RE2_SPACE };
    if (c === "S") {
      classHasNonSpace = true;
      return { text: "" };
    }
    if (c === "p" || c === "P") throw new UnsupportedPatternError(pattern, p, `\\${c} in class`);
    if (c === "x") {
      const hex = pattern.slice(p, p + 2);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) throw new UnsupportedPatternError(pattern, p, "\\x form");
      p += 2;
      return { text: `\\x${hex}`, code: Number.parseInt(hex, 16) };
    }
    if ("dwDW".includes(c)) return { text: `\\${c}` };
    const named: Readonly<Record<string, number>> = { n: 10, t: 9, r: 13, f: 12, v: 11 };
    if (named[c] !== undefined) return { text: `\\${c}`, code: named[c] };
    if (/[A-Za-z0-9]/.test(c)) throw new UnsupportedPatternError(pattern, p, `\\${c} in class`);
    return { text: escapeClassChar(c), code: c.charCodeAt(0) };
  };

  const readClass = () => {
    p += 1;
    let negated = false;
    if (pattern[p] === "^") {
      negated = true;
      p += 1;
    }
    let body = "";
    let folds = "";
    classHasNonSpace = false;
    let first = true;
    while (p < pattern.length && (pattern[p] !== "]" || first)) {
      first = false;
      if (pattern.startsWith("[:", p)) {
        const end = pattern.indexOf(":]", p + 2);
        const name = end < 0 ? "" : pattern.slice(p + 2, end);
        const set = POSIX[name];
        if (set === undefined) throw new UnsupportedPatternError(pattern, p, "POSIX class");
        body += set;
        p = end + 2;
        continue;
      }
      let lo: { text: string; code?: number };
      if (pattern[p] === "\\") {
        lo = readEscapeInClass();
      } else {
        const c = pattern[p] as string;
        lo = { text: escapeClassChar(c), code: c.charCodeAt(0) };
        p += 1;
      }
      if (pattern[p] === "-" && pattern[p + 1] !== "]" && p + 1 < pattern.length) {
        p += 1;
        let hi: { text: string; code?: number };
        if (pattern[p] === "\\") {
          hi = readEscapeInClass();
        } else {
          const c = pattern[p] as string;
          hi = { text: escapeClassChar(c), code: c.charCodeAt(0) };
          p += 1;
        }
        if (lo.code === undefined || hi.code === undefined) {
          throw new UnsupportedPatternError(pattern, p, "range over a class escape");
        }
        body += `${lo.text}-${hi.text}`;
        if (scope().i) folds += foldedRanges(lo.code, hi.code);
      } else {
        body += lo.text;
        if (scope().i && lo.code !== undefined) folds += foldedRanges(lo.code, lo.code);
      }
    }
    if (pattern[p] !== "]") throw new UnsupportedPatternError(pattern, p, "unterminated class");
    p += 1;
    if (classHasNonSpace) {
      // `[x\S]` = `x` or any non-space: RE2's \S cannot sit inside a JS class without the u flag.
      if (negated) throw new UnsupportedPatternError(pattern, p, "\\S in a negated class");
      out += body + folds === "" ? `[^${RE2_SPACE}]` : `(?:[${body}${folds}]|[^${RE2_SPACE}])`;
      return;
    }
    out += `[${negated ? "^" : ""}${body}${folds}]`;
  };

  const readGroupOpen = () => {
    const rest = pattern.slice(p);
    const flagOnly = /^\(\?([is]*)(?:-([is]*))?\)/.exec(rest);
    if (flagOnly !== null) {
      applyFlags(scope(), flagOnly[1] ?? "", flagOnly[2] ?? "");
      p += flagOnly[0].length;
      return;
    }
    const flagGroup = /^\(\?([is]*)(?:-([is]*))?:/.exec(rest);
    if (flagGroup !== null) {
      const next = { ...scope() };
      applyFlags(next, flagGroup[1] ?? "", flagGroup[2] ?? "");
      stack.push(next);
      out += "(?:";
      p += flagGroup[0].length;
      return;
    }
    const named = /^\(\?P?<([A-Za-z_][A-Za-z0-9_]*)>/.exec(rest);
    if (named !== null) {
      stack.push({ ...scope() });
      out += `(?<${named[1]}>`;
      p += named[0].length;
      return;
    }
    if (rest.startsWith("(?")) throw new UnsupportedPatternError(pattern, p, "group syntax");
    stack.push({ ...scope() });
    out += "(";
    p += 1;
  };

  while (p < pattern.length) {
    const c = pattern[p] as string;
    if (c === "\\") {
      const e = pattern[p + 1];
      if (e === undefined) throw new UnsupportedPatternError(pattern, p, "trailing backslash");
      if (e === "s") out += `[${RE2_SPACE}]`;
      else if (e === "S") out += `[^${RE2_SPACE}]`;
      else if (e === "z") out += "$";
      else if (e === "A") out += "^";
      else if (e === "p" || e === "P" || e === "Q" || e === "C" || /[0-9]/.test(e)) {
        throw new UnsupportedPatternError(pattern, p, `\\${e}`);
      } else if (e === "x") {
        const hex = pattern.slice(p + 2, p + 4);
        if (!/^[0-9A-Fa-f]{2}$/.test(hex))
          throw new UnsupportedPatternError(pattern, p, "\\x form");
        out += `\\x${hex}`;
        p += 2;
      } else out += `\\${e}`;
      p += 2;
    } else if (c === "[") {
      readClass();
    } else if (c === "(") {
      readGroupOpen();
    } else if (c === ")") {
      if (stack.length === 1) throw new UnsupportedPatternError(pattern, p, "unbalanced )");
      stack.pop();
      out += ")";
      p += 1;
    } else if (c === ".") {
      out += scope().s ? "[\\s\\S]" : "[^\\n]";
      p += 1;
    } else if (scope().i && (isLower(c) || isUpper(c))) {
      out += `[${c.toLowerCase()}${c.toUpperCase()}]`;
      p += 1;
    } else {
      out += c;
      p += 1;
    }
  }
  if (stack.length !== 1) throw new UnsupportedPatternError(pattern, p, "unbalanced (");
  // Validate the result compiles.
  if (!(new RegExp(out) instanceof RegExp)) throw new UnsupportedPatternError(pattern, p, "compile");
  return out;
}

function applyFlags(target: Scope, on: string, off: string) {
  for (const flag of on) target[flag as "i" | "s"] = true;
  for (const flag of off) target[flag as "i" | "s"] = false;
}
