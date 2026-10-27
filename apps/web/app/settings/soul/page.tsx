"use client";

import { useCallback } from "react";
import { appApi } from "#src/app-api";
import { useAppData } from "#src/use-app-data";

export default function SoulPage() {
  const load = useCallback(() => appApi.getSoulPointer(), []);
  const { data, error, loading, refresh } = useAppData(load);
  return (
    <section className="page-stack">
      <h1 className="czar-title">Work Soul</h1>
      <p>
        Your Work Soul is viewable on your computer. Open the Czar viewer there to read, edit or
        delete any line.
      </p>
      {loading && <p role="status">Loading…</p>}
      {error && (
        <div className="error-panel" role="alert">
          <p>{error}</p>
          <button onClick={refresh} type="button">
            Try again
          </button>
        </div>
      )}
      {data && <p>{data.message}</p>}
    </section>
  );
}
