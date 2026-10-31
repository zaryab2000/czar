import { describe, expect, it } from "vitest";
import { keccak256, toBytes } from "viem";
import { ratingLineageRoot } from "../src/index.ts";

describe("rating lineage root", () => {
  it("hashes sorted ids as raw comma-joined UTF-8, not JCS", () => {
    const ids = ["rtg_b", "rtg_a"];
    expect(ratingLineageRoot(ids)).toBe(keccak256(toBytes("rtg_a,rtg_b")));
    expect(ratingLineageRoot(ids.toReversed())).toBe(ratingLineageRoot(ids));
  });
});
