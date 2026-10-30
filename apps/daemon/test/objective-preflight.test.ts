import { describe, expect, it } from "vitest";
import { KEYCHAIN_ACCOUNTS, type Keychain } from "#src/keychain";
import { objectivePreflight } from "#src/objective-preflight";

const argv = ["Find prices", "--subject", "Acme", "--field", "price"];
const taxonomy = { version: 1, tags: ["web-search", "page-extract"] };

function keychain(token: string | null): Keychain {
  return {
    get: (account) => (account === KEYCHAIN_ACCOUNTS.deviceToken ? token : null),
    set: () => undefined,
    delete: () => undefined,
  };
}

describe("manual objective preflight", () => {
  it("requires a paired device and names the pairing command", () => {
    expect(() => objectivePreflight(argv, keychain(null), taxonomy)).toThrow(/czar pair/);
  });

  it("accepts configured capabilities and keeps the token private", () => {
    const preflight = objectivePreflight(
      [...argv, "--capability", "page-extract"],
      keychain("opaque-token"),
      taxonomy,
    );
    expect(preflight.options.capabilities).toEqual(["page-extract"]);
    expect(preflight.token).toBe("opaque-token");
    expect(() =>
      objectivePreflight([...argv, "--capability", "other"], keychain("opaque-token"), taxonomy),
    ).toThrow(/configured capability/);
  });

  it("fails closed on malformed capability taxonomy", () => {
    expect(() => objectivePreflight(argv, keychain("opaque-token"), {})).toThrow(
      /capabilityTaxonomy/,
    );
  });
});
