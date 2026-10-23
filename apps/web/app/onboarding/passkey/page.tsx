"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { appApi } from "#src/app-api";
import {
  counterfactualMsca,
  createPasskey,
  createPasskeyAssertion,
  fromBase64Url,
  supportsPasskeys,
  type BrowserPasskey,
} from "#src/passkey";

const PASSKEY_KEY = "czar.ownerPasskey";
const UNSUPPORTED =
  "Passkeys did not work in this browser. Please open Czar in Safari or Chrome on your Mac.";

export default function PasskeyOnboardingPage() {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(false);

  async function signIn() {
    setBusy(true);
    setError(undefined);
    try {
      if (!supportsPasskeys()) throw new Error(UNSUPPORTED);
      const stored = readStoredPasskey();
      const challenge = await appApi.createAuthChallenge("session");
      const assertion = await createPasskeyAssertion(
        fromBase64Url(challenge.challenge),
        stored.credentialId,
      );
      await appApi.createSession({ challengeId: challenge.challengeId, ...assertion });
      router.push("/home");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Czar could not sign in with this passkey.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function createAccount() {
    setBusy(true);
    setError(undefined);
    try {
      if (!supportsPasskeys()) throw new Error(UNSUPPORTED);
      const challenge = await appApi.createAuthChallenge("register");
      const passkey = await createPasskey(fromBase64Url(challenge.challenge));
      const msca = await counterfactualMsca(passkey);
      await appApi.registerPasskey({
        challengeId: challenge.challengeId,
        credentialId: passkey.credentialId,
        clientDataJSON: passkey.clientDataJSON,
        attestationObject: passkey.attestationObject,
        msca: msca as `0x${string}`,
      });
      storePublicPasskey(passkey);
      setCreated(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Czar could not create your passkey.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="welcome-card page-stack">
      <p className="eyebrow">Step 1 of 4</p>
      <h1 className="czar-title">Create your account</h1>
      <p>Your passkey stays with your browser. Czar never receives a password or seed phrase.</p>
      {error && <p role="alert">{error}</p>}
      {created ? (
        <>
          <p role="status">Passkey created. Your Czar account is ready to set up.</p>
          <a className="primary-link" href="/onboarding/vault">
            Continue to create your vault
          </a>
          <button disabled={busy} onClick={signIn} type="button">
            Verify passkey sign-in
          </button>
        </>
      ) : (
        <>
          <button className="primary-button" disabled={busy} onClick={createAccount} type="button">
            {busy ? "Creating passkey…" : "Create passkey"}
          </button>
          {hasStoredPasskey() && (
            <button disabled={busy} onClick={signIn} type="button">
              Sign in with your passkey
            </button>
          )}
        </>
      )}
    </section>
  );
}

function hasStoredPasskey(): boolean {
  try {
    return sessionStorage.getItem(PASSKEY_KEY) !== null;
  } catch {
    return false;
  }
}

function readStoredPasskey(): Pick<BrowserPasskey, "credentialId" | "publicKey"> {
  let value: string | null;
  try {
    value = sessionStorage.getItem(PASSKEY_KEY);
  } catch {
    throw new Error("This browser could not read the passkey reference. Enable session storage.");
  }
  if (!value) throw new Error("Create an account in this browser before signing in.");
  const parsed = JSON.parse(value) as { credentialId?: unknown; publicKey?: unknown };
  if (typeof parsed.credentialId !== "string" || typeof parsed.publicKey !== "string") {
    throw new Error("The passkey reference is incomplete. Create your account again.");
  }
  return { credentialId: parsed.credentialId, publicKey: parsed.publicKey as `0x${string}` };
}

function storePublicPasskey(passkey: BrowserPasskey): void {
  try {
    sessionStorage.setItem(
      PASSKEY_KEY,
      JSON.stringify({
        credentialId: passkey.credentialId,
        publicKey: passkey.publicKey,
      }),
    );
  } catch {
    throw new Error(
      "This browser could not store the passkey reference. Enable session storage and retry.",
    );
  }
}
