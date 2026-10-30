import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { FINALIZE_CHUNK, MIN_RESERVATION_TTL_SECONDS } from "#src/payer/vault-direct";

describe("payer contract constants", () => {
  it("matches the vault authorization, finalize and reservation TTL limits", async () => {
    const source = await readFile(
      new URL("../../../../contracts/src/libraries/CzarConstants.sol", import.meta.url),
      "utf8",
    );
    const authorizationLimit = source.match(
      /uint256 constant MAX_AUTHORIZATIONS_PER_RESERVATION = (\d+);/,
    )?.[1];
    const finalizeChunk = source.match(/uint256 constant FINALIZE_CHUNK = (\d+);/)?.[1];
    const minReservationTtl = source.match(/uint256 constant MIN_RESERVATION_TTL = (\d+);/)?.[1];

    expect(Number(authorizationLimit)).toBe(128);
    expect(FINALIZE_CHUNK).toBe(32);
    expect(Number(finalizeChunk)).toBe(FINALIZE_CHUNK);
    expect(MIN_RESERVATION_TTL_SECONDS).toBe(30);
    expect(Number(minReservationTtl)).toBe(MIN_RESERVATION_TTL_SECONDS);
  });
});
