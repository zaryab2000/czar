"use client";

import { useCallback, useState } from "react";
import type { LedgerReceipt, Me } from "@czar/schemas";
import { appApi } from "#src/app-api";
import { ACCOUNT_REFRESH_EVENT } from "#src/app-shell";
import { receiptStatusText } from "#src/receipt-status";
import { useAppData } from "#src/use-app-data";
import { getStoredPasskey, sendOwnerUserOperation } from "#src/wallet";
import { formatUsd } from "@czar/web/money-format";
import { shadowTotalsFixture } from "#src/summary-fixtures";

export default function HomePage() {
  const load = useCallback(async () => {
    const [me, approvals, receipts] = await Promise.all([
      appApi.getMe(),
      appApi.listApprovals(),
      appApi.listReceipts(),
    ]);
    return { me, approvals, receipts };
  }, []);
  const { data, error, loading, refresh } = useAppData(load);

  if (loading && !data) return <p role="status">Loading your Czar account…</p>;
  if (error && !data) return <DataError message={error} refresh={refresh} />;
  if (!data) return <DataError message="Czar could not load current data." refresh={refresh} />;

  return (
    <div className="page-stack">
      <h1 className="czar-title">Your Czar account</h1>
      {error && <DataError message={error} refresh={refresh} />}
      {error && <p className="notice">Offline — balances may be stale.</p>}
      <BalanceGrid me={data.me} />
      {data.me.mode === "shadow" && <ShadowSummaryCard />}
      <OwnerControls me={data.me} refresh={refresh} />
      <section className="panel">
        <h2>Weekly limits</h2>
        {data.me.limits.length === 0 ? (
          <p>No spending limits are set yet.</p>
        ) : (
          <ul className="rows">
            {data.me.limits.map((limit) => (
              <li key={limit.category}>
                <span>
                  {limit.category}: up to {formatUsd(limit.autoLimit)} per week without asking, max{" "}
                  {formatUsd(limit.userMax)}
                </span>
                <span>Used {formatUsd(limit.usedThisPeriod)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="panel">
        <h2>Approvals waiting for you</h2>
        <p>Czar needs your approval for these. Nothing is spent until you approve.</p>
        {data.approvals.items.length === 0 ? (
          <p>No pending approvals.</p>
        ) : (
          <ul className="rows">
            {data.approvals.items.map((item) => (
              <li key={item.planId}>
                {item.status === "submitted" ? (
                  <span>{item.goal}</span>
                ) : (
                  <a href={`/approve/${encodeURIComponent(item.planId)}`}>{item.goal}</a>
                )}
                <span>{item.capDisplay}</span>
                {item.status === "submitted" && (
                  <span>Approval sent. Waiting for the network to confirm it.</span>
                )}
              </li>
            ))}
          </ul>
        )}
        <a href="/approvals">View approvals</a>
      </section>
      <section className="panel">
        <h2>Recent activity</h2>
        <ReceiptList items={data.receipts.items.slice(0, 5)} />
        <a href="/receipts">View receipts</a>
      </section>
    </div>
  );
}

function ShadowSummaryCard() {
  const totals = shadowTotalsFixture;
  return (
    <section className="panel">
      <h2>Shadow summary</h2>
      <p>Sample summary preview</p>
      <p>Work observed: {totals.minutesObserved} minutes</p>
      <p>Plans priced: {totals.objectivesPriced}</p>
      <p>Estimated spend: {formatUsd(totals.estimatedSpendAtomic)}</p>
    </section>
  );
}

function OwnerControls({ me, refresh }: { readonly me: Me; readonly refresh: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const action = me.frozen ? "unfreeze" : "freeze";

  async function submit() {
    setBusy(true);
    setNotice(undefined);
    try {
      const intent = await appApi.createFreezeIntent(action);
      await sendOwnerUserOperation(getStoredPasskey(), intent.to, intent.calldata);
      setNotice(action === "freeze" ? "Freezing…" : "Unfreezing…");
      setConfirm(false);
      window.dispatchEvent(new Event(ACCOUNT_REFRESH_EVENT));
      refresh();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Czar could not submit this action.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>Account controls</h2>
      {me.paused && <p>Czar paused all spending for safety.</p>}
      {confirm ? (
        <div role="group" aria-label={`${action} confirmation`}>
          <p>{action === "freeze" ? "Freeze spending now?" : "Allow spending again?"}</p>
          <button disabled={busy || me.paused} onClick={submit} type="button">
            Confirm {action}
          </button>
          <button disabled={busy} onClick={() => setConfirm(false)} type="button">
            Cancel
          </button>
        </div>
      ) : (
        <button disabled={busy || me.paused} onClick={() => setConfirm(true)} type="button">
          {me.frozen ? "Unfreeze" : "Freeze"}
        </button>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}

function BalanceGrid({ me }: { readonly me: Me }) {
  const balances = [
    ["Available:", me.balances.free],
    ["Committed to objectives:", me.balances.committed],
    ["In pocket wallets:", me.balances.pocketOutstanding],
    ["Network fee reserve:", me.balances.mscaBalance],
  ] as const;
  return (
    <section aria-label="Balances" className="balance-grid">
      {balances.map(([label, amount]) => (
        <div className="balance-card" key={label}>
          <span>{label}</span>
          <strong>{formatUsd(amount)}</strong>
        </div>
      ))}
    </section>
  );
}

export function ReceiptList({ items }: { readonly items: readonly LedgerReceipt[] }) {
  if (items.length === 0) return <p>No receipts yet.</p>;
  return (
    <ul className="rows">
      {items.map((receipt) => (
        <li key={receipt.paymentRefHash}>
          <span>{receipt.merchantLabel ?? receipt.rail}</span>
          <span>{receipt.amountDisplay ?? formatUsd(receipt.amount)}</span>
          <span>{receiptStatusText(receipt)}</span>
        </li>
      ))}
    </ul>
  );
}

function DataError({
  message,
  refresh,
}: {
  readonly message: string;
  readonly refresh: () => void;
}) {
  return (
    <div className="error-panel" role="alert">
      <p>{message}</p>
      <button onClick={refresh} type="button">
        Try again
      </button>
    </div>
  );
}
