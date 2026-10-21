import { describe, expect, it } from "vitest";
import { bearerToken, ulid } from "#src/http/ids";

describe("server identifiers", () => {
  it("ulid_hasPrefixLengthAlphabetAndTimestampBoundary", () => {
    const random = { bytes: (length: number) => Buffer.alloc(length) };
    const id = ulid("obj_", new Date(2 ** 48 - 1), random);
    expect(id).toMatch(/^obj_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(id.slice(4, 14)).toBe("7ZZZZZZZZZ");
    expect(() => ulid("obj_", new Date(2 ** 48), random)).toThrow(RangeError);
  });

  it("ulid_changesWithInjectedRandomness_andTokenIsBase64url", () => {
    let value = 0;
    const random = {
      bytes: (length: number) => Buffer.alloc(length, value++),
    };
    const first = ulid("dev_", new Date(1_800_000_000_000), random);
    const second = ulid("dev_", new Date(1_800_000_000_000), random);
    const token = bearerToken(random);
    expect(first).not.toBe(second);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
