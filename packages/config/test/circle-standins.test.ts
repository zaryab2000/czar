import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "@czar/config";
import {
  handleStandinRequest,
  STANDIN_GATEWAY_WALLET,
  validateStandinStartup,
  type StandinOptions,
} from "../../../ops/local/circle-standins/server.ts";
import {
  harness,
  PAYEE as signerPayee,
  VAULT as signerVault,
} from "../../../apps/signer/test/helpers.ts";
import { derivedNonce } from "../../../packages/hashing/src/ids.ts";
import {
  addressToBytes32,
  transferSpecHash,
  type TransferSpec,
} from "../../../packages/hashing/src/eip712.ts";
import {
  CANONICAL_GATEWAY_MINTER,
  CANONICAL_GATEWAY_WALLET,
} from "../../../ops/local/gateway-doubles.ts";

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

  it("requires anvil_nodeInfo even when the configured service endpoints are HTTPS", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: { code: -32601 } })));
    await expect(
      validateStandinStartup(startup({ config: loadConfig(), fetchFn })),
    ).rejects.toThrow("did not answer anvil_nodeInfo");
    expect(fetchFn).toHaveBeenCalledOnce();
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
    let receiptCalls = 0;
    const rpc = vi.fn(async (method: string, _params: readonly unknown[]) => {
      if (method === "eth_accounts") return ["0x00000000000000000000000000000000000000a1"];
      if (method === "eth_sendTransaction") return txHash;
      if (method === "eth_getTransactionReceipt") {
        receiptCalls += 1;
        return receiptCalls === 1 ? null : { status: "0x1" };
      }
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
    expect(receiptCalls).toBe(2);
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
    const firstTransferBody = (await transferResponse.json()) as {
      transfers: { id: string; status: string; fromAddress: string }[];
    };
    expect(firstTransferBody.transfers[0]).toMatchObject({
      status: "completed",
      fromAddress: pocket,
    });
    const otherPocket = "0x00000000000000000000000000000000000000e2";
    const otherTransferResponse = await handleStandinRequest(
      new Request(`http://127.0.0.1:4999/v1/x402/transfers?from=${otherPocket}`),
      vi.fn(),
    );
    const otherTransferBody = (await otherTransferResponse.json()) as {
      transfers: { id: string }[];
    };
    expect(otherTransferBody.transfers[0]?.id).not.toBe(firstTransferBody.transfers[0]?.id);
    const repeatedResponse = await handleStandinRequest(
      new Request(`http://127.0.0.1:4999/v1/x402/transfers?from=${otherPocket}`),
      vi.fn(),
    );
    const repeatedBody = (await repeatedResponse.json()) as { transfers: { id: string }[] };
    expect(repeatedBody.transfers[0]?.id).toBe(otherTransferBody.transfers[0]?.id);
    const submitResponse = await handleStandinRequest(
      new Request("http://127.0.0.1:4999/v1/transfer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([{ burnIntent: {}, signature: "0x1234", contractSigner: true }]),
      }),
      vi.fn(),
    );
    expect(submitResponse.status).toBe(400);
    expect(await submitResponse.json()).toEqual({ error: "invalid_request" });
  });
});

function word(input: string | bigint): string {
  return (typeof input === "bigint" ? input.toString(16) : input.slice(2).toLowerCase()).padStart(
    64,
    "0",
  );
}

