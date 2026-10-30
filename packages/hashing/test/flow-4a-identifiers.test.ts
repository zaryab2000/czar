import { describe, expect, it } from "vitest";
import { keccak256, stringToHex } from "viem";
import { dedupKey, obsId, serviceId } from "@czar/hashing";

const NETWORK = "eip155:5042002";
const PAYER = "0xAa00000000000000000000000000000000000001";
const PAY_TO = "0xBb00000000000000000000000000000000000002";
const ESCROW = "0xCc00000000000000000000000000000000000003";
const NONCE = `0x${"AB".repeat(32)}`;

describe("Flow 4A identifiers", () => {
  it.each([
    [
      "x402-exact",
      {
        schemaVersion: "1.0",
        rail: "x402-exact",
        network: NETWORK,
        asset: "0x3600000000000000000000000000000000000000",
        payer: PAYER,
        payTo: PAY_TO,
        amount: "1000",
        nonce: NONCE,
        validBefore: 1_800_000_000,
      },
      `x402-exact:${NETWORK}:${PAYER.toLowerCase()}:${PAY_TO.toLowerCase()}:${NONCE.toLowerCase()}`,
    ],
    [
      "gateway-batched",
      {
        schemaVersion: "1.0",
        rail: "gateway-batched",
        network: NETWORK,
        payer: PAYER,
        payTo: PAY_TO,
        amount: "1000",
        nonce: NONCE,
      },
      `gateway-batched:${NETWORK}:${PAYER.toLowerCase()}:${PAY_TO.toLowerCase()}:${NONCE.toLowerCase()}`,
    ],
    [
      "erc8183-job",
      {
        schemaVersion: "1.0",
        rail: "erc8183-job",
        network: NETWORK,
        contract: ESCROW,
        jobId: "0007",
        client: PAYER,
        provider: PAY_TO,
        evaluator: PAYER,
        budget: "1000",
      },
      `erc8183:${NETWORK}:${ESCROW.toLowerCase()}:7`,
    ],
  ] as const)("derives the %s dedup key and observation id", (_rail, ref, expectedKey) => {
    expect(dedupKey(ref)).toBe(expectedKey);
    expect(obsId(dedupKey(ref))).toBe(`obs_${keccak256(stringToHex(expectedKey)).slice(2, 34)}`);
  });

  it("derives the ERC-8183 provider service id independently", () => {
    const preimage = `${NETWORK}|${PAY_TO.toLowerCase()}|${ESCROW.toLowerCase()}`;
    expect(serviceId(NETWORK, PAY_TO, ESCROW)).toBe(
      `svc_${keccak256(stringToHex(preimage)).slice(2, 34)}`,
    );
  });
});
