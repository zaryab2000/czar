import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { custom, encodeErrorResult, type Hex } from "viem";
import { waitForUserOperationReceipt } from "viem/account-abstraction";
import { PARAMETERS } from "@czar/config/registry";
import { czarVaultFactoryAbi } from "@czar/vault-client";

const walletMocks = vi.hoisted(() => ({
  getAppWalletConfig: vi.fn(),
  toCircleSmartAccount: vi.fn(),
  toModularTransport: vi.fn(),
  createBundlerClient: vi.fn(),
}));

vi.mock("#src/app-api", () => ({ getAppWalletConfig: walletMocks.getAppWalletConfig }));
vi.mock("@circle-fin/modular-wallets-core", () => ({
  toCircleSmartAccount: walletMocks.toCircleSmartAccount,
  toModularTransport: walletMocks.toModularTransport,
}));
vi.mock("viem/account-abstraction", async (importOriginal) => ({
  ...(await importOriginal<typeof import("viem/account-abstraction")>()),
  createBundlerClient: walletMocks.createBundlerClient,
}));

import { sendOwnerUserOperation, normalizeP256LowS } from "#src/wallet";

const { createBundlerClient: createViemBundlerClient } = await vi.importActual<
  typeof import("viem/account-abstraction")
>("viem/account-abstraction");

const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

afterEach(() => {
  walletMocks.getAppWalletConfig.mockReset();
  walletMocks.toCircleSmartAccount.mockReset();
  walletMocks.toModularTransport.mockReset();
  walletMocks.createBundlerClient.mockReset();
  vi.useRealTimers();
});

it("does not create or submit a wallet action when config loading fails", async () => {
  walletMocks.getAppWalletConfig.mockRejectedValue(new Error("wallet config unavailable"));

  await expect(
    sendOwnerUserOperation(
      { credentialId: "credential-id", publicKey: `0x${"00".repeat(65)}` },
      "0x0000000000000000000000000000000000000001",
      "0x",
    ),
  ).rejects.toThrow("wallet config unavailable");
  expect(walletMocks.toCircleSmartAccount).not.toHaveBeenCalled();
  expect(walletMocks.toModularTransport).not.toHaveBeenCalled();
});

const PASSKEY = { credentialId: "credential-id", publicKey: `0x04${"11".repeat(64)}` } as const;
const TARGET = "0x00000000000000000000000000000000000000a1" as const;
const USER_OP_HASH = `0x${"ab".repeat(32)}` as const;
const RECEIPT_TIMEOUT_SECONDS = PARAMETERS.find(
  (spec) => spec.key === "app.userOpReceiptTimeoutSeconds",
)?.default;

/**
 * A bundler that accepts every UserOperation and answers receipt lookups from `receipt`. The
 * receipt wait is viem's own action, so its polling and timeout run as in the browser.
 */
function acceptingBundler(name: string, receipt: () => unknown) {
  const calls: string[] = [];
  const client = createViemBundlerClient({
    pollingInterval: 1_000,
    transport: custom({
      request: async ({ method }) => {
        if (method !== "eth_getUserOperationReceipt") throw new Error(`unexpected ${method}`);
        calls.push(`${name}:receipt`);
        return receipt();
      },
    }),
  });
  return {
    calls,
    client: {
      sendUserOperation: vi.fn(async () => {
        calls.push(`${name}:send`);
        return USER_OP_HASH;
      }),
      waitForUserOperationReceipt: (parameters: { hash: Hex; timeout?: number }) =>
        waitForUserOperationReceipt(client, parameters),
    },
  };
}

function rpcReceipt(success: boolean, reason: Hex | null = null) {
  const hash = `0x${"cd".repeat(32)}`;
  return {
    userOpHash: USER_OP_HASH,
    entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
    sender: "0x00000000000000000000000000000000000000b1",
    nonce: "0x1",
    actualGasCost: "0x0",
    actualGasUsed: "0x1",
    success,
    reason,
    logs: [],
    receipt: {
      transactionHash: hash,
      transactionIndex: "0x0",
      blockHash: hash,
      blockNumber: "0x1",
      from: "0x00000000000000000000000000000000000000b1",
      to: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
      cumulativeGasUsed: "0x1",
      gasUsed: "0x1",
      effectiveGasPrice: "0x1",
      contractAddress: null,
      logs: [],
      logsBloom: `0x${"00".repeat(256)}`,
      status: "0x1",
      type: "0x2",
    },
  };
}

