"use client";

import { useCallback, useEffect, useState } from "react";
import { appApi } from "#src/app-api";
import { useAppData } from "#src/use-app-data";
import { formatUsd } from "@czar/web/money-format";

const FAUCET_URL = "https://faucet.circle.com/";

export default function FundOnboardingPage() {
  const load = useCallback(() => appApi.getMe(), []);
  const { data, error, loading, refresh } = useAppData(load);
  const [copied, setCopied] = useState(false);
  const [copyingMsca, setCopyingMsca] = useState(false);
  const [fundMscaFirst, setFundMscaFirst] = useState(false);

  useEffect(() => {
    setFundMscaFirst(new URLSearchParams(window.location.search).get("fund-msca") === "1");
  }, []);

  async function copyAddress() {
    if (!data) return;
    await navigator.clipboard.writeText(data.vault);
    setCopied(true);
  }

  async function copyMscaAddress() {
    if (!data) return;
    await navigator.clipboard.writeText(data.msca);
    setCopyingMsca(true);
  }

  if (loading && !data) return <p role="status">Loading your vault…</p>;
  if (error && !data) return <p role="alert">{error}</p>;
  if (!data) return <p role="alert">Czar could not load your vault.</p>;
  return (
    <section className="welcome-card page-stack">
      <p className="eyebrow">Step 3 of 4</p>
      <h1 className="czar-title">Add money</h1>
      <p>Add USDC to your vault. On the test network, use the faucet link below.</p>
      <p>
        Vault balance: <strong>{formatUsd(data.balances.vaultBalance)}</strong>
      </p>
      <p className="address-value">{data.vault}</p>
      <button onClick={copyAddress} type="button">
        {copied ? "Address copied" : "Copy vault address"}
      </button>
      <a href={FAUCET_URL} rel="noreferrer" target="_blank">
        Open the test network faucet
      </a>
      {fundMscaFirst && (
        <section className="panel">
          <h2>Network fee reserve</h2>
          <p>Add a small amount to this MSCA address first, then add USDC to your vault.</p>
          <p className="address-value">{data.msca}</p>
          <button onClick={copyMscaAddress} type="button">
            {copyingMsca ? "MSCA address copied" : "Copy MSCA address"}
          </button>
        </section>
      )}
      <button onClick={refresh} type="button">
        Check balance
      </button>
      {BigInt(data.balances.vaultBalance) > 0n && (
        <a className="primary-link" href="/onboarding/limits">
          Continue to set limits
        </a>
      )}
    </section>
  );
}
