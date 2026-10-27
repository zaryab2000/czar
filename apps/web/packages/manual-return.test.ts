import { encodeRecordManualReturn } from "@czar/vault-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { manualReturnsFixture } from "#src/summary-fixtures";

const wallet = vi.hoisted(() => ({
  getStoredPasskey: vi.fn(),
  sendOwnerUserOperation: vi.fn(),
}));

vi.mock("#src/wallet", () => wallet);

import { submitManualReturn } from "#src/manual-return";

describe("submitManualReturn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wallet.getStoredPasskey.mockReturnValue({
      credentialId: "credential-id",
      publicKey: `0x${"11".repeat(64)}`,
    });
  });

  it("encodes the row amount and submits the UserOp to its vault", async () => {
    const item = manualReturnsFixture[0]!;

    await submitManualReturn(item);

    expect(wallet.sendOwnerUserOperation).toHaveBeenCalledWith(
      wallet.getStoredPasskey.mock.results[0]?.value,
      item.vault,
      encodeRecordManualReturn(item.pocket, BigInt(item.returnedAmount)),
    );
  });
});
