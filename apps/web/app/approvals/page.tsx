"use client";

import { useCallback, useEffect } from "react";
import { appApi } from "#src/app-api";
import { usePendingCount } from "#src/app-shell";
import { useAppData } from "#src/use-app-data";

export default function ApprovalsPage() {
  const load = useCallback(() => appApi.listPendingApprovals(), []);
  const { data, error, loading, refresh } = useAppData(load);
  const approvals = data?.page.items ?? [];
  const setPendingCount = usePendingCount();

  useEffect(() => {
    if (!data) return;
    setPendingCount(approvals.length);
    const timer = window.setInterval(refresh, data.pollSeconds * 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [approvals.length, data, refresh, setPendingCount]);
  return (
    <>
      <section className="page-stack">
        <h1 className="czar-title">Approvals</h1>
        <p>Czar needs your approval for these. Nothing is spent until you approve.</p>
        {loading && <p role="status">Loading approvals…</p>}
        {error && (
          <div className="error-panel" role="alert">
            <p>{error}</p>
            <button onClick={refresh} type="button">
              Try again
            </button>
          </div>
        )}
        <ul className="rows">
          {approvals.map((approval) => (
            <li key={approval.planId}>
              <a href={`/approve/${encodeURIComponent(approval.planId)}`}>{approval.goal}</a>
              <span>{approval.capDisplay}</span>
              <span>{approval.category}</span>
            </li>
          ))}
        </ul>
        {data && approvals.length === 0 && <p>No pending approvals.</p>}
      </section>
    </>
  );
}
