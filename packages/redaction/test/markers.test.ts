import { describe, expect, it } from "vitest";
import {
  formatMarker,
  isValidMarker,
  parseMarkers,
  truncatePreservingMarkers,
} from "@czar/redaction";

describe("markers (02 §3.1)", () => {
  it("formats the spec examples", () => {
    expect(formatMarker("S", "generic-api-key")).toBe("[[R:S:generic-api-key]]");
    expect(formatMarker("P", "EMAIL_ADDRESS")).toBe("[[R:P:EMAIL_ADDRESS]]");
    expect(formatMarker("P", "PHONE_NUMBER", 2)).toBe("[[R:P:PHONE_NUMBER#2]]");
  });

  it("parses markers with their positions", () => {
    const text = "call [[R:P:PERSON#1]] about [[R:S:aws-access-token]]";
    expect(parseMarkers(text)).toEqual([
      { layer: "P", type: "PERSON", n: 1, start: 5, end: 21 },
      { layer: "S", type: "aws-access-token", start: 28, end: 52 },
    ]);
  });

  // Mutation tests: every single-character change to a valid marker is rejected or still valid.
  it.each([
    "[[R:S:Generic-api-key]]",
    "[[R:P:email_address]]",
    "[[R:X:PERSON]]",
    "[[R:P:PERSON#0]]",
    "[[R:P:PERSON#01]]",
    "[[R:P:PERSON#]]",
    "[R:P:PERSON]]",
    "[[R:P:PERSON]",
    "[[R:P:]]",
    "[[R:S:aws--token]]",
    "[[R:S:-aws]]",
    "[[r:P:PERSON]]",
    "[[R:P:PÉRSON]]",
  ])("rejects malformed marker %s", (text) => {
    expect(isValidMarker(text)).toBe(false);
  });

  it("rejects every one-character deletion of a structural character", () => {
    const valid = "[[R:P:PHONE_NUMBER#2]]";
    const structural = [0, 1, 2, 3, 4, 5, valid.length - 3, valid.length - 2, valid.length - 1];
    for (const i of structural) {
      const mutant = valid.slice(0, i) + valid.slice(i + 1);
      expect(isValidMarker(mutant), mutant).toBe(false);
    }
  });

  it("never splits a marker when truncating", () => {
    const text = "abc [[R:S:aws-access-token]] tail";
    expect(truncatePreservingMarkers(text, 10)).toBe("abc ");
    expect(truncatePreservingMarkers(text, 28)).toBe("abc [[R:S:aws-access-token]]");
    expect(truncatePreservingMarkers(text, 100)).toBe(text);
  });
});
