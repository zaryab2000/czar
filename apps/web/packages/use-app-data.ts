"use client";

import { useCallback, useEffect, useState } from "react";
import { AppApiError } from "./app-api";

export interface AppData<T> {
  readonly data: T | undefined;
  readonly error: string | undefined;
  readonly loading: boolean;
  readonly refresh: () => void;
}

export function useAppData<T>(loadData: () => Promise<T>): AppData<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    loadData()
      .then((value) => {
        if (!active) return;
        setData(value);
        setError(undefined);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(
          cause instanceof AppApiError && cause.status === 401
            ? "Sign in with your passkey to load current Czar data."
            : "Czar could not load current data. Check the connection and retry.",
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadData, revision]);

  return { data, error, loading, refresh };
}
