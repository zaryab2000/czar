import { describe, expect, it } from "vitest";
import { normalizeP256LowS } from "#src/wallet";

const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

describe("normalizeP256LowS", () => {
  it("maps high-s signatures to the equivalent low-s form", () => {
    const signature = toSignature(1n, P256_ORDER - 1n);

    expect(normalizeP256LowS(signature)).toBe(toSignature(1n, 1n));
  });

  it("keeps an already low-s signature unchanged", () => {
    const signature = toSignature(1n, P256_ORDER / 2n);

    expect(normalizeP256LowS(signature)).toBe(signature);
  });

  it.each(["0x12", `0x${"00".repeat(64)}`, toSignature(1n, P256_ORDER)])(
    "rejects malformed or out-of-range signatures: %s",
    (signature) => {
      expect(() => normalizeP256LowS(signature as `0x${string}`)).toThrow(
        "Passkey returned an invalid P-256 signature.",
      );
    },
  );
});

function toSignature(r: bigint, s: bigint): `0x${string}` {
  return `0x${r.toString(16).padStart(64, "0")}${s.toString(16).padStart(64, "0")}`;
}
