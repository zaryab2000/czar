"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { Me } from "@czar/schemas";
import { AppApiError, appApi, clearSession, hasAppSession } from "#src/app-api";

const PendingCountContext = createContext<(count: number) => void>(() => undefined);
export const ACCOUNT_REFRESH_EVENT = "czar:account-refresh";

export function usePendingCount(): (count: number) => void {
  return useContext(PendingCountContext);
}

export function AppShell({ children }: { readonly children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<Me>();
  const [signedIn, setSignedIn] = useState(false);
  const [sessionNotice, setSessionNotice] = useState<string>();
  const [pendingCount, setPendingCount] = useState(0);
  const publishPendingCount = useCallback((count: number) => setPendingCount(count), []);
  const isWelcome = pathname === "/" || pathname.startsWith("/onboarding/");
  const setupRequired = signedIn && me !== undefined && !me.vaultCreated;

  const refreshAccount = useCallback(async () => {
    try {
      const response = await appApi.getMe();
      setMe(response);
      setSignedIn(true);
      setSessionNotice(undefined);
    } catch (cause) {
      setSignedIn(false);
      setMe(undefined);
      if (cause instanceof AppApiError && cause.status === 401) {
        setSessionNotice("Your session expired. Sign in with your passkey.");
      } else {
        setSessionNotice("Account status is unavailable while offline.");
      }
    }
  }, []);

  useEffect(() => {
    if (isWelcome || !hasAppSession()) return;
    void refreshAccount();
  }, [isWelcome, pathname, refreshAccount]);

  useEffect(() => {
    const refresh = () => void refreshAccount();
    window.addEventListener(ACCOUNT_REFRESH_EVENT, refresh);
    return () => window.removeEventListener(ACCOUNT_REFRESH_EVENT, refresh);
  }, [refreshAccount]);

  useEffect(() => {
    const title = pendingCount > 0 && pathname === "/approvals" ? `(${pendingCount}) Czar` : "Czar";
    const synchronizeTitle = () => {
      if (document.title !== title) document.title = title;
    };
    synchronizeTitle();
    const observer = new MutationObserver(synchronizeTitle);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [pendingCount, pathname]);

  function signOut() {
    clearSession();
    setMe(undefined);
    setSignedIn(false);
    setSessionNotice(undefined);
    router.push("/");
  }

  return (
    <>
      {!isWelcome && (
        <header className="czar-header">
          <a aria-label="Czar home" className="czar-wordmark" href="/home">
            Czar
          </a>
          <nav aria-label="Main navigation" className="czar-nav">
            <a href="/home">Home</a>
            <a href="/approvals">Approvals</a>
            <a href="/envelopes">Envelopes</a>
            <a href="/receipts">Receipts</a>
            <a href="/settings/privacy">Settings</a>
          </nav>
          {signedIn && (
            <button onClick={signOut} type="button">
              Sign out
            </button>
          )}
        </header>
      )}
      {me?.frozen && (
        <p className="global-notice" role="status">
          Frozen. No payments can start until you unfreeze. Money already on its way back to you
          still arrives.
        </p>
      )}
      {me?.paused && (
        <p className="global-notice" role="status">
          Czar paused all spending for safety. Nothing can start. Your money stays in your vault.
        </p>
      )}
      {sessionNotice && (
        <p className="global-notice" role="status">
          {sessionNotice}
        </p>
      )}
      <PendingCountContext.Provider value={publishPendingCount}>
        <main className="czar-main">
          {setupRequired && !pathname.startsWith("/onboarding/") ? (
            <section className="welcome-card">
              <h1 className="czar-title">Finish setting up your vault</h1>
              <p>Payments and approvals stay unavailable until your vault is ready.</p>
              <a className="primary-link" href="/onboarding/vault">
                Continue setup
              </a>
            </section>
          ) : (
            children
          )}
        </main>
      </PendingCountContext.Provider>
    </>
  );
}
