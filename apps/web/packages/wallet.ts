"use client";

import { toCircleSmartAccount, toModularTransport } from "@circle-fin/modular-wallets-core";
import { createPublicClient, defineChain, http, type Hex, type Transport } from "viem";
import { createBundlerClient, toWebAuthnAccount } from "viem/account-abstraction";
import { readEnvelopeCount as readCount } from "@czar/vault-client";
import { getAppWalletConfig } from "#src/app-api";
import type { BrowserPasskey } from "#src/passkey";

const CHAIN_ID = 5042002;
const BUNDLERS = ["circle", "pimlico", "alchemy", "zerodev"] as const;
const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

export async function sendOwnerUserOperation(
  passkey: Pick<BrowserPasskey, "credentialId" | "publicKey">,
  to: `0x${string}`,
  data: Hex,
): Promise<{ readonly userOpHash: Hex; readonly bundler: (typeof BUNDLERS)[number] }> {
  const walletConfig = await getAppWalletConfig();
  const chain = arcChain(walletConfig.arcRpcUrl);
  const publicClient = createPublicClient({
    chain,
    transport: http(walletConfig.arcRpcUrl),
  });
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
  for (const name of walletConfig.bundlerOrder) {
    const endpoint =
      walletConfig.bundlerEndpoints[name] ??
      (name === "circle" ? walletConfig.circleClientUrl : undefined);
    if (!endpoint) continue;
    try {
      const bundler = createBundlerClient({
        account,
        chain,
        client: publicClient,
        transport: toModularTransport(
          `${endpoint}/arcTestnet`,
          walletConfig.circleClientKey,
        ) as unknown as Transport,
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
  const walletConfig = await getAppWalletConfig();
  const chain = arcChain(walletConfig.arcRpcUrl);
  const client = createPublicClient({ chain, transport: http(walletConfig.arcRpcUrl) });
  return readCount({ client, vault });
}

function arcChain(rpcUrl: string) {
  return defineChain({
    id: CHAIN_ID,
    name: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}