describe("sendOwnerUserOperation with waitForInclusion (SCR-159 §4)", () => {
  beforeEach(() => {
    walletMocks.getAppWalletConfig.mockResolvedValue({
      circleClientUrl: "https://wallet.example.test",
      circleClientKey: "public-key",
      arcRpcUrl: "https://rpc.example.test",
      bundlerOrder: ["circle", "pimlico"],
      bundlerEndpoints: { pimlico: "https://pimlico.example.test" },
      vaultFactory: "0x00000000000000000000000000000000000000f1",
      webauthnRpId: "app.czar.example",
    });
    walletMocks.toCircleSmartAccount.mockResolvedValue({ address: TARGET });
  });

  it("the receipt timeout is app.userOpReceiptTimeoutSeconds (120 s)", () => {
    expect(RECEIPT_TIMEOUT_SECONDS).toBe(120);
  });

  it("returns only after the accepting bundler reports the receipt", async () => {
    let mined = false;
    const bundler = acceptingBundler("circle", () => (mined ? rpcReceipt(true) : null));
    walletMocks.createBundlerClient.mockReturnValue(bundler.client);
    vi.useFakeTimers();

    let settled = false;
    const sent = sendOwnerUserOperation(PASSKEY, TARGET, "0x", { waitForInclusion: true }).then(
      (result) => {
        settled = true;
        return result;
      },
    );
    await vi.advanceTimersByTimeAsync(3_000);
    expect(settled).toBe(false);
    mined = true;
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(sent).resolves.toEqual({ userOpHash: USER_OP_HASH, bundler: "circle" });
    expect(bundler.calls[0]).toBe("circle:send");
    expect(bundler.calls.slice(1).every((call) => call === "circle:receipt")).toBe(true);
  });

  it("raises a revert error, not 'network is busy', and tries no other bundler", async () => {
    const vaultExists = encodeErrorResult({ abi: czarVaultFactoryAbi, errorName: "VaultExists" });
    const bundler = acceptingBundler("circle", () => rpcReceipt(false, vaultExists));
    walletMocks.createBundlerClient.mockReturnValue(bundler.client);

    const failure = await sendOwnerUserOperation(PASSKEY, TARGET, "0x", {
      waitForInclusion: true,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/failed on-chain/);
    expect((failure as Error).message).not.toMatch(/network is busy/);
    expect(((failure as Error).cause as { data?: unknown }).data).toBe(vaultExists);
    expect(walletMocks.createBundlerClient).toHaveBeenCalledTimes(1);
  });

  it("raises a clear timeout error after the configured seconds", async () => {
    const bundler = acceptingBundler("circle", () => null);
    walletMocks.createBundlerClient.mockReturnValue(bundler.client);
    vi.useFakeTimers();

    let failure: unknown;
    const sent = sendOwnerUserOperation(PASSKEY, TARGET, "0x", { waitForInclusion: true }).catch(
      (error: unknown) => {
        failure = error;
      },
    );
    await vi.advanceTimersByTimeAsync((Number(RECEIPT_TIMEOUT_SECONDS) - 1) * 1_000);
    expect(failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    await sent;

    expect((failure as Error).message).toBe(
      "The network has not confirmed this change after 120 seconds. " +
        "Wait a minute and check before trying again.",
    );
    expect(walletMocks.createBundlerClient).toHaveBeenCalledTimes(1);
  });

  it("does not wait for a receipt unless asked", async () => {
    const bundler = acceptingBundler("circle", () => null);
    walletMocks.createBundlerClient.mockReturnValue(bundler.client);

    await expect(sendOwnerUserOperation(PASSKEY, TARGET, "0x")).resolves.toEqual({
      userOpHash: USER_OP_HASH,
      bundler: "circle",
    });
    expect(bundler.calls).toEqual(["circle:send"]);
  });
});

describe("normalizeP256LowS", () => {
  it("maps high-s signatures to the equivalent low-s form", () => {
    const signature = toSignature(1n, P256_ORDER - 1n);

    expect(normalizeP256LowS(signature)).toBe(toSignature(1n, 1n));
  });

  it("keeps an already low-s signature unchanged", () => {
    const signature = toSignature(1n, P256_ORDER / 2n);

    expect(normalizeP256LowS(signature)).toBe(signature);
  });

  it.each(["0x12", `0x${"00".repeat(64)}`, toSignature(1n, P256_ORDER)])(
    "rejects malformed or out-of-range signatures: %s",
    (signature) => {
      expect(() => normalizeP256LowS(signature as `0x${string}`)).toThrow(
        "Passkey returned an invalid P-256 signature.",
      );
    },
  );
});

function toSignature(r: bigint, s: bigint): `0x${string}` {
  return `0x${r.toString(16).padStart(64, "0")}${s.toString(16).padStart(64, "0")}`;
}
