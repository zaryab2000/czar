import { keccak256 } from "viem";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** SCR-163 identity for one live payee, registered resource, and validated Bazaar schema. */
export function serviceVersionId(input: {
  readonly payTo: string;
  readonly resource: { readonly url: string; readonly method: "GET" | "POST" };
  readonly schema: Readonly<Record<string, unknown>> | null;
}): string {
  if (!/^0x[0-9a-f]{40}$/i.test(input.payTo))
    throw new TypeError("Service version payTo must be a 20-byte address.");
  const schemaHash =
    input.schema === null ? null : keccak256(new TextEncoder().encode(versionJcs(input.schema)));
  const preimage = {
    payTo: input.payTo.toLowerCase(),
    resource: input.resource,
    schemaHash,
  };
  return `ver_${keccak256(new TextEncoder().encode(versionJcs(preimage))).slice(2, 34)}`;
}

function versionJcs(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string")
    return JSON.stringify(ADDRESS.test(value) ? value.toLowerCase() : value);
  if (typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(versionJcs).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).toSorted(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${versionJcs(item)}`).join(",")}}`;
  }
  throw new TypeError("Service version input must contain only JSON values.");
}
