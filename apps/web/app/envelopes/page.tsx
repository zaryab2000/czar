"use client";

import { useCallback } from "react";
import { appApi } from "#src/app-api";
import { useAppData } from "#src/use-app-data";
import { formatUsd } from "@czar/web/money-format";

export default function EnvelopesPage() {
  const load = useCallback(() => appApi.listEnvelopes(), []);
  const { data, error, loading, refresh } = useAppData(load);
  return (
    <section className="page-stack">
      <h1 className="czar-title">Envelopes</h1>
      {loading && <p role="status">Loading envelopes…</p>}
      {error && (
        <div className="error-panel" role="alert">
          <p>{error}</p>
          <button onClick={refresh} type="button">
            Try again
          </button>
        </div>
      )}
      <ul className="rows">
        {data?.items.map((envelope) => (
          <li key={envelope.envelopeRef}>
            <a href={`/envelopes/${encodeURIComponent(envelope.envelopeRef)}`}>
              Envelope {envelope.envelopeId}
            </a>
            <span>{envelope.state}</span>
            <span>{formatUsd(envelope.cap)}</span>
          </li>
        ))}
      </ul>
      {data?.items.length === 0 && <p>No envelopes yet.</p>}
    </section>
  );
}
