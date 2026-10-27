// T-026 (07 PRD 14 §6): src/abi.ts is the ABI of the compiled interfaces, which equal the spec copies (00-conventions
// §2.3). Fails when an interface changed and `pnpm gen-abi` was not run. Needs `arc-forge build` in contracts/.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { czarVaultAbi, czarVaultFactoryAbi } from "@czar/vault-client";

const compiled = (name: string): unknown =>
  (
    JSON.parse(
      readFileSync(
        new URL(`../../../contracts/out/${name}.sol/${name}.json`, import.meta.url),
        "utf8",
      ),
    ) as { abi: unknown }
  ).abi;

describe("generated ABI", () => {
  it("equals the compiled ICzarVault and ICzarVaultFactory", () => {
    expect(czarVaultAbi).toEqual(compiled("ICzarVault"));
    expect(czarVaultFactoryAbi).toEqual(compiled("ICzarVaultFactory"));
  });
});
