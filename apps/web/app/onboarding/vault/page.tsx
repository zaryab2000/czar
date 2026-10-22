"use client";

import { useCallback, useEffect, useState } from "react";
import { encodeCreateVault, encodeSetPasskey } from "@czar/vault-client";
import type { Me } from "@czar/schemas";
import { appApi } from "#src/app-api";
import { useAppData } from "#src/use-app-data";
import { getStoredPasskey, sendOwnerUserOperation } from "#src/wallet";

const FACTORY =
  process.env["NEXT_PUBLIC_CZAR_VAULT_FACTORY_ADDRESS"] ??
  "0xA624047E961D13bF49711e1383e7A3EBD3E25ef4";

export default function VaultOnboardingPage() {
  const load = useCallback(() => appApi.getMe(), []);
  const { data, error, loading, refresh } = useAppData(load);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [fundNetworkFees, setFundNetworkFees] = useState(false);

  useEffect(() => {
    if (data?.vaultCreated) return;
    let timer: number | undefined;
    let active = true;
    void appApi.listPendingApprovals().then(({ pollSeconds }) => {
      if (active) timer = window.setInterval(refresh, pollSeconds * 1000);
    });
    return () => {
      active = false;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [data?.vaultCreated, refresh]);

  async function createVault() {
    if (!data) return;
    setBusy(true);
    setNotice(undefined);
    try {
      if (!FACTORY) throw new Error("The Czar vault factory is not configured for this network.");
      const passkey = getStoredPasskey();
      try {
        await sendOwnerUserOperation(
          passkey,
          FACTORY as `0x${string}`,
          encodeCreateVault(data.msca as `0x${string}`),
        );
      } catch (cause) {
        if (!errorHasMessage(cause, "VaultExists")) throw cause;
      }
      const key = passkeyCoordinates(passkey.publicKey);
      const rpIdHash = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode("localhost")),
      );
      const rpIdHashHex =
        `0x${Array.from(rpIdHash, (byte) => byte.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
      await sendOwnerUserOperation(
        passkey,
        data.vault as `0x${string}`,
        encodeSetPasskey(key.qx, key.qy, rpIdHashHex),
      );
      setNotice("Vault setup submitted. Waiting for VaultCreated to sync…");
      refresh();
    } catch (cause) {
      if (isInsufficientGas(cause)) {
        setFundNetworkFees(true);
        setNotice("Add a small amount to your MSCA for network fees, then try again.");
      } else {
        setNotice(cause instanceof Error ? cause.message : "Czar could not create your vault.");
      }
      refresh();
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) return <p role="status">Loading your account…</p>;
  if (error && !data) return <p role="alert">{error}</p>;
  if (!data) return <p role="alert">Czar could not load your account.</p>;
  return (
    <section className="welcome-card page-stack">
      <p className="eyebrow">Step 2 of 4</p>
      <h1 className="czar-title">Create your vault</h1>
      <p>Setting up your vault on Arc. This takes a few seconds.</p>
      {data.vaultCreated ? (
        <>
          <p role="status">Your vault is ready.</p>
          <a className="primary-link" href="/onboarding/fund">
            Continue to add money
          </a>
        </>
      ) : (
        <button className="primary-button" disabled={busy} onClick={createVault} type="button">
          {busy ? "Sending…" : "Create vault"}
        </button>
      )}
      <p>Network fee reserve: {formatAmount(data.balances.mscaBalance)} USDC</p>
      <button disabled={busy} onClick={refresh} type="button">
        Check setup status
      </button>
      {notice && <p role="status">{notice}</p>}
      {fundNetworkFees && (
        <a className="primary-link" href="/onboarding/fund?fund-msca=1">
          Add money for network fees
        </a>
      )}
    </section>
  );
}

function errorHasMessage(cause: unknown, fragment: string): boolean {
  let current: unknown = cause;
  while (current instanceof Error) {
    if (current.message.includes(fragment)) return true;
    current = current.cause;
  }
  return false;
}

function isInsufficientGas(cause: unknown): boolean {
  return ["AA21", "insufficient funds", "prefund"].some((fragment) =>
    errorHasMessage(cause, fragment),
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

function formatAmount(value: Me["balances"]["mscaBalance"]): string {
  const amount = BigInt(value);
  return `${amount / 1_000_000n}.${(amount % 1_000_000n).toString().padStart(6, "0")}`;
}
