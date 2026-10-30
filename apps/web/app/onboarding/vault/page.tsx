"use client";

import { useCallback, useEffect, useState } from "react";
import type { Me } from "@czar/schemas";
import { appApi } from "#src/app-api";
import { useAppData } from "#src/use-app-data";
import { ADD_NETWORK_FEES, canCreateVault, setUpVault } from "#src/vault-setup";

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
      await setUpVault({ msca: data.msca as `0x${string}`, vault: data.vault as `0x${string}` });
      setNotice("Vault setup submitted. Waiting for VaultCreated to sync…");
      refresh();
    } catch (cause) {
      if (isInsufficientGas(cause)) {
        setFundNetworkFees(true);
        setNotice(ADD_NETWORK_FEES);
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
  const hasNetworkFees = canCreateVault(data);
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
        <>
          <button
            className="primary-button"
            disabled={busy || !hasNetworkFees}
            onClick={createVault}
            type="button"
          >
            {busy ? "Sending…" : "Create vault"}
          </button>
          {!hasNetworkFees && <p role="status">{ADD_NETWORK_FEES}</p>}
        </>
      )}
      <p>Network fee reserve: {formatAmount(data.balances.mscaBalance)} USDC</p>
      <button disabled={busy} onClick={refresh} type="button">
        Check setup status
      </button>
      {notice && <p role="status">{notice}</p>}
      {(fundNetworkFees || (!data.vaultCreated && !hasNetworkFees)) && (
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

function formatAmount(value: Me["balances"]["mscaBalance"]): string {
  const amount = BigInt(value);
  return `${amount / 1_000_000n}.${(amount % 1_000_000n).toString().padStart(6, "0")}`;
}
