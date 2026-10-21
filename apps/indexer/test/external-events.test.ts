import type { PocketRecord } from "@czar/schemas";
import { describe, expect, it } from "vitest";
import { isKnownTransfer, pocketDelegateState } from "#src/external-events";

const vault = "0x1111111111111111111111111111111111111111";
const pocket = "0x2222222222222222222222222222222222222222";
const merchant = "0x3333333333333333333333333333333333333333";

describe("external transfer filtering", () => {
  it("indexes transfers when either endpoint is a known Czar address", () => {
    const known = new Set([vault, pocket]);
    expect(isKnownTransfer(merchant, vault, known)).toBe(true);
    expect(isKnownTransfer(pocket, merchant, known)).toBe(true);
  });

  it("ignores transfers unrelated to Czar addresses", () => {
    expect(isKnownTransfer(merchant, "0x4444444444444444444444444444444444444444", new Set())).toBe(
      false,
    );
  });

  it("compares addresses case-insensitively", () => {
    expect(
      isKnownTransfer(merchant, vault.toUpperCase().replace("0X", "0x"), new Set([vault])),
    ).toBe(true);
  });
});

describe("Gateway delegate projection", () => {
  const record = {
    schemaVersion: "1.1",
    vault,
    envelopeId: 1,
    pocket,
    keyRef: "test",
    state: "Registered",
    funded: "0",
    gasGranted: "0",
    outstanding: "0",
    pendingPullback: "0",
    pullbacks: [],
  } satisfies PocketRecord;

  it("marks a registered pocket DelegateReady after Gateway DelegateAdded", () => {
    expect(pocketDelegateState(record, true)).toBe("DelegateReady");
  });

  it("restores Registered after delegate removal", () => {
    expect(pocketDelegateState({ ...record, state: "DelegateReady" }, false)).toBe("Registered");
  });

  it("preserves funded state when delegate changes", () => {
    expect(pocketDelegateState({ ...record, state: "Funded" }, false)).toBe("Funded");
  });
});
