import {
  BaseError,
  createPublicClient,
  custom,
  encodeAbiParameters,
  encodeErrorResult,
} from "viem";
import { describe, expect, it } from "vitest";
import { czarVaultAbi, decodeViemError, getLimits } from "@czar/vault-client";

const VAULT = "0x0000000000000000000000000000000000000001" as const;
const CATEGORY = `0x${"11".repeat(32)}` as const;
const CHAIN = {
  id: 5042002,
  name: "Arc local",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
} as const;

function clientWithResponse(response: `0x${string}`) {
  return createPublicClient({
    chain: CHAIN,
    transport: custom({ request: async () => response }),
  });
}

describe("getLimits", () => {
  it("decodes the CategoryLimits tuple from the vault ABI", async () => {
    const expected = {
      userMax: 1_000n,
      autoLimit: 600n,
      usedInPeriod: 125n,
      periodId: 4n,
      lastRaiseAt: 99n,
    };
    const functionAbi = czarVaultAbi.find(
      (item) => item.type === "function" && item.name === "getLimits",
    );
    if (!functionAbi) throw new Error("ICzarVault ABI is missing getLimits");
    const response = encodeAbiParameters(functionAbi.outputs, [expected]);
    const client = clientWithResponse(response);

    await expect(getLimits({ client, vault: VAULT, categoryId: CATEGORY })).resolves.toEqual(
      expected,
    );
  });

  it("preserves contract reverts for T-026 named-error decoding", async () => {
    const notAuthorized = czarVaultAbi.find(
      (item) => item.type === "error" && item.name === "NotAuthorized",
    );
    if (!notAuthorized) throw new Error("ICzarVault ABI is missing NotAuthorized");
    const revertData = encodeErrorResult({
      abi: [notAuthorized],
      errorName: "NotAuthorized",
      args: [],
    });
    const client = createPublicClient({
      chain: CHAIN,
      transport: custom({
        request: async () => {
          const cause = Object.assign(new Error("execution reverted"), { data: revertData });
          throw new BaseError("execution reverted", { cause });
        },
      }),
    });

    const error = await getLimits({ client, vault: VAULT, categoryId: CATEGORY }).catch(
      (caught: unknown) => caught,
    );

    expect(decodeViemError(error)).toMatchObject({ kind: "custom", name: "NotAuthorized" });
  });
});
