import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CanonicalizationError, H, jcsString } from "@czar/hashing";
import { keccak256, toHex } from "viem";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe("jcs (RFC 8785 + 02 §5.1)", () => {
  it("sorts keys by UTF-16 code units, no whitespace", () => {
    // RFC 8785 §3.2.3 sorting example keys.
    const input = {
      "€": "Euro Sign",
      "\r": "Carriage Return",
      דּ: "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "\u0080": "Control",
      ö: "Latin Small Letter O With Diaeresis",
    };
    // Read the key order from the text: JSON.parse would move integer-like keys ("1") first.
    const keys = [...jcsString(input).matchAll(/"((?:[^"\\]|\\.)*)":/g)].map(
      (m) => JSON.parse(`"${m[1]}"`) as string,
    );
    expect(keys).toEqual(["\r", "1", "\u0080", "ö", "€", "😀", "דּ"]);
  });

  it("serializes numbers in the shortest round-trip form (RFC 8785 Appendix B samples)", () => {
    const cases: [number, string][] = [
      [0, "0"],
      [-0, "0"],
      [1e21, "1e+21"],
      [1e-7, "1e-7"],
      [123456789012345680000, "123456789012345680000"],
      [4.5, "4.5"],
      [0.000001, "0.000001"],
      [-5e-324, "-5e-324"],
      [9007199254740992, "9007199254740992"],
      [333333333.3333333, "333333333.3333333"],
    ];
    for (const [value, text] of cases) expect(jcsString(value)).toBe(text);
  });

  it("escapes strings per RFC 8785", () => {
    expect(jcsString('\u0000\b\t\n\f\r"\\/\u001f\u007f é')).toBe(
      '"\\u0000\\b\\t\\n\\f\\r\\"\\\\/\\u001f\u007f é"',
    );
  });

  it("matches the RFC 8785 §3.2.4 example", () => {
    // RFC 8785 §3.2.4 input and output, kept in fixtures so no formatter reinterprets the escapes.
    // The RFC's input also has a null literal, which Czar refuses; it is left out of both files.
    const input = JSON.parse(readFileSync(fixture("rfc8785-input.json"), "utf8")) as unknown;
    expect(jcsString(input)).toBe(readFileSync(fixture("rfc8785-expected.txt"), "utf8"));
  });

  it("lowercases addresses, keeps hashes and omits undefined fields", () => {
    expect(
      jcsString({
        b: undefined,
        a: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
        h: `0x${"AB".repeat(32)}`,
      }),
    ).toBe(`{"a":"0x0077777d7eba4688bdef3e311b846f25870a19b9","h":"0x${"AB".repeat(32)}"}`);
  });

  it("refuses null, NaN, Infinity and bigint", () => {
    for (const bad of [{ a: null }, Number.NaN, Number.POSITIVE_INFINITY, 1n, [undefined]]) {
      expect(() => jcsString(bad)).toThrow(CanonicalizationError);
    }
  });

  it("H(x) = keccak256(jcs(x)) as lowercase hex", () => {
    expect(H({ b: 1, a: "x" })).toBe(keccak256(toHex('{"a":"x","b":1}')));
    expect(H({ a: 1 })).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
