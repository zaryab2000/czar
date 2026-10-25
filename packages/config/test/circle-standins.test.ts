import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "@czar/config";
import {
  handleStandinRequest,
  validateStandinStartup,
  type StandinOptions,
} from "../../../ops/local/circle-standins/server.ts";
import {
  harness,
  PAYEE as signerPayee,
  VAULT as signerVault,
} from "../../../apps/signer/test/helpers.ts";
import { derivedNonce } from "../../../packages/hashing/src/ids.ts";

const overlayPath = new URL("../../../env/local.toml", import.meta.url);
const localConfig = loadConfig({
  envFile: {
    "fetch.localStandinOrigins": ["http://127.0.0.1:4999"],
    "merchants.facilitatorBaseUrl": "http://127.0.0.1:4999",
    "chain.gatewayApiBaseUrl": "http://127.0.0.1:4999",
    "merchants.publicOrigin": "http://127.0.0.1:8787",
    "app.circleClientUrl": "http://127.0.0.1:4999",
    "app.arcRpcUrl": "http://127.0.0.1:8545",
  },
});
const startup = (overrides: Partial<StandinOptions> = {}): StandinOptions => ({
  config: localConfig,
  overlayPath,
  rpcUrl: "http://127.0.0.1:8545",
  bindAddress: "127.0.0.1",
  port: 4999,
  fetchFn: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })),
  ...overrides,
});
const txHash = `0x${"ab".repeat(32)}` as const;
const authorization = {
  from: "0x00000000000000000000000000000000000000b1",
  to: "0x00000000000000000000000000000000000000c1",
  value: "2500",
  validAfter: "0",
  validBefore: "2000000000",
  nonce: `0x${"22".repeat(32)}`,
};

function abiWord(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function settleRequest(signature: string, auth = authorization): Request {
  return new Request("http://127.0.0.1:4999/settle", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      x402Version: 2,
      paymentPayload: { payload: { signature, authorization: auth } },
      paymentRequirements: {
        asset: "0x3600000000000000000000000000000000000000",
        amount: auth.value,
        payTo: auth.to,
        network: "eip155:5042002",
      },
    }),
  });
}

async function signerPayment() {
  const signerHarness = await harness();
  const signed = await signerHarness.signer.sign("cz-15", {
    keyId: "K3",
    kind: "usdc-3009",
    payload: {
      vault: signerVault,
      reservationId: "12",
      index: "1",
      to: signerPayee,
      value: "100000",
      validBefore: "1760800600",
    },
  });
  if (!("signature" in signed)) throw new Error("signer did not return its USDC envelope");
  return {
    signature: signed.signature,
    authorization: {
      from: signerVault,
      to: signerPayee,
      value: "100000",
      validAfter: "0",
      validBefore: "1760800600",
      nonce: derivedNonce(signerVault, 12n, 1),
    },
  };
}

describe("D92 stand-in startup guards", () => {
  it("refuses a non-loopback process RPC", async () => {
    await expect(
      validateStandinStartup(startup({ rpcUrl: "https://rpc.arc.network" })),
    ).rejects.toThrow("Arc RPC must be loopback");
  });

  it("refuses an RPC that does not answer anvil_nodeInfo", async () => {
    await expect(
      validateStandinStartup(startup({ fetchFn: async () => new Response("{}") })),
    ).rejects.toThrow("did not answer anvil_nodeInfo");
  });

  it("refuses a non-loopback bind address", async () => {
    await expect(validateStandinStartup(startup({ bindAddress: "0.0.0.0" }))).rejects.toThrow(
      "bind address",
    );
  });

  it("refuses any overlay other than env/local.toml", async () => {
    await expect(
      validateStandinStartup(startup({ overlayPath: "/tmp/testnet.toml" })),
    ).rejects.toThrow("env/local.toml");
  });
});

