"use client";

import { useCallback, useEffect, useState } from "react";
import type { LedgerReceipt } from "@czar/schemas";
import { appApi } from "#src/app-api";
import { ResultCard } from "#src/result-card";
import { receiptStatusText } from "#src/receipt-status";
import { useAppData } from "#src/use-app-data";
import { formatUsd } from "@czar/web/money-format";

export default function ReceiptsPage() {
  const [cursor, setCursor] = useState<string>();
  const [items, setItems] = useState<readonly LedgerReceipt[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const load = useCallback(() => appApi.listReceipts(cursor), [cursor]);
  const { data, error, loading, refresh } = useAppData(load);
  const loadResults = useCallback(() => appApi.listAllAppResults(), []);
  const {
    data: results,
    error: resultsError,
    loading: resultsLoading,
    refresh: refreshResults,
  } = useAppData(loadResults);

  useEffect(() => {
    if (!data) return;
    setItems((previous) => (cursor ? [...previous, ...data.items] : data.items));
    setNextCursor(data.nextCursor);
  }, [cursor, data]);
  return (
    <section className="page-stack">
      <h1 className="czar-title">Receipts</h1>
      <section className="page-stack" aria-label="Results">
        <h2>Results</h2>
        {resultsLoading && <p role="status">Loading results…</p>}
        {resultsError && (
          <div className="error-panel" role="alert">
            <p>{resultsError}</p>
            <button onClick={refreshResults} type="button">
              Try again
            </button>
          </div>
        )}
        {results?.items.map((card) => (
          <ResultCard card={card} key={card.objectiveId} />
        ))}
        {results?.items.length === 0 && <p>No results yet.</p>}
      </section>
      <h2>Payment receipts</h2>
      {loading && <p role="status">Loading receipts…</p>}
      {error && (
        <div className="error-panel" role="alert">
          <p>{error}</p>
          <button onClick={refresh} type="button">
            Try again
          </button>
        </div>
      )}
      {items.map((receipt) => (
        <article className="panel receipt" key={receipt.paymentRefHash}>
          <h2>{receipt.merchantLabel ?? receipt.rail}</h2>
          <p>{receipt.amountDisplay ?? formatUsd(receipt.amount)}</p>
          <p>{receiptStatusText(receipt)}</p>
          {receipt.accepted !== undefined && (
            <p>{receipt.accepted ? "Accepted" : "Not accepted"}</p>
          )}
          {receipt.minutesSaved !== undefined && <p>Time saved: {receipt.minutesSaved} minutes</p>}
          <time dateTime={receipt.createdAt}>{receipt.createdAt}</time>
        </article>
      ))}
      {items.length === 0 && data && <p>No receipts yet.</p>}
      {nextCursor && (
        <button onClick={() => setCursor(nextCursor)} type="button">
          Load more
        </button>
      )}
    </section>
  );
}
