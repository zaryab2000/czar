import { describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, toHex } from "viem";
import {
  buildTree,
  evidenceLeaf,
  H,
  hashPair,
  KIND_TAGS,
  payeeLeaf,
  pocketLeaf,
  POCKET_STEP_INDEX,
  verifyProof,
  ZERO_ROOT,
  type Hash32,
} from "@czar/hashing";

/** Deterministic pseudo-random 32-byte values for the property test. */
function leavesFor(seed: number, count: number): Hash32[] {
  return Array.from({ length: count }, (_, i) =>
    keccak256(toHex(`czar-merkle-property-${seed}-${i}`)),
  );
}

describe("czar-merkle-v1 (02 §5.3)", () => {
  it("empty tree root is bytes32(0); one leaf is its own root with an empty proof", () => {
    expect(buildTree([]).root).toBe(ZERO_ROOT);
    const [leaf] = leavesFor(0, 1) as [Hash32];
    const tree = buildTree([leaf]);
    expect(tree.root).toBe(leaf);
    expect(tree.proof(leaf)).toEqual([]);
  });

  it("nodes are commutative keccak of the sorted pair", () => {
    const [a, b] = leavesFor(1, 2) as [Hash32, Hash32];
    const [lo, hi] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
    expect(hashPair(a, b)).toBe(
      keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [lo, hi])),
    );
    expect(hashPair(a, b)).toBe(hashPair(b, a));
  });

  it("an odd node is carried up unchanged", () => {
    const leaves = leavesFor(2, 3);
    const tree = buildTree(leaves);
    const [s0, s1, s2] = tree.leaves as [Hash32, Hash32, Hash32];
    expect(tree.root).toBe(hashPair(hashPair(s0, s1), s2));
  });

  it("the input order does not change the root", () => {
    const leaves = leavesFor(3, 9);
    expect(buildTree(leaves.toReversed()).root).toBe(buildTree(leaves).root);
  });

  it("property: every proof verifies with MerkleProof.verify rules, and fails for a wrong leaf or root", () => {
    for (let seed = 0; seed < 60; seed += 1) {
      const count = 1 + ((seed * 7) % 41);
      const leaves = leavesFor(100 + seed, count);
      const tree = buildTree(leaves);
      for (const leaf of leaves) {
        const proof = tree.proof(leaf);
        expect(verifyProof(proof, tree.root, leaf)).toBe(true);
        expect(proof.length).toBeLessThanOrEqual(Math.ceil(Math.log2(count)));
      }
      const outsider = keccak256(toHex(`outsider-${seed}`));
      expect(verifyProof(tree.proof(leaves[0] as Hash32), tree.root, outsider)).toBe(false);
      if (count > 1)
        expect(verifyProof(tree.proof(leaves[0] as Hash32), outsider, leaves[0] as Hash32)).toBe(
          false,
        );
    }
  });

  it("refuses duplicate leaves", () => {
    const [a] = leavesFor(4, 1) as [Hash32];
    expect(() => buildTree([a, a])).toThrow("duplicate");
  });

  it("payee leaf is the double-hashed tagged encoding", () => {
    const payee = "0x000000000000000000000000000000000000bEEF";
    const inner = keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "address" },
          { type: "uint8" },
          { type: "uint32" },
          { type: "uint256" },
        ],
        [KIND_TAGS.PAYEE_LEAF, payee, 1, 2, 100000n],
      ),
    );
    expect(payeeLeaf(payee, 1, 2, 100000n)).toBe(keccak256(inner));
  });

  it("pocket leaf is kind 4 with POCKET_STEP_INDEX and stepCap 0 (D71)", () => {
    const pocket = "0x000000000000000000000000000000000000b0c0";
    expect(pocketLeaf(pocket)).toBe(payeeLeaf(pocket, 4, POCKET_STEP_INDEX, 0n));
    expect(() => payeeLeaf(pocket, 4, 0, 0n)).toThrow("D71");
  });

  it("evidence leaf binds leafType and H(leaf object)", () => {
    const leaf = { leafType: "soul-version", leafVersion: 1 };
    const inner = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
        [KIND_TAGS.EVIDENCE_LEAF, keccak256(toHex("soul-version")), H(leaf)],
      ),
    );
    expect(evidenceLeaf("soul-version", leaf)).toBe(keccak256(inner));
    expect(evidenceLeaf("demand-proof", leaf)).not.toBe(evidenceLeaf("soul-version", leaf));
  });
});
