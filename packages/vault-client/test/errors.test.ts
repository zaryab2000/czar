// T-026 (07 PRD 14 §7): every custom error of the vault and the factory decodes by name.
import { encodeErrorResult, zeroAddress, type AbiParameter } from "viem";
import { describe, expect, it } from "vitest";
import { czarVaultAbi, czarVaultFactoryAbi, decodeRevert, errorNames } from "@czar/vault-client";

const VAULT_ERRORS = 55;
const FACTORY_ERRORS = 6;

/** A value of the right type for any error argument. */
function sample(p: AbiParameter): unknown {
  if (p.type === "address") return zeroAddress;
  if (p.type === "bool") return true;
  if (p.type === "string") return "x";
  if (p.type.startsWith("bytes") && p.type !== "bytes")
    return `0x${"00".repeat(Number(p.type.slice(5)))}`;
  if (p.type === "bytes") return "0x";
  if (p.type.startsWith("uint") || p.type.startsWith("int")) return 1n;
  throw new Error(`no sample for ${p.type}`);
}

describe("decodeRevert", () => {
  const errors = [...czarVaultAbi, ...czarVaultFactoryAbi].filter((i) => i.type === "error");

  it("knows 55 vault errors and 6 factory errors", () => {
    expect(czarVaultAbi.filter((i) => i.type === "error")).toHaveLength(VAULT_ERRORS);
    expect(czarVaultFactoryAbi.filter((i) => i.type === "error")).toHaveLength(FACTORY_ERRORS);
    expect(errorNames()).toHaveLength(VAULT_ERRORS + FACTORY_ERRORS);
  });

  for (const e of errors) {
    it(`decodes ${e.name}`, () => {
      const args = e.inputs.map(sample);
      const data = encodeErrorResult({ abi: [e], errorName: e.name, args } as never);
      const d = decodeRevert(data);
      expect(d.kind).toBe("custom");
      expect(d.name).toBe(e.name);
    });
  }

  it("decodes Error(string), Panic, empty and unknown data", () => {
    expect(
      decodeRevert(
        encodeErrorResult({
          abi: [{ type: "error", name: "Error", inputs: [{ type: "string" }] }],
          errorName: "Error",
          args: ["boom"],
        }),
      ),
    ).toEqual({ kind: "string", name: "Error", message: "boom" });
    expect(
      decodeRevert(
        encodeErrorResult({
          abi: [{ type: "error", name: "Panic", inputs: [{ type: "uint256" }] }],
          errorName: "Panic",
          args: [0x11n],
        }),
      ),
    ).toEqual({ kind: "panic", name: "Panic", code: 0x11n });
    expect(decodeRevert("0x")).toEqual({ kind: "empty", name: "EmptyRevert" });
    expect(decodeRevert("0xdeadbeef").name).toBe("Unknown");
  });
});
