// RFC 8785 JSON Canonicalization Scheme with Czar's normalization (02 §5.1), and H(x) = keccak256(jcs(x)).
import { keccak256, toBytes } from "viem";
import type { Hash32 } from "./eip712.ts";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

/**
 * Czar normalization before canonicalizing: addresses lowercase; absent optional fields omitted (an
 * `undefined` property is dropped); `null` is refused, because Czar objects never carry it.
 */
function serialize(value: unknown, path: string): string {
  if (value === null)
    throw new CanonicalizationError(`null at ${path}: omit absent fields instead`);
  switch (typeof value) {
    case "string":
      // JSON.stringify escapes exactly as RFC 8785 §3.2.2.2 requires.
      return JSON.stringify(ADDRESS.test(value) ? value.toLowerCase() : value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalizationError(`non-finite number at ${path}`);
      // ECMAScript Number-to-String is the RFC 8785 §3.2.2.3 serialization; -0 becomes 0.
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "bigint":
      throw new CanonicalizationError(`bigint at ${path}: amounts are Amount6 strings`);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value
          .map((item, i) => {
            if (item === undefined)
              throw new CanonicalizationError(`undefined array item at ${path}[${i}]`);
            return serialize(item, `${path}[${i}]`);
          })
          .join(",")}]`;
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        // Default sort compares UTF-16 code units, as RFC 8785 §3.2.3 requires.
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${serialize(v, `${path}.${k}`)}`).join(",")}}`;
    }
    default:
      throw new CanonicalizationError(`unsupported ${typeof value} at ${path}`);
  }
}

export const jcsString = (value: unknown): string => serialize(value, "$");

/** `jcs(x)` as UTF-8 bytes. */
export const jcs = (value: unknown): Uint8Array => toBytes(jcsString(value));

/** `H(x) = keccak256(jcs(x))`, 32 bytes, lowercase hex with `0x`. */
export const H = (value: unknown): Hash32 => keccak256(jcs(value));
