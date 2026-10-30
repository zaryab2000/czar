"use client";

import { toCircleSmartAccount, toModularTransport } from "@circle-fin/modular-wallets-core";
import {
  createPublicClient,
  defineChain,
  http,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";
import {
  createBundlerClient,
  toWebAuthnAccount,
  WaitForUserOperationReceiptTimeoutError,
  type BundlerClient,
} from "viem/account-abstraction";
import { PARAMETERS } from "@czar/config/registry";
import { readEnvelopeCount as readCount } from "@czar/vault-client";
import { getAppWalletConfig } from "#src/app-api";
import type { BrowserPasskey } from "#src/passkey";

const CHAIN_ID = 5042002;
const BUNDLERS = ["circle", "pimlico", "alchemy", "zerodev"] as const;
const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

/** `waitForInclusion`: return only once the accepting bundler reports the receipt (SCR-159 §4). */
export interface OwnerUserOperationOptions {
  readonly waitForInclusion?: boolean;
}

/**
 * Sends one owner UserOperation through the first bundler that accepts it. With
 * `waitForInclusion`, it then waits on that bundler for the receipt, bounded by
 * `app.userOpReceiptTimeoutSeconds`, and fails when the receipt shows a revert. Send before the
 * next owner operation only after inclusion: both use the same EntryPoint nonce until then.
 */
export async function sendOwnerUserOperation(
  passkey: Pick<BrowserPasskey, "credentialId" | "publicKey">,
  to: `0x${string}`,
  data: Hex,
  options: OwnerUserOperationOptions = {},
): Promise<{ readonly userOpHash: Hex; readonly bundler: (typeof BUNDLERS)[number] }> {
  const walletConfig = await getAppWalletConfig();
  const chain = arcChain(walletConfig.arcRpcUrl);
  const publicClient = createPublicClient({
    chain,
    transport: http(walletConfig.arcRpcUrl),
  });
  const webAuthnOwner = toWebAuthnAccount({
    credential: { id: passkey.credentialId, publicKey: passkey.publicKey },
    rpId: walletConfig.webauthnRpId,
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
  let accepted:
    | {
        readonly userOpHash: Hex;
        readonly bundler: (typeof BUNDLERS)[number];
        readonly client: BundlerClient;
      }
    | undefined;
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
      accepted = {
        userOpHash: await bundler.sendUserOperation({
          account,
          calls: [{ to, data, value: 0n }],
        }),
        bundler: name,
        client: bundler,
      };
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!accepted) {
    throw new Error("The network is busy. Your approval was not sent. Try again in a minute.", {
      cause: lastError,
    });
  }
  if (options.waitForInclusion) await waitForInclusion(accepted.client, accepted.userOpHash);
  return { userOpHash: accepted.userOpHash, bundler: accepted.bundler };
}

/** Waits on the bundler that accepted the operation; it is never re-sent to another one. */
async function waitForInclusion(
  bundler: Pick<BundlerClient, "waitForUserOperationReceipt">,
  hash: Hex,
): Promise<void> {
  const seconds = userOpReceiptTimeoutSeconds();
  let receipt: Awaited<ReturnType<BundlerClient["waitForUserOperationReceipt"]>>;
  try {
    receipt = await bundler.waitForUserOperationReceipt({ hash, timeout: seconds * 1_000 });
  } catch (cause) {
    const message =
      cause instanceof WaitForUserOperationReceiptTimeoutError
        ? `The network has not confirmed this change after ${seconds} seconds.`
        : "Czar could not confirm this change with the network.";
    throw new Error(`${message} Wait a minute and check before trying again.`, { cause });
  }
  if (!receipt.success) {
    // The revert data stays on the cause so callers can decode it (`@czar/vault-client`).
    throw new Error("This change failed on-chain and was not applied.", {
      cause: Object.assign(new Error("UserOperation reverted"), { data: receipt.reason }),
    });
  }
}

function userOpReceiptTimeoutSeconds(): number {
  const seconds = PARAMETERS.find(
    (spec) => spec.key === "app.userOpReceiptTimeoutSeconds",
  )?.default;
  if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds <= 0) {
    throw new Error("Invalid wallet configuration: app.userOpReceiptTimeoutSeconds");
  }
  return seconds;
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
  return readCount({ client: await walletPublicClient(), vault });
}

/** A read-only Arc client on the server-configured browser RPC. */
export async function walletPublicClient(): Promise<PublicClient> {
  const walletConfig = await getAppWalletConfig();
  const chain = arcChain(walletConfig.arcRpcUrl);
  return createPublicClient({ chain, transport: http(walletConfig.arcRpcUrl) });
}

function arcChain(rpcUrl: string) {
  return defineChain({
    id: CHAIN_ID,
    name: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}
