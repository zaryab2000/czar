"use client";

import { useParams } from "next/navigation";
import { useCallback } from "react";
import { appApi } from "#src/app-api";
import { useAppData } from "#src/use-app-data";
import { formatUsd } from "@czar/web/money-format";

export default function EnvelopePage() {
  const params = useParams<{ envelopeRef: string }>();
  const envelopeRef = decodeURIComponent(params.envelopeRef);
  const load = useCallback(() => appApi.getEnvelope(envelopeRef), [envelopeRef]);
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
            <p>Status: {data.envelope.state}</p>
            <p>Cap: {formatUsd(data.envelope.cap)}</p>
            <p>Spent: {formatUsd(data.envelope.spent)}</p>
            <p>In pocket wallets: {formatUsd(data.envelope.pocketOutstanding)}</p>
            <p>Held in escrow: {formatUsd(data.envelope.jobEscrowed)}</p>
          </article>
          <h2>Reservations</h2>
          <p>{data.reservations.length}</p>
          <h2>Pockets</h2>
          <p>{data.pockets.length}</p>
          <h2>Jobs</h2>
          <p>{data.jobs.length}</p>
        </>
      )}
    </section>
  );
}
