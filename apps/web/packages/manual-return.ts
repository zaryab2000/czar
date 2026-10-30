import type { ManualReturn } from "@czar/schemas";
import { encodeRecordManualReturn } from "@czar/vault-client";
import { getStoredPasskey, sendOwnerUserOperation } from "#src/wallet";

export async function submitManualReturn(item: ManualReturn): Promise<void> {
  await sendOwnerUserOperation(
    getStoredPasskey(),
    item.vault,
    encodeRecordManualReturn(item.pocket, BigInt(item.returnedAmount)),
    { waitForInclusion: true },
  );
}