describe("SCR-150 local Gateway transfer and chain-backed balances", () => {
  it("reads the same canonical GatewayWallet address as the placement helper", () => {
    expect(STANDIN_GATEWAY_WALLET).toBe(CANONICAL_GATEWAY_WALLET);
  });

  const usdc = "0x3600000000000000000000000000000000000000";
  const wallet = CANONICAL_GATEWAY_WALLET;
  const minter = CANONICAL_GATEWAY_MINTER;
  const pocket = "0x00000000000000000000000000000000000000e1";
  const vault = "0x00000000000000000000000000000000000000ca";
  const controller = "0x00000000000000000000000000000000000000a1";
  const burnTx = `0x${"ab".repeat(32)}`;
  const value = 990_000n;
  const fee = 3_500n;
  const spec: TransferSpec = {
    version: 1,
    sourceDomain: 26,
    destinationDomain: 26,
    sourceContract: addressToBytes32(wallet as `0x${string}`),
    destinationContract: addressToBytes32(minter as `0x${string}`),
    sourceToken: addressToBytes32(usdc as `0x${string}`),
    destinationToken: addressToBytes32(usdc as `0x${string}`),
    sourceDepositor: addressToBytes32(pocket as `0x${string}`),
    destinationRecipient: addressToBytes32(vault as `0x${string}`),
    sourceSigner: addressToBytes32(vault as `0x${string}`),
    destinationCaller: `0x${"0".repeat(64)}`,
    value,
    salt: `0x${"5a".repeat(32)}`,
    hookData: "0x",
  };
  const transferRequest = (maxFee = "10000", overrides: Record<string, unknown> = {}) =>
    new Request("http://127.0.0.1:4999/v1/transfer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        {
          burnIntent: {
            maxBlockHeight: "1000",
            maxFee,
            spec: { ...spec, value: spec.value.toString(), ...overrides },
          },
          signature: `0x${"33".repeat(65)}`,
          contractSigner: true,
        },
      ]),
    });
  const chainRpc = (options: { code?: string; available?: bigint; status?: string } = {}) =>
    vi.fn(async (method: string, params: readonly unknown[]) => {
      if (method === "eth_getCode") return options.code ?? "0x6080";
      if (method === "eth_call") {
        const data = String((params[0] as { data?: string }).data);
        // burnRecord(bytes32): no record yet.
        if (data.startsWith(`0x${BURN_RECORD_SELECTOR}`)) return `0x${"0".repeat(64 * 4)}`;
        return `0x${(options.available ?? 5_000_000n).toString(16).padStart(64, "0")}`;
      }
      if (method === "eth_accounts") return [controller];
      if (method === "eth_sendTransaction") return burnTx;
      if (method === "eth_getTransactionReceipt") return { status: options.status ?? "0x1" };
      throw new Error(`unexpected ${method}`);
    });

  it("burns value + fee into the minter double and returns the local attestation", async () => {
    const rpc = chainRpc();
    const response = await handleStandinRequest(transferRequest(), rpc, usdc, {
      gatewayFeeAtomic: fee,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      attestation: string;
      signature: string;
      transferId: string;
    };
    const hash = transferSpecHash(spec);
    // abi.encode(bytes32, address, uint256, address): four static words.
    expect(body.attestation).toBe(`0x${hash.slice(2)}${word(vault)}${word(value)}${word(pocket)}`);
    expect(body.signature).toMatch(/^0x[\da-f]{130}$/);
    expect(body.transferId).toMatch(/^[\da-f-]{36}$/);
    const send = rpc.mock.calls.find(([method]) => method === "eth_sendTransaction");
    expect(send?.[1]).toEqual([
      {
        from: controller,
        to: wallet,
        // testBurnForTransferSpec(bytes32,address,address,uint256,address) selector 0x18508587 (viem).
        data: `0x${TEST_BURN_FOR_SPEC_SELECTOR}${transferSpecHash(spec).slice(2)}${word(usdc)}${word(pocket)}${word(value + fee)}${word(minter)}`,
      },
    ]);
  });

  it("refuses a burn above the available balance without sending a transaction", async () => {
    const rpc = chainRpc({ available: value + fee - 1n });
    const response = await handleStandinRequest(transferRequest(), rpc, usdc, {
      gatewayFeeAtomic: fee,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "insufficient_balance" });
    expect(rpc.mock.calls.some(([method]) => method === "eth_sendTransaction")).toBe(false);
  });

  it("refuses a max fee below the Gateway fee", async () => {
    const rpc = chainRpc();
    const response = await handleStandinRequest(transferRequest("3499"), rpc, usdc, {
      gatewayFeeAtomic: fee,
    });
    expect(await response.json()).toEqual({ error: "max_fee_too_low" });
  });

  it("reports a missing Gateway double as unavailable", async () => {
    const rpc = chainRpc({ code: "0x" });
    const response = await handleStandinRequest(transferRequest(), rpc, usdc, {
      gatewayFeeAtomic: fee,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "gateway_double_missing" });
  });

  it("rejects a token other than the configured USDC and a reverted burn", async () => {
    const other = addressToBytes32("0x00000000000000000000000000000000000000ee");
    const wrongToken = await handleStandinRequest(
      transferRequest("10000", { sourceToken: other, destinationToken: other }),
      chainRpc(),
      usdc,
      { gatewayFeeAtomic: fee },
    );
    expect(await wrongToken.json()).toEqual({ error: "unsupported_token" });
    const reverted = await handleStandinRequest(
      transferRequest(),
      chainRpc({ status: "0x0" }),
      usdc,
      {
        gatewayFeeAtomic: fee,
      },
    );
    expect(reverted.status).toBe(502);
    expect(await reverted.json()).toEqual({ error: "burn_failed" });
  });

  it("reads balances from the Gateway double when it is placed", async () => {
    const rpc = chainRpc({ available: 1_234_567n });
    const response = await handleStandinRequest(
      new Request("http://127.0.0.1:4999/v1/balances", {
        method: "POST",
        body: JSON.stringify({ token: "USDC", balances: [{ domain: 26, depositor: pocket }] }),
      }),
      rpc,
      usdc,
    );
    expect(await response.json()).toMatchObject({
      balances: [{ domain: 26, depositor: pocket, balance: "1.234567", pendingBatch: "0.000000" }],
    });
  });
});

