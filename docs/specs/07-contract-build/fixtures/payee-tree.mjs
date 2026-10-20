// Generates payee-tree.json: payeeRoot fixtures for 07-contract-build/01-shared-libraries.md §8.
// Rules: data-and-protocol.md §5.3 (czar-merkle-v1): double-hashed leaves, sorted leaves,
// commutative nodes, left-to-right pairing, an odd last node is carried up unchanged.
// Run from a folder with viem 2.57.2 installed: node payee-tree.mjs > payee-tree.json
import { keccak256, toHex, encodeAbiParameters, parseAbiParameters } from "viem";

const TAG = keccak256(toHex("czar.payee-leaf.v1"));
const leaf = (payee, kind, step, cap) =>
  keccak256(keccak256(encodeAbiParameters(parseAbiParameters("bytes32,address,uint8,uint32,uint256"), [TAG, payee, kind, step, cap])));
const node = (a, b) => {
  const [x, y] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return keccak256(encodeAbiParameters(parseAbiParameters("bytes32,bytes32"), [x, y]));
};

function build(rows) {
  const hs = rows.map((r) => leaf(...r));
  const sorted = [...hs].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  let level = sorted.map((h) => ({ h, members: [h] }));
  const proofs = Object.fromEntries(sorted.map((h) => [h, []]));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) { next.push(level[i]); continue; } // odd last node carried up
      const a = level[i], b = level[i + 1];
      for (const m of a.members) proofs[m].push(b.h);
      for (const m of b.members) proofs[m].push(a.h);
      next.push({ h: node(a.h, b.h), members: [...a.members, ...b.members] });
    }
    level = next;
  }
  return {
    root: level[0].h,
    leaves: rows.map((r, i) => ({ payee: r[0], kind: r[1], stepIndex: r[2], stepCap: r[3].toString(), leaf: hs[i], proof: proofs[hs[i]] })),
  };
}

const ROWS = [
  ["0x000000000000000000000000000000000000beef", 1, 0, 1000000n],
  ["0x000000000000000000000000000000000000cafe", 1, 0, 1000000n],
  ["0x000000000000000000000000000000000000d00d", 2, 1, 400000n],
  ["0x000000000000000000000000000000000000b0c0", 4, 4294967295, 0n],
];

console.log(JSON.stringify({ tag: TAG, fourLeaves: build(ROWS), threeLeaves: build(ROWS.slice(0, 3)) }, null, 2));
