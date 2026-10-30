// Single-field storage edits on the local node, located from the compiler's storage layout (`arc-forge inspect`),
// so a predicate test can make exactly one on-chain fact false and then restore the original word byte for byte.
// The indexer sees no event for such an edit, so a denial proves the signer read the chain itself.
import { execFileSync } from "node:child_process";
import { encodeAbiParameters, keccak256, numberToHex, type Address, type Hex } from "viem";
import { CONTRACTS_DIR, type ArcNode } from "#test/local-chain/arc-node";

type LayoutEntry = { label: string; slot: string; offset: number; type: string };
type LayoutType = {
  numberOfBytes: string;
  members?: LayoutEntry[];
  key?: string;
  value?: string;
};
type Layout = { storage: LayoutEntry[]; types: Record<string, LayoutType> };
type KeyType = "address" | "uint64" | "bytes32";
export type PathStep = string | { readonly key: Address | Hex | bigint; readonly type: KeyType };

const layouts = new Map<string, Layout>();

function layoutOf(contract: string): Layout {
  const cached = layouts.get(contract);
  if (cached !== undefined) return cached;
  const output = execFileSync("arc-forge", ["inspect", contract, "storageLayout", "--json"], {
    cwd: CONTRACTS_DIR,
    encoding: "utf8",
    env: { ...process.env, FOUNDRY_PROFILE: "arc" },
  });
  const layout = JSON.parse(output) as Layout;
  layouts.set(contract, layout);
  return layout;
}

function typeOf(layout: Layout, id: string): LayoutType {
  const type = layout.types[id];
  if (type === undefined) throw new Error(`storage layout has no type ${id}`);
  return type;
}

/** Slot, byte offset and width of the field at `path` in `contract`'s storage. */
export function locate(
  contract: string,
  path: readonly PathStep[],
): { slot: bigint; offset: number; bytes: number } {
  const layout = layoutOf(contract);
  const [head, ...rest] = path;
  const root = layout.storage.find((entry) => entry.label === head);
  if (root === undefined) throw new Error(`${contract} has no storage variable ${String(head)}`);
  let slot = BigInt(root.slot);
  let offset = root.offset;
  let typeId = root.type;
  for (const step of rest) {
    const type = typeOf(layout, typeId);
    if (typeof step === "string") {
      const member = type.members?.find((candidate) => candidate.label === step);
      if (member === undefined) throw new Error(`${typeId} has no member ${step}`);
      slot += BigInt(member.slot);
      offset = member.offset;
      typeId = member.type;
    } else {
      if (type.value === undefined) throw new Error(`${typeId} is not a mapping`);
      slot = BigInt(
        keccak256(
          encodeAbiParameters(
            [{ type: step.type }, { type: "uint256" }],
            [step.key as never, slot],
          ),
        ),
      );
      offset = 0;
      typeId = type.value;
    }
  }
  return { slot, offset, bytes: Number(typeOf(layout, typeId).numberOfBytes) };
}

/** Writes `value` into one field and returns a function that restores the original 32-byte word. */
export async function setField(
  node: ArcNode,
  target: { readonly address: Address; readonly contract: string; readonly path: PathStep[] },
  value: bigint,
): Promise<() => Promise<void>> {
  const { slot, offset, bytes } = locate(target.contract, target.path);
  const index = numberToHex(slot, { size: 32 });
  const original =
    (await node.publicClient.getStorageAt({ address: target.address, slot: index })) ??
    numberToHex(0n, { size: 32 });
  const shift = BigInt(offset * 8);
  const mask = ((1n << BigInt(bytes * 8)) - 1n) << shift;
  const updated = (BigInt(original) & ~mask) | ((value << shift) & mask);
  await node.testClient.setStorageAt({
    address: target.address,
    index,
    value: numberToHex(updated, { size: 32 }),
  });
  return async () => {
    await node.testClient.setStorageAt({ address: target.address, index, value: original });
  };
}
