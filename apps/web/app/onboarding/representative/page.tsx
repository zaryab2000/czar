"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { appApi } from "#src/app-api";

const CONSENT_TEXT_VERSION = "2026-11-05";

export default function RepresentativeOnboardingPage() {
  const router = useRouter();
  const [share, setShare] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function complete() {
    setBusy(true);
    setError(undefined);
    try {
      await appApi.updateSocialMe({
        sharing: share ? "structured" : "off",
        consentTextVersion: CONSENT_TEXT_VERSION,
      });
      router.push("/home");
    } catch {
      setError("Czar could not save your sharing choice. Sign in and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="welcome-card page-stack">
      <p className="eyebrow">Step 5 of 5</p>
      <h1 className="czar-title">Your commerce representative</h1>
      <p>
        Czar gives you a commerce representative. With this on, it shares structured notes about
        what Czar bought for you: which supplier, what kind of task, whether it delivered, and how
        you rated the result. It never shares your files, the subjects you looked up, exact amounts,
        your wallet, or anything from your work soul. Payments are public on the blockchain, so for
        a supplier with very few buyers someone could still guess which payment a note describes.
        You can pause it or turn it off any time in Settings.
      </p>
      <label>
        <input
          type="checkbox"
          checked={share}
          onChange={(event) => setShare(event.target.checked)}
        />
        Share structured purchase experiences
      </label>
      {error && <p role="alert">{error}</p>}
      <button className="primary-button" type="button" disabled={busy} onClick={complete}>
        {busy ? "Saving…" : "Continue"}
      </button>
    </section>
  );
}
