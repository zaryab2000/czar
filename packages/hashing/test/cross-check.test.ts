// The hand-built abi.encode struct hashes agree with viem's generic EIP-712 encoder for random inputs.
import { describe, expect, it } from "vitest";
import { hashTypedData, keccak256, toHex } from "viem";
import {
  DOMAINS,
  burnIntentDigest,
  slReceiptDigest,
  usdcTransferWithAuthorizationDigest,
  type Hash32,
} from "@czar/hashing";

const h = (s: string) => keccak256(toHex(s)) as Hash32;

describe("cross-check with viem.hashTypedData", () => {
  it("TransferWithAuthorization", () => {
    for (let i = 0; i < 20; i += 1) {
      const m = {
        from: `0x${h(`from${i}`).slice(26)}` as Hash32,
        to: `0x${h(`to${i}`).slice(26)}` as Hash32,
        value: BigInt(i) * 1_000_003n,
        validAfter: 0n,
        validBefore: 1_760_000_000n + BigInt(i),
        nonce: h(`n${i}`),
      };
      const viemDigest = hashTypedData({
        domain: DOMAINS.usdc(5042002),
        types: {
          TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "TransferWithAuthorization",
        message: m,
      });
      expect(usdcTransferWithAuthorizationDigest(5042002, m)).toBe(viemDigest);
    }
  });

  it("BurnIntent with non-empty hookData", () => {
    const spec = {
      version: 1,
      sourceDomain: 26,
      destinationDomain: 26,
      sourceContract: h("a"),
      destinationContract: h("b"),
      sourceToken: h("c"),
      destinationToken: h("d"),
      sourceDepositor: h("e"),
      destinationRecipient: h("f"),
      sourceSigner: h("g"),
      destinationCaller: h("i"),
      value: 7n,
      salt: h("j"),
      hookData: "0xdeadbeef" as const,
    };
    const fields = [
      ["version", "uint32"],
      ["sourceDomain", "uint32"],
      ["destinationDomain", "uint32"],
      ["sourceContract", "bytes32"],
      ["destinationContract", "bytes32"],
      ["sourceToken", "bytes32"],
      ["destinationToken", "bytes32"],
      ["sourceDepositor", "bytes32"],
      ["destinationRecipient", "bytes32"],
      ["sourceSigner", "bytes32"],
      ["destinationCaller", "bytes32"],
      ["value", "uint256"],
      ["salt", "bytes32"],
      ["hookData", "bytes"],
    ].map(([name, type]) => ({ name: name as string, type: type as string }));
    const viemDigest = hashTypedData({
      domain: DOMAINS.gatewayWallet(),
      // viem cannot infer field types from a runtime array; the digest is what is compared.
      types: {
        TransferSpec: fields,
        BurnIntent: [
          { name: "maxBlockHeight", type: "uint256" },
          { name: "maxFee", type: "uint256" },
          { name: "spec", type: "TransferSpec" },
        ],
      },
      primaryType: "BurnIntent",
      message: { maxBlockHeight: 9n, maxFee: 3n, spec } as never,
    });
    expect(burnIntentDigest({ maxBlockHeight: 9n, maxFee: 3n, spec })).toBe(viemDigest);
  });

  it("Receipt with a unicode origin", () => {
    const r = {
      paymentRefHash: h("p"),
      requestCommit: h("q"),
      responseCommit: h("r"),
      statusCode: 502,
      originAsserted: "https://händler.example",
      requirementsHashSeen: h("s"),
      tRequest: 1n,
      tPaymentSigned: 2n,
      tComplete: 3n,
      outcome: 1,
      localChecksCommit: h("t"),
      disclosure: 0,
      createdAt: 4n,
    };
    const types = {
      Receipt: [
        ["paymentRefHash", "bytes32"],
        ["requestCommit", "bytes32"],
        ["responseCommit", "bytes32"],
        ["statusCode", "uint16"],
        ["originAsserted", "string"],
        ["requirementsHashSeen", "bytes32"],
        ["tRequest", "uint64"],
        ["tPaymentSigned", "uint64"],
        ["tComplete", "uint64"],
        ["outcome", "uint8"],
        ["localChecksCommit", "bytes32"],
        ["disclosure", "uint8"],
        ["createdAt", "uint64"],
      ].map(([name, type]) => ({ name: name as string, type: type as string })),
    };
    expect(slReceiptDigest(5042002, r)).toBe(
      hashTypedData({
        domain: DOMAINS.selectionLayer(5042002),
        types,
        primaryType: "Receipt",
        message: r,
      }),
    );
  });
});
