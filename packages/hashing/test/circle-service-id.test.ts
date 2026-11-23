import { describe, expect, it } from "vitest";
import { circleServiceId } from "@czar/hashing";
import { keccak256, toHex } from "viem";

describe("Circle registry service IDs", () => {
  it("hashes the exact network, method, and resource preimage", () => {
    const network = "eip155:5042002";
    const method = "POST";
    const resource = "https://example.com/pay";
    expect(circleServiceId(network, method, resource)).toBe(
      `svc_${keccak256(toHex(`circle|${network}|${method}|${resource}`)).slice(2, 34)}`,
    );
    expect(circleServiceId(network, "GET", resource)).not.toBe(
      circleServiceId(network, method, resource),
    );
  });
});
