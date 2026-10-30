// PR #122 P2 / SCR-150 §3: the CLEAN-mode GatewayMinter double must emit the exact `AttestationUsed` event the
// indexer registers for Circle's GatewayMinter, or the indexer never marks a local pullback attested.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getAbiItem, toEventSelector } from "viem";
import { gatewayMinterEvents } from "#src/external-abis";

const MOCK_MINTER_SOURCE = new URL(
  "../../../contracts/test/mocks/MockGatewayMinter.sol",
  import.meta.url,
);

type EventParam = { readonly type: string; readonly indexed: boolean };

/** Reads `event AttestationUsed(...)` from the Solidity double: parameter types and indexed flags, in order. */
function mockEventParams(): EventParam[] {
  const source = readFileSync(MOCK_MINTER_SOURCE, "utf8");
  const match = /event\s+AttestationUsed\s*\(([^)]*)\)\s*;/.exec(source);
  if (!match?.[1])
    throw new Error("AttestationUsed declaration not found in MockGatewayMinter.sol");
  return match[1]
    .split(",")
    .map((part) => part.trim().split(/\s+/))
    .map((words) => ({ type: words[0] ?? "", indexed: words.includes("indexed") }));
}

describe("CLEAN-mode GatewayMinter double vs the indexer ABI", () => {
  const registered = getAbiItem({ abi: gatewayMinterEvents, name: "AttestationUsed" });

  it("declares the same parameter types and indexed flags as the registered Circle event", () => {
    expect(mockEventParams()).toEqual(
      registered.inputs.map((input) => ({
        type: input.type,
        indexed: "indexed" in input && input.indexed === true,
      })),
    );
  });

  it("has the same topic0, so the indexer's AttestationUsed handler observes the double's mints", () => {
    const signature = `AttestationUsed(${mockEventParams()
      .map((param) => param.type)
      .join(",")})`;
    expect(toEventSelector(signature)).toBe(toEventSelector(registered));
  });
});
