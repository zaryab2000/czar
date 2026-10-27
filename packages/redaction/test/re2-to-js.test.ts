import { describe, expect, it } from "vitest";
import { translateRe2, UnsupportedPatternError } from "@czar/redaction/re2";

const compile = (pattern: string) => new RegExp(translateRe2(pattern));

describe("translateRe2", () => {
  it("expands (?i) at the start", () => {
    expect(compile("(?i)abc").test("AbC")).toBe(true);
  });

  it("scopes (?i) to the enclosing group", () => {
    const re = compile("x(?:(?i)ab)c");
    expect(re.test("xABc")).toBe(true);
    expect(re.test("xABC")).toBe(false);
  });

  it("supports (?i:…) and (?-i:…)", () => {
    expect(compile("a(?i:b)c").test("aBc")).toBe(true);
    const re = compile("(?i)a(?-i:b)c");
    expect(re.test("AbC")).toBe(true);
    expect(re.test("ABC")).toBe(false);
  });

  it("folds classes and ranges under (?i)", () => {
    const re = compile("(?i)^[a-c0-9]+$");
    expect(re.test("AbC09")).toBe(true);
    expect(re.test("d")).toBe(false);
    expect(compile("(?i)^[^a-z]$").test("Q")).toBe(false);
  });

  it("keeps RE2 dot and \\s semantics", () => {
    expect(compile("^a.b$").test("a\rb")).toBe(true);
    expect(compile("^a.b$").test("a\nb")).toBe(false);
    expect(compile("(?s:a.b)").test("a\nb")).toBe(true);
    expect(compile("^\\s$").test(" ")).toBe(false);
    expect(compile("^\\s$").test("\t")).toBe(true);
  });

  it("translates \\z, \\A, POSIX classes and named groups", () => {
    expect(compile("ab\\z").test("xab")).toBe(true);
    expect(compile("\\Aab").test("xab")).toBe(false);
    expect(compile("^[[:alnum:]]+$").test("aZ9")).toBe(true);
    expect(new RegExp(translateRe2("(?P<alg>ab)")).exec("ab")?.groups?.["alg"]).toBe("ab");
  });

  it("treats a leading ] in a class as a literal", () => {
    expect(compile("^[]a]+$").test("]a")).toBe(true);
  });

  it("refuses syntax it cannot translate exactly", () => {
    expect(() => translateRe2("\\pL")).toThrow(UnsupportedPatternError);
    expect(() => translateRe2("(?m)a")).toThrow(UnsupportedPatternError);
    expect(() => translateRe2("(a")).toThrow(UnsupportedPatternError);
  });
});

describe("translateRe2 \\S in a class", () => {
  it("expresses [\\S] and [x\\S] without the u flag", () => {
    expect(compile("^[\\S]+$").test("ab c")).toBe(true);
    expect(compile("^[\\S]+$").test("a b")).toBe(false);
    expect(() => translateRe2("[^\\S]")).toThrow(UnsupportedPatternError);
  });
});
