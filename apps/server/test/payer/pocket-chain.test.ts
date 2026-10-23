import { describe, expect, it, vi } from "vitest";
import type { Address, PublicClient } from "viem";
import { czarVaultAbi } from "@czar/vault-client";
import { createPocketPreparationChain } from "#src/payer/pocket-chain";

const VAULT = "0x0000000000000000000000000000000000000001" as Address;
const USDC = "0x0000000000000000000000000000000000000002" as Address;
const GATEWAY = "0x0000000000000000000000000000000000000003" as Address;
const POCKET = "0x0000000000000000000000000000000000000004" as Address;

describe("PocketPreparationChain", () => {
  it("uses vault views, GatewayWallet authorization, and receipt-confirmed raw sends", async () => {
    const readContract = vi.fn(async (request: { functionName: string }) => {
      if (request.functionName === "getPocket")
        return { state: 2, gasGranted: 50_000n, funded: 900_000n };
      return true;
    });
    const sendRawTransaction = vi.fn(async () => `0x${"12".repeat(32)}` as const);
    const waitForTransactionReceipt = vi.fn(async () => ({ status: "success" as const }));
    const client = {
      readContract,
      sendRawTransaction,
      waitForTransactionReceipt,
    } as unknown as PublicClient;
    const chain = createPocketPreparationChain({
      client,
      vault: VAULT,
      usdc: USDC,
      gatewayWallet: GATEWAY,
    });

    await expect(chain.isRegistered(POCKET)).resolves.toBe(true);
    await expect(chain.pocketGasGranted(POCKET)).resolves.toBe(50_000n);
    await expect(chain.isFunded(POCKET)).resolves.toBe(true);
    await expect(chain.isDelegateReady({ pocket: POCKET, vault: VAULT })).resolves.toBe(true);
    await expect(
      chain.registerPocket({ envelopeId: 1n, pocket: POCKET, proof: [], transaction: "0xab" }),
    ).resolves.toBe(`0x${"12".repeat(32)}`);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: VAULT,
        abi: czarVaultAbi,
        functionName: "getPocket",
        args: [POCKET],
      }),
    );
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: GATEWAY,
        functionName: "isAuthorizedForBalance",
        args: [USDC, POCKET, VAULT],
      }),
    );
    expect(waitForTransactionReceipt).toHaveBeenCalledOnce();
  });
});
