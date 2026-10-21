"use client";

import { toCircleSmartAccount, toModularTransport } from "@circle-fin/modular-wallets-core";
import { createPublicClient, defineChain, http, type Hex, type Transport } from "viem";
import { createBundlerClient, toWebAuthnAccount } from "viem/account-abstraction";
import { readEnvelopeCount as readCount } from "@czar/vault-client";
import type { BrowserPasskey } from "#src/passkey";

const CHAIN_ID = 5042002;
const ARC_RPC_URL = process.env["NEXT_PUBLIC_ARC_RPC_URL"] ?? "http://127.0.0.1:8549";
const CIRCLE_URL = process.env["NEXT_PUBLIC_CIRCLE_CLIENT_URL"] ?? "http://127.0.0.1:4337";
const CIRCLE_KEY = process.env["NEXT_PUBLIC_CIRCLE_CLIENT_KEY"] ?? "lane5-test-client-key";
const BUNDLER_ORDER =
  process.env["NEXT_PUBLIC_CZAR_BUNDLER_ORDER"] ?? "circle,pimlico,alchemy,zerodev";
const BUNDLER_ENDPOINTS = readBundlerEndpoints(process.env["NEXT_PUBLIC_CZAR_BUNDLER_ENDPOINTS"]);
const BUNDLERS = ["circle", "pimlico", "alchemy", "zerodev"] as const;
const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

const chain = defineChain({
  id: CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
  rpcUrls: { default: { http: [ARC_RPC_URL] } },
});

export async function sendOwnerUserOperation(
  passkey: Pick<BrowserPasskey, "credentialId" | "publicKey">,
  to: `0x${string}`,
  data: Hex,
): Promise<{ readonly userOpHash: Hex; readonly bundler: (typeof BUNDLERS)[number] }> {
  const publicClient = createPublicClient({ chain, transport: http(ARC_RPC_URL) });
  const webAuthnOwner = toWebAuthnAccount({
    credential: { id: passkey.credentialId, publicKey: passkey.publicKey },
    rpId: "localhost",
  });
  const owner = {
    ...webAuthnOwner,
    async sign(parameters: Parameters<typeof webAuthnOwner.sign>[0]) {
      const result = await webAuthnOwner.sign(parameters);
      return { ...result, signature: normalizeP256LowS(result.signature) };
    },
  };
  const account = await toCircleSmartAccount({
    client: publicClient as unknown as Parameters<typeof toCircleSmartAccount>[0]["client"],
    owner: owner as unknown as Parameters<typeof toCircleSmartAccount>[0]["owner"],
  });
  let lastError: unknown;
  for (const name of BUNDLER_ORDER.split(",").map((item) => item.trim())) {
    if (!isBundlerName(name)) continue;
    const endpoint = BUNDLER_ENDPOINTS[name] ?? (name === "circle" ? CIRCLE_URL : undefined);
    if (!endpoint) continue;
    try {
      const bundler = createBundlerClient({
        account,
        chain,
        client: publicClient,
        transport: toModularTransport(`${endpoint}/arcTestnet`, CIRCLE_KEY) as unknown as Transport,
      });
      const userOpHash = await bundler.sendUserOperation({
        account,
        calls: [{ to, data, value: 0n }],
      });
      return { userOpHash, bundler: name };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error("The network is busy. Your approval was not sent. Try again in a minute.", {
    cause: lastError,
  });
}

export function normalizeP256LowS(signature: `0x${string}`): `0x${string}` {
  if (!/^0x[\da-fA-F]{128}$/.test(signature)) {
    throw new Error("Passkey returned an invalid P-256 signature. Please try again.");
  }
  const r = BigInt(`0x${signature.slice(2, 66)}`);
  const s = BigInt(`0x${signature.slice(66)}`);
  if (r === 0n || r >= P256_ORDER || s === 0n || s >= P256_ORDER) {
    throw new Error("Passkey returned an invalid P-256 signature. Please try again.");
  }
  const lowS = s > P256_ORDER / 2n ? P256_ORDER - s : s;
  return `0x${r.toString(16).padStart(64, "0")}${lowS.toString(16).padStart(64, "0")}`;
}

function isBundlerName(value: string): value is (typeof BUNDLERS)[number] {
  return BUNDLERS.some((name) => name === value);
}

function readBundlerEndpoints(
  value: string | undefined,
): Partial<Record<(typeof BUNDLERS)[number], string>> {
  if (!value) return {};
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("NEXT_PUBLIC_CZAR_BUNDLER_ENDPOINTS must be a JSON object.");
  }
  const endpoints: Partial<Record<(typeof BUNDLERS)[number], string>> = {};
  for (const name of BUNDLERS) {
    const endpoint = (parsed as Record<string, unknown>)[name];
    if (endpoint === undefined) continue;
    if (
      typeof endpoint !== "string" ||
      (new URL(endpoint).protocol !== "http:" && new URL(endpoint).protocol !== "https:")
    ) {
      throw new Error(`Bundler endpoint for ${name} must be an HTTP(S) URL.`);
    }
    endpoints[name] = endpoint;
  }
  return endpoints;
}

export function getStoredPasskey(): Pick<BrowserPasskey, "credentialId" | "publicKey"> {
  const value = sessionStorage.getItem("czar.ownerPasskey");
  if (!value) throw new Error("Create or sign in with your passkey before continuing.");
  const parsed = JSON.parse(value) as { credentialId?: unknown; publicKey?: unknown };
  if (typeof parsed.credentialId !== "string" || typeof parsed.publicKey !== "string") {
    throw new Error("The passkey reference is missing. Sign in again.");
  }
  return {
    credentialId: parsed.credentialId,
    publicKey: parsed.publicKey as `0x${string}`,
  };
}

export async function readEnvelopeCount(vault: `0x${string}`): Promise<bigint> {
  const client = createPublicClient({ chain, transport: http(ARC_RPC_URL) });
  return readCount({ client, vault });
}
