"use client";

import { sha256, stringToBytes, zeroAddress, type Hex } from "viem";
import {
  encodeCreateVault,
  encodeSetPasskey,
  isVaultExistsError,
  readVaultOf,
  readVaultPasskey,
} from "@czar/vault-client";
import type { Me } from "@czar/schemas";
import { getAppWalletConfig } from "#src/app-api";
import { getStoredPasskey, sendOwnerUserOperation, walletPublicClient } from "#src/wallet";

/** The notice shown while the MSCA cannot pay network fees (SCR-157 §3). */
export const ADD_NETWORK_FEES = "Add a small amount to your MSCA for network fees, then try again.";

/** "Create vault" needs some USDC on the MSCA for the UserOp's network fee. */
export function canCreateVault(me: { readonly balances: Pick<Me["balances"], "mscaBalance"> }) {
  return me.balances.mscaBalance !== "0";
}

/**
 * Creates the owner's vault and sets its passkey, skipping each step the chain already has
 * (SCR-157 §3, FAC-1). Each operation is included before the next is sent (SCR-159 §4). The
 * factory and RP ID come from the server's wallet-config.
 */
export async function setUpVault(me: {
  readonly msca: `0x${string}`;
  readonly vault: `0x${string}`;
}): Promise<void> {
  const { vaultFactory, webauthnRpId } = await getAppWalletConfig();
  const client = await walletPublicClient();
  const passkey = getStoredPasskey();
  const key = passkeyCoordinates(passkey.publicKey);
  const rpIdHash = sha256(stringToBytes(webauthnRpId));
  const existing = await readVaultOf({ client, factory: vaultFactory, ownerAccount: me.msca });
  let created = false;
  if (existing === zeroAddress) {
    try {
      // setPasskey shares the EntryPoint nonce until createVault is included (SCR-159 §4).
      await sendOwnerUserOperation(passkey, vaultFactory, encodeCreateVault(me.msca), {
        waitForInclusion: true,
      });
      created = true;
    } catch (cause) {
      if (!isVaultExistsError(cause)) throw cause;
    }
  }
  const vault = existing === zeroAddress ? me.vault : existing;
  // A vault this call just created has no passkey yet, so it is not read.
  if (!created) {
    const current = await readVaultPasskey({ client, vault });
    if (current.set && sameKey(current, { ...key, rpIdHash })) return;
  }
  await sendOwnerUserOperation(passkey, vault, encodeSetPasskey(key.qx, key.qy, rpIdHash), {
    waitForInclusion: true,
  });
}

function sameKey(
  left: { readonly qx: Hex; readonly qy: Hex; readonly rpIdHash: Hex },
  right: { readonly qx: Hex; readonly qy: Hex; readonly rpIdHash: Hex },
): boolean {
  return (
    left.qx.toLowerCase() === right.qx.toLowerCase() &&
    left.qy.toLowerCase() === right.qy.toLowerCase() &&
    left.rpIdHash.toLowerCase() === right.rpIdHash.toLowerCase()
  );
}

function passkeyCoordinates(publicKey: `0x${string}`): {
  readonly qx: `0x${string}`;
  readonly qy: `0x${string}`;
} {
  if (!/^0x04[\da-fA-F]{128}$/.test(publicKey)) {
    throw new Error("The saved passkey key is invalid. Create your passkey again.");
  }
  return {
    qx: `0x${publicKey.slice(4, 68)}`,
    qy: `0x${publicKey.slice(68)}`,
  };
}