// keccak256 selectors, computed with viem toFunctionSelector.
const TEST_BURN_FOR_SPEC_SELECTOR = "18508587"; // testBurnForTransferSpec(bytes32,address,address,uint256,address)
const BURN_RECORD_SELECTOR = "4f1a276d"; // burnRecord(bytes32)
const AVAILABLE_BALANCE_SELECTOR = "3ccb64ae"; // availableBalance(address,address)

type FakeBurn = { token: string; depositor: string; value: bigint; recipient: string };

function strip(hex: string): string {
  return hex.toLowerCase();
}

function addr(wordHex: string): string {
  return `0x${wordHex.slice(-40)}`;
}

/**
 * A stateful fake of the Gateway double on chain: `burnRecord`, `availableBalance` and
 * `testBurnForTransferSpec` with the same idempotency rules as MockGatewayWallet.sol.
 */
function fakeGatewayChain(initialAvailable: bigint, seeded: Record<string, FakeBurn> = {}) {
  const burns = new Map<string, FakeBurn>(Object.entries(seeded));
  const state = { available: initialAvailable, debits: 0, sends: 0 };
  const rpc = vi.fn(async (method: string, params: readonly unknown[]) => {
    if (method === "eth_getCode") return "0x6080";
    if (method === "eth_accounts") return ["0x00000000000000000000000000000000000000a1"];
    if (method === "eth_call") {
      const data = strip(String((params[0] as { data?: string }).data));
      if (data.startsWith(`0x${BURN_RECORD_SELECTOR}`)) {
        const record = burns.get(`0x${data.slice(10, 74)}`);
        if (!record) return `0x${"0".repeat(256)}`;
        return `0x${word(record.token)}${word(record.depositor)}${word(record.value)}${word(record.recipient)}`;
      }
      if (data.startsWith(`0x${AVAILABLE_BALANCE_SELECTOR}`)) {
        return `0x${state.available.toString(16).padStart(64, "0")}`;
      }
      throw new Error("unexpected eth_call");
    }
    if (method === "eth_sendTransaction") {
      state.sends += 1;
      const data = strip(String((params[0] as { data?: string }).data)).slice(10);
      const hash = `0x${data.slice(0, 64)}`;
      const call: FakeBurn = {
        token: addr(data.slice(64, 128)),
        depositor: addr(data.slice(128, 192)),
        value: BigInt(`0x${data.slice(192, 256)}`),
        recipient: addr(data.slice(256, 320)),
      };
      const existing = burns.get(hash);
      let status = "0x1";
      if (existing) {
        const same =
          existing.token === call.token &&
          existing.depositor === call.depositor &&
          existing.value === call.value &&
          existing.recipient === call.recipient;
        if (!same) status = "0x0";
      } else if (state.available < call.value) {
        status = "0x0";
      } else {
        burns.set(hash, call);
        state.available -= call.value;
        state.debits += 1;
      }
      return `0x${status === "0x1" ? "ab" : "cd"}${String(state.sends).padStart(62, "0")}`;
    }
    if (method === "eth_getTransactionReceipt") {
      const tx = String(params[0]);
      return { status: tx.startsWith("0xab") ? "0x1" : "0x0" };
    }
    throw new Error(`unexpected ${method}`);
  });
  return { rpc, state, burns };
}