describe("D92 Facilitator routes", () => {
  it("verifies the Facilitator request shape used by the merchant client", async () => {
    const response = await handleStandinRequest(
      new Request("http://127.0.0.1:4999/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          x402Version: 2,
          paymentPayload: {
            payload: {
              signature: `0x${"11".repeat(65)}`,
              authorization: {
                from: "0x00000000000000000000000000000000000000b1",
                to: "0x00000000000000000000000000000000000000c1",
                value: "2500",
                validAfter: "0",
                validBefore: "2000000000",
                nonce: `0x${"22".repeat(32)}`,
              },
            },
          },
          paymentRequirements: {
            asset: "0x3600000000000000000000000000000000000000",
            amount: "2500",
            payTo: "0x00000000000000000000000000000000000000c1",
            network: "eip155:5042002",
          },
        }),
      }),
      vi.fn(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      isValid: true,
      payer: "0x00000000000000000000000000000000000000b1",
    });
  });

  it("verifies the signer’s 416-byte ERC-1271 envelope", async () => {
    const payment = await signerPayment();
    const response = await handleStandinRequest(
      new Request("http://127.0.0.1:4999/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          x402Version: 2,
          paymentPayload: {
            payload: { signature: payment.signature, authorization: payment.authorization },
          },
          paymentRequirements: {
            asset: "0x3600000000000000000000000000000000000000",
            amount: payment.authorization.value,
            payTo: payment.authorization.to,
            network: "eip155:5042002",
          },
        }),
      }),
      vi.fn(),
    );
    expect(await response.json()).toMatchObject({ isValid: true, payer: signerVault });
  });

  it("settles by submitting transferWithAuthorization from an unlocked RPC account", async () => {
    const payment = await signerPayment();
    const rpc = vi.fn(async (method: string, _params: readonly unknown[]) => {
      if (method === "eth_accounts") return ["0x00000000000000000000000000000000000000a1"];
      if (method === "eth_sendTransaction") return txHash;
      if (method === "eth_getTransactionReceipt") return { status: "0x1" };
      return null;
    });
    const response = await handleStandinRequest(
      settleRequest(payment.signature, payment.authorization),
      rpc,
    );
    expect(await response.json()).toMatchObject({
      success: true,
      transaction: txHash,
      network: "eip155:5042002",
      payer: payment.authorization.from,
    });
    expect(rpc).toHaveBeenNthCalledWith(1, "eth_accounts", []);
    const call = rpc.mock.calls.at(1);
    if (!call) throw new Error("settle did not submit a transaction");
    const [method, params] = call;
    expect(method).toBe("eth_sendTransaction");
    const transaction = params[0] as { from: string; to: string; data: string };
    expect(transaction.from).toBe("0x00000000000000000000000000000000000000a1");
    expect(transaction.to).toBe("0x3600000000000000000000000000000000000000");
    expect(transaction.data.slice(0, 10)).toBe("0xcf092995");
    const data = transaction.data.slice(2);
    expect(data.slice(0, 8)).toBe("cf092995");
    expect(data.slice(8 + 6 * 64, 8 + 7 * 64)).toBe(abiWord(224n));
    const signatureOffset = Number.parseInt(data.slice(8 + 6 * 64, 8 + 7 * 64), 16);
    const signatureLengthStart = 8 + signatureOffset * 2;
    expect(data.slice(signatureLengthStart, signatureLengthStart + 64)).toBe(abiWord(416n));
    expect(data.slice(signatureLengthStart + 64, signatureLengthStart + 64 + 416 * 2)).toBe(
      payment.signature.slice(2),
    );
    expect(data.slice(8, 8 + 64)).toBe(payment.authorization.from.slice(2).padStart(64, "0"));
    expect(data.slice(8 + 64, 8 + 128)).toBe(payment.authorization.to.slice(2).padStart(64, "0"));
    expect(data.slice(8 + 2 * 64, 8 + 3 * 64)).toBe(abiWord(100000n));
    expect(data.slice(8 + 5 * 64, 8 + 6 * 64)).toBe(payment.authorization.nonce.slice(2));
    expect(rpc).toHaveBeenLastCalledWith("eth_getTransactionReceipt", [txHash]);
  });

  it.each([
    [null, 202, "settlement_pending"],
    [{ status: "0x0" }, 502, "transaction_reverted"],
  ])("does not claim settlement when RPC reports %j", async (receipt, status, errorReason) => {
    const rpc = vi.fn(async (method: string) => {
      if (method === "eth_accounts") return ["0x00000000000000000000000000000000000000a1"];
      if (method === "eth_sendTransaction") return txHash;
      return receipt;
    });
    const response = await handleStandinRequest(settleRequest(`0x${"11".repeat(65)}`), rpc);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ success: false, errorReason });
  });
});

describe("D92 Gateway fixture routes", () => {
  it("returns a pocket-specific balance and recorded transfer fixture", async () => {
    const pocket = "0x00000000000000000000000000000000000000e1";
    const balanceResponse = await handleStandinRequest(
      new Request("http://127.0.0.1:4999/v1/balances", {
        method: "POST",
        body: JSON.stringify({ token: "USDC", balances: [{ domain: 26, depositor: pocket }] }),
      }),
      vi.fn(),
    );
    expect(await balanceResponse.json()).toMatchObject({
      token: "USDC",
      balances: [{ domain: 26, depositor: pocket, balance: "0.001000" }],
    });
    const transferResponse = await handleStandinRequest(
      new Request(`http://127.0.0.1:4999/v1/x402/transfers?from=${pocket}`),
      vi.fn(),
    );
    expect(await transferResponse.json()).toMatchObject({
      transfers: [{ status: "completed", fromAddress: pocket }],
    });
    const submitResponse = await handleStandinRequest(
      new Request("http://127.0.0.1:4999/v1/transfer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([{ burnIntent: {}, signature: "0x1234", contractSigner: true }]),
      }),
      vi.fn(),
    );
    expect(await submitResponse.json()).toMatchObject({
      transferId: expect.any(String),
      attestation: expect.stringMatching(/^0x[\da-f]{64}$/),
      signature: expect.stringMatching(/^0x[\da-f]{130}$/),
    });
  });
});
