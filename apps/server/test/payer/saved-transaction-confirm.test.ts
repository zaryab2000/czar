import { describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { savedTransactionState } from "#src/payer/saved-transaction";

const KEY = privateKeyToAccount(generatePrivateKey());

async function signed(nonce: number): Promise<`0x${string}`> {
  return KEY.signTransaction({
    type: "eip1559",
    chainId: 5042002,
    nonce,
    gas: 21_000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    to: KEY.address,
  });
}

describe("savedTransactionState confirms replaced on a second read (review M3)", () => {
  it("returns mined when the receipt appears on the confirming read", async () => {
    const statuses: Array<"success" | undefined> = [undefined, "success"];
    const chain = {
      transactionCount: vi.fn(async () => 5),
      transactionStatus: vi.fn(async () => statuses.shift()),
    };
    const confirm = vi.fn(async () => {});

    await expect(savedTransactionState(chain, await signed(4), confirm)).resolves.toBe("mined");
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("returns replaced only when the confirming read still shows no receipt", async () => {
    const chain = {
      transactionCount: vi.fn(async () => 5),
      transactionStatus: vi.fn(async () => undefined),
    };
    const confirm = vi.fn(async () => {});

    await expect(savedTransactionState(chain, await signed(4), confirm)).resolves.toBe("replaced");
    expect(chain.transactionStatus).toHaveBeenCalledTimes(2);
  });

  it("does not wait when the transaction is still pending", async () => {
    const chain = {
      transactionCount: vi.fn(async () => 4),
      transactionStatus: vi.fn(async () => undefined),
    };
    const confirm = vi.fn(async () => {});

    await expect(savedTransactionState(chain, await signed(4), confirm)).resolves.toBe("pending");
    expect(confirm).not.toHaveBeenCalled();
  });
});
