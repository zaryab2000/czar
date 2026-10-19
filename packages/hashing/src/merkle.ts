// czar-merkle-v1 (02 §5.3): tagged double-hashed leaves, sorted-pair nodes, leaves sorted by hash,
// odd node carried up, empty root bytes32(0). Proofs verify with OpenZeppelin `MerkleProof.verify`.
import { encodeAbiParameters, keccak256, toHex } from "viem";
import { KIND_TAGS, type Address, type Hash32 } from "./eip712.ts";
import { H } from "./jcs.ts";

export const ZERO_ROOT: Hash32 = `0x${"0".repeat(64)}`;
/** Pocket leaves always use this step index (02 §4.7, D71). */
export const POCKET_STEP_INDEX = 4294967295;

export const PAYEE_KIND = { X402_PAY_TO: 1, ERC8183_PROVIDER: 2, TIP_REPO: 3, POCKET: 4 } as const;

const outer = (inner: Hash32): Hash32 => keccak256(inner);

/** `keccak256(bytes.concat(keccak256(abi.encode(PAYEE_LEAF, payee, uint8 kind, uint32 stepIndex, uint256 stepCap))))`. */
export function payeeLeaf(
  payee: Address,
  kind: number,
  stepIndex: number,
  stepCap: bigint,
): Hash32 {
  if (kind === PAYEE_KIND.POCKET && (stepIndex !== POCKET_STEP_INDEX || stepCap !== 0n)) {
    throw new Error("a pocket leaf has stepIndex 4294967295 and stepCap 0 (D71)");
  }
  return outer(
    keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "address" },
          { type: "uint8" },
          { type: "uint32" },
          { type: "uint256" },
        ],
        [KIND_TAGS.PAYEE_LEAF, payee, kind, stepIndex, stepCap],
      ),
    ),
  );
}

/** Kind-4 pocket leaf (D71). */
export const pocketLeaf = (pocket: Address): Hash32 =>
  payeeLeaf(pocket, PAYEE_KIND.POCKET, POCKET_STEP_INDEX, 0n);

/** `abi.encode(EVIDENCE_LEAF, keccak256(utf8(leafType)), H(leaf object))`, double hashed. */
export function evidenceLeaf(leafType: string, leafObject: unknown): Hash32 {
  return outer(
    keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
        [KIND_TAGS.EVIDENCE_LEAF, keccak256(toHex(leafType)), H(leafObject)],
      ),
    ),
  );
}

/** OpenZeppelin `Hashes.commutativeKeccak256`. */
export function hashPair(a: Hash32, b: Hash32): Hash32 {
  const [lo, hi] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [lo, hi]));
}

export interface MerkleTree {
  readonly root: Hash32;
  /** Leaves in tree order (sorted ascending). */
  readonly leaves: readonly Hash32[];
  proof(leaf: Hash32): Hash32[];
}

export function buildTree(input: readonly Hash32[]): MerkleTree {
  const leaves = [...new Set(input.map((leaf) => leaf.toLowerCase() as Hash32))].toSorted((a, b) =>
    BigInt(a) < BigInt(b) ? -1 : 1,
  );
  if (leaves.length !== input.length) throw new Error("duplicate leaves");
  const levels: Hash32[][] = [leaves];
  while ((levels.at(-1) as Hash32[]).length > 1) {
    const level = levels.at(-1) as Hash32[];
    const next: Hash32[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const right = level[i + 1];
      next.push(right === undefined ? (level[i] as Hash32) : hashPair(level[i] as Hash32, right));
    }
    levels.push(next);
  }
  const root = leaves.length === 0 ? ZERO_ROOT : ((levels.at(-1) as Hash32[])[0] as Hash32);
  return {
    root,
    leaves,
    proof(leaf: Hash32): Hash32[] {
      let index = leaves.indexOf(leaf.toLowerCase() as Hash32);
      if (index < 0) throw new Error("leaf not in tree");
      const proof: Hash32[] = [];
      for (const level of levels.slice(0, -1)) {
        const sibling = level[index ^ 1];
        // An odd last node has no sibling and is carried up unchanged: nothing to add to the proof.
        if (sibling !== undefined) proof.push(sibling);
        index = Math.floor(index / 2);
      }
      return proof;
    },
  };
}

/** OpenZeppelin `MerkleProof.verify(proof, root, leaf)` (processProof with commutative hashing). */
export function verifyProof(proof: readonly Hash32[], root: Hash32, leaf: Hash32): boolean {
  let computed = leaf;
  for (const sibling of proof) computed = hashPair(computed, sibling);
  return computed.toLowerCase() === root.toLowerCase();
}
