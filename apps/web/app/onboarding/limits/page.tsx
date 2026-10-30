"use client";

import { useCallback, useEffect, useState } from "react";
import type { Me } from "@czar/schemas";
import { appApi } from "#src/app-api";
import { submitCategoryLimits } from "#src/category-limits";
import { useAppData } from "#src/use-app-data";
import { formatUsd } from "@czar/web/money-format";

const CATEGORIES = ["research", "data", "creative", "general"] as const;

export default function LimitsOnboardingPage() {
  const load = useCallback(() => appApi.getMe(), []);
  const { data, error, loading, refresh } = useAppData(load);
  const [limits, setLimits] = useState<Record<string, { userMax: string; autoLimit: string }>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    if (!data?.vaultCreated || data.limits.length === 4) return;
    let timer: number | undefined;
    let active = true;
    void appApi.listPendingApprovals().then(({ pollSeconds }) => {
      if (active) timer = window.setInterval(refresh, pollSeconds * 1000);
    });
    return () => {
      active = false;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [data?.limits.length, data?.vaultCreated, refresh]);

  async function saveLimits() {
    if (!data?.vaultCreated) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const entries = CATEGORIES.map((category) => {
        const existing = data.limits.find((limit) => limit.category === category);
        const values = limits[category] ?? {
          userMax: existing ? unitsToInput(existing.userMax) : "0",
          autoLimit: existing ? unitsToInput(existing.autoLimit) : "0",
        };
        return {
          category,
          userMax: parseUsd(values.userMax),
          autoLimit: parseUsd(values.autoLimit),
        };
      });
      await submitCategoryLimits(data.vault as `0x${string}`, entries);
      setNotice("Limits submitted. Waiting for LimitsSet to sync…");
      refresh();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Czar could not save your limits.");
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) return <p role="status">Loading your account…</p>;
  if (error && !data) return <p role="alert">{error}</p>;
  if (!data) return <p role="alert">Czar could not load your account.</p>;
  if (!data.vaultCreated)
    return <p role="alert">Create your vault before setting spending limits.</p>;
  return (
    <section className="welcome-card page-stack">
      <p className="eyebrow">Step 4 of 4</p>
      <h1 className="czar-title">Set limits</h1>
      <p>How much may Czar spend per week without asking? You can change this any time.</p>
      <p>Network fee reserve: {formatUsd(data.balances.mscaBalance)}</p>
      {CATEGORIES.map((category) => (
        <LimitFields
          key={category}
          category={category}
          current={data.limits.find((limit) => limit.category === category)}
          values={
            limits[category] ?? {
              userMax: currentAmount(data, category, "userMax"),
              autoLimit: currentAmount(data, category, "autoLimit"),
            }
          }
          onChange={(next) => setLimits((previous) => ({ ...previous, [category]: next }))}
        />
      ))}
      <button className="primary-button" disabled={busy} onClick={saveLimits} type="button">
        {busy ? "Sending…" : "Save weekly limits"}
      </button>
      <button disabled={busy} onClick={refresh} type="button">
        Check limits status
      </button>
      {notice && <p role="status">{notice}</p>}
      <a href="/home">Finish setup</a>
    </section>
  );
}

function LimitFields({
  category,
  current,
  values,
  onChange,
}: {
  readonly category: string;
  readonly current: Me["limits"][number] | undefined;
  readonly values: { userMax: string; autoLimit: string };
  readonly onChange: (next: { userMax: string; autoLimit: string }) => void;
}) {
  return (
    <fieldset className="panel page-stack">
      <legend>{category}</legend>
      {current && (
        <p>
          Current: {formatUsd(current.autoLimit)} automatic / {formatUsd(current.userMax)} maximum
        </p>
      )}
      <label>
        Weekly maximum in USD
        <input
          inputMode="decimal"
          value={values.userMax}
          onChange={(event) => onChange({ ...values, userMax: event.target.value })}
        />
      </label>
      <label>
        Weekly automatic limit in USD
        <input
          inputMode="decimal"
          value={values.autoLimit}
          onChange={(event) => onChange({ ...values, autoLimit: event.target.value })}
        />
      </label>
    </fieldset>
  );
}

function parseUsd(value: string): bigint {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!match) throw new Error("Enter an amount in USD with up to six decimal places.");
  return BigInt(match[1] ?? "0") * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0") || "0");
}

function currentAmount(me: Me, category: string, key: "userMax" | "autoLimit"): string {
  const limit = me.limits.find((item) => item.category === category);
  return limit ? unitsToInput(limit[key]) : "0";
}

function unitsToInput(value: string): string {
  const amount = BigInt(value);
  const decimals = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return decimals ? `${amount / 1_000_000n}.${decimals}` : (amount / 1_000_000n).toString();
}
