"use client";

import { toCircleSmartAccount } from "@circle-fin/modular-wallets-core";
import { toWebAuthnAccount } from "viem/account-abstraction";
import { createPublicClient, defineChain, http } from "viem";
import { getAppWalletConfig } from "#src/app-api";

export interface BrowserPasskey {
  readonly credentialId: string;
  readonly publicKey: `0x${string}`;
  readonly clientDataJSON: string;
  readonly attestationObject: string;
}

export function supportsPasskeys(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof window.PublicKeyCredential !== "undefined"
  );
}

export async function createPasskey(challenge: Uint8Array): Promise<BrowserPasskey> {
  const { webauthnRpId } = await getAppWalletConfig();
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: Uint8Array.from(challenge).buffer,
      rp: { id: webauthnRpId, name: "Czar" },
      user: {
        id: crypto.getRandomValues(new Uint8Array(32)),
        name: "Czar owner",
        displayName: "Czar owner",
      },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        residentKey: "required",
        userVerification: "required",
      },
      attestation: "none",
    },
  });
  if (
    !(credential instanceof PublicKeyCredential) ||
    !(credential.response instanceof AuthenticatorAttestationResponse)
  ) {
    throw new Error("The passkey ceremony did not return a supported P-256 credential.");
  }
  const spki = new Uint8Array(credential.response.getPublicKey() ?? new ArrayBuffer(0));
  const publicKey = spki.slice(-65);
  if (publicKey.length !== 65 || publicKey[0] !== 4) {
    throw new Error("The browser returned an unsupported passkey public key.");
  }
  return {
    credentialId: toBase64Url(new Uint8Array(credential.rawId)),
    publicKey: `0x${toHex(publicKey)}`,
    clientDataJSON: toBase64Url(new Uint8Array(credential.response.clientDataJSON)),
    attestationObject: toBase64Url(new Uint8Array(credential.response.attestationObject)),
  };
}

export async function createPasskeyAssertion(
  challenge: Uint8Array,
  credentialId: string,
): Promise<{
  readonly credentialId: string;
  readonly authenticatorData: string;
  readonly clientDataJSON: string;
  readonly signature: string;
}> {
  const { webauthnRpId } = await getAppWalletConfig();
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge: Uint8Array.from(challenge).buffer,
      rpId: webauthnRpId,
      allowCredentials: [{ id: fromBase64Url(credentialId).buffer, type: "public-key" }],
      userVerification: "required",
    },
  });
  if (
    !(credential instanceof PublicKeyCredential) ||
    !(credential.response instanceof AuthenticatorAssertionResponse)
  ) {
    throw new Error("The passkey sign-in did not return a supported assertion.");
  }
  return {
    credentialId: toBase64Url(new Uint8Array(credential.rawId)),
    authenticatorData: toBase64Url(new Uint8Array(credential.response.authenticatorData)),
    clientDataJSON: toBase64Url(new Uint8Array(credential.response.clientDataJSON)),
    signature: toBase64Url(new Uint8Array(credential.response.signature)),
  };
}

export async function counterfactualMsca(passkey: BrowserPasskey): Promise<string> {
  const walletConfig = await getAppWalletConfig();
  const chain = defineChain({
    id: 5042002,
    name: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
    rpcUrls: { default: { http: [walletConfig.arcRpcUrl] } },
  });
  const client = createPublicClient({ chain, transport: http(walletConfig.arcRpcUrl) });
  const owner = toWebAuthnAccount({
    credential: { id: passkey.credentialId, publicKey: passkey.publicKey },
    rpId: walletConfig.webauthnRpId,
  });
  const account = await toCircleSmartAccount({
    client: client as unknown as Parameters<typeof toCircleSmartAccount>[0]["client"],
    owner: owner as unknown as Parameters<typeof toCircleSmartAccount>[0]["owner"],
  });
  return account.getAddress();
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
