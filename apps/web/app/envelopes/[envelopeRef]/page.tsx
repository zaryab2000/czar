"use client";

import { useParams } from "next/navigation";
import { useCallback, useState } from "react";
import { appApi } from "#src/app-api";
import { submitManualReturn } from "#src/manual-return";
import { useAppData } from "#src/use-app-data";
import { formatUsd } from "@czar/web/money-format";

export default function EnvelopePage() {
  const params = useParams<{ envelopeRef: string }>();
  const envelopeRef = decodeURIComponent(params.envelopeRef);
  const load = useCallback(async () => {
    const [envelope, manualReturns] = await Promise.all([
      appApi.getEnvelope(envelopeRef),
      appApi.listAllManualReturns(),
    ]);
    return {
      envelope,
      manualReturns: manualReturns.items.filter((item) => item.envelopeRef === envelopeRef),
    };
  }, [envelopeRef]);
  const { data, error, loading, refresh } = useAppData(load);
  return (
    <section className="page-stack">
      <h1 className="czar-title">Envelope</h1>
      {loading && <p role="status">Loading envelope…</p>}
      {error && (
        <div className="error-panel" role="alert">
          <p>{error}</p>
          <button onClick={refresh} type="button">
            Try again
          </button>
        </div>
      )}
      {data && (
        <>
          <article className="panel">
            <p>Status: {data.envelope.envelope.state}</p>
            <p>Cap: {formatUsd(data.envelope.envelope.cap)}</p>
            <p>Spent: {formatUsd(data.envelope.envelope.spent)}</p>
            <p>In pocket wallets: {formatUsd(data.envelope.envelope.pocketOutstanding)}</p>
            <p>Held in escrow: {formatUsd(data.envelope.envelope.jobEscrowed)}</p>
          </article>
          <ManualReturnList items={data.manualReturns} refresh={refresh} />
          <h2>Reservations</h2>
          <p>{data.envelope.reservations.length}</p>
          <h2>Pockets</h2>
          <p>{data.envelope.pockets.length}</p>
          <h2>Jobs</h2>
          <p>{data.envelope.jobs.length}</p>
        </>
      )}
    </section>
  );
}

function ManualReturnList({
  items,
  refresh,
}: {
  readonly items: readonly import("@czar/schemas").ManualReturn[];
  readonly refresh: () => void;
}) {
  const [busyReturn, setBusyReturn] = useState<string>();
  const [submittedReturns, setSubmittedReturns] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<string>();

  if (items.length === 0) return null;

  async function recordReturn(item: import("@czar/schemas").ManualReturn) {
    setBusyReturn(item.returnTx);
    setNotice(undefined);
    try {
      await submitManualReturn(item);
      setSubmittedReturns((current) => new Set([...current, item.returnTx]));
      setNotice("Return submitted. Waiting for the network to confirm it.");
      refresh();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Czar could not submit this return.");
    } finally {
      setBusyReturn(undefined);
    }
  }

  return (
    <section aria-labelledby="manual-return-title" className="panel">
      <h2 id="manual-return-title">Money to record</h2>
      {notice && <p role="status">{notice}</p>}
      <ul className="rows">
        {items.map((item) => (
          <li key={item.returnTx}>
            {item.state === "manual-return-required" && (
              <>
                <span>
                  {formatUsd(item.returnedAmount)} came back from a pocket wallet by the slow 7-day
                  route. Record it so your vault&apos;s books match.
                </span>
                <button
                  disabled={busyReturn === item.returnTx || submittedReturns.has(item.returnTx)}
                  onClick={() => void recordReturn(item)}
                  type="button"
                >
                  {busyReturn === item.returnTx
                    ? "Recording…"
                    : `Record ${formatUsd(item.returnedAmount)}`}
                </button>
              </>
            )}
            {item.state === "recorded" && (
              <span>Recorded {formatUsd(item.recordedCredit ?? item.returnedAmount)}</span>
            )}
            {item.state === "expired" && (
              <span>
                This pocket closed before the return was recorded. The money is already in your
                vault.
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