describe("SCR-150 §4 transfer idempotency by transferSpecHash (PR #122 P1)", () => {
  const usdc = "0x3600000000000000000000000000000000000000";
  const pocket = "0x00000000000000000000000000000000000000e1";
  const vault = "0x00000000000000000000000000000000000000ca";
  const value = 990_000n;
  const fee = 3_500n;
  const spec: TransferSpec = {
    version: 1,
    sourceDomain: 26,
    destinationDomain: 26,
    sourceContract: addressToBytes32(CANONICAL_GATEWAY_WALLET as `0x${string}`),
    destinationContract: addressToBytes32(CANONICAL_GATEWAY_MINTER as `0x${string}`),
    sourceToken: addressToBytes32(usdc as `0x${string}`),
    destinationToken: addressToBytes32(usdc as `0x${string}`),
    sourceDepositor: addressToBytes32(pocket as `0x${string}`),
    destinationRecipient: addressToBytes32(vault as `0x${string}`),
    sourceSigner: addressToBytes32(vault as `0x${string}`),
    destinationCaller: `0x${"0".repeat(64)}`,
    value,
    salt: `0x${"6b".repeat(32)}`,
    hookData: "0x",
  };
  const request = () =>
    new Request("http://127.0.0.1:4999/v1/transfer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        {
          burnIntent: {
            maxBlockHeight: "1000",
            maxFee: "10000",
            spec: { ...spec, value: spec.value.toString() },
          },
          signature: `0x${"33".repeat(65)}`,
          contractSigner: true,
        },
      ]),
    });
  const expectedAttestation = `0x${transferSpecHash(spec).slice(2)}${word(vault)}${word(value)}${word(pocket)}`;

  it("a retry after a crash returns the same attestation with exactly one burn, even once drained", async () => {
    // The pocket holds exactly value + fee: after the first burn it is empty.
    const chain = fakeGatewayChain(value + fee);
    const first = await handleStandinRequest(request(), chain.rpc, usdc, { gatewayFeeAtomic: fee });
    expect(first.status).toBe(200);
    // The payer crashed before saving the response and resubmits the same burn intent.
    const retry = await handleStandinRequest(request(), chain.rpc, usdc, { gatewayFeeAtomic: fee });
    expect(retry.status).toBe(200);
    const [a, b] = [
      (await first.json()) as { attestation: string },
      (await retry.json()) as {
        attestation: string;
      },
    ];
    expect(a.attestation).toBe(expectedAttestation);
    expect(b.attestation).toBe(expectedAttestation);
    expect(chain.state.debits).toBe(1);
    expect(chain.state.sends).toBe(1);
    expect(chain.state.available).toBe(0n);
  });

  it("two concurrent requests for one spec burn once and return the same attestation", async () => {
    const chain = fakeGatewayChain(5_000_000n);
    const [x, y] = await Promise.all([
      handleStandinRequest(request(), chain.rpc, usdc, { gatewayFeeAtomic: fee }),
      handleStandinRequest(request(), chain.rpc, usdc, { gatewayFeeAtomic: fee }),
    ]);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect(((await x.json()) as { attestation: string }).attestation).toBe(expectedAttestation);
    expect(((await y.json()) as { attestation: string }).attestation).toBe(expectedAttestation);
    expect(chain.state.debits).toBe(1);
    expect(chain.state.sends).toBe(1);
  });

  it("a restarted stand-in (fresh process state) reuses the on-chain record and does not burn again", async () => {
    const chain = fakeGatewayChain(5_000_000n);
    await handleStandinRequest(request(), chain.rpc, usdc, { gatewayFeeAtomic: fee });
    vi.resetModules();
    const fresh = await import("../../../ops/local/circle-standins/server.ts");
    const response = await fresh.handleStandinRequest(request(), chain.rpc, usdc, {
      gatewayFeeAtomic: fee,
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { attestation: string }).attestation).toBe(
      expectedAttestation,
    );
    expect(chain.state.debits).toBe(1);
    expect(chain.state.sends).toBe(1);
  });

  it("a request whose spec hash was burned with different arguments is a conflict, with no burn", async () => {
    const hash = transferSpecHash(spec);
    const chain = fakeGatewayChain(5_000_000n, {
      [hash]: {
        token: usdc,
        depositor: pocket,
        value: value + fee + 1n,
        recipient: CANONICAL_GATEWAY_MINTER.toLowerCase(),
      },
    });
    const response = await handleStandinRequest(request(), chain.rpc, usdc, {
      gatewayFeeAtomic: fee,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "transfer_spec_conflict" });
    expect(chain.state.sends).toBe(0);
    expect(chain.state.debits).toBe(0);
  });
});
