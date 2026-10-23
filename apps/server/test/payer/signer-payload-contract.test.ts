import { describe, expect, it } from "vitest";
import { coerceArgs, parseRequest } from "@czar/signer";
import { czarVaultAbi } from "@czar/vault-client";
import { parseAbi } from "viem";

const VAULT = "0x0000000000000000000000000000000000000001";
const POCKET = "0x0000000000000000000000000000000000000002";
const PROVIDER = "0x0000000000000000000000000000000000000003";
const HASH = `0x${"ab".repeat(32)}`;
const MINTER_ABI = parseAbi(["function gatewayMint(bytes attestationPayload, bytes signature)"]);

const VAULT_CALLS = [
  ["registerPocket", { envelopeId: "1", pocket: POCKET, proof: [HASH] }],
  ["grantPocketGas", { pocket: POCKET, units: "50000" }],
  ["fundPocket", { pocket: POCKET, amount: "900000" }],
  ["writeOffPocket", { pocket: POCKET }],
  ["requestPullback", { pocket: POCKET, value: "100", maxFee: "10", maxBlockHeight: "4000" }],
  ["cancelPullback", { pullbackId: "9" }],
  ["confirmPullback", { pullbackId: "9" }],
  [
    "openJob",
    {
      envelopeId: "1",
      stepIndex: "2",
      provider: PROVIDER,
      stepCap: "300000",
      proof: [HASH],
      expiredAt: "1900000000",
      descriptionHash: HASH,
    },
  ],
  ["fundJob", { jobKey: HASH, expectedBudget: "100000" }],
  ["cancelJob", { jobKey: HASH }],
  ["syncJob", { jobKey: HASH }],
  ["claimJobRefund", { jobKey: HASH }],
] as const;

describe("server payer signer payload contract", () => {
  it.each(VAULT_CALLS)("encodes named ABI args for %s", (selector, args) => {
    const abiItem = czarVaultAbi.find((item) => item.type === "function" && item.name === selector);
    if (!abiItem || abiItem.type !== "function") throw new Error(`Missing ABI for ${selector}.`);
    const request = parseRequest("vault-call", { vault: VAULT, selector, args });

    expect(coerceArgs(abiItem.inputs, request["args"])).toHaveLength(abiItem.inputs.length);
  });

  it("includes the vault when cancelPullback is signed", () => {
    const request = parseRequest("vault-call", {
      vault: VAULT,
      selector: "cancelPullback",
      args: { pullbackId: "9" },
    });
    expect(request["vault"]).toBe(VAULT);
  });

  it("encodes GatewayMinter relayer args from a named record", () => {
    const request = parseRequest("relayer-tx", {
      to: PROVIDER,
      selector: "gatewayMint",
      args: { attestationPayload: "0x1234", signature: "0xabcd" },
    });
    const gatewayMint = MINTER_ABI[0];

    expect(coerceArgs(gatewayMint.inputs, request["args"])).toEqual(["0x1234", "0xabcd"]);
  });
});
