import { describe, expect, it, vi } from "vitest";
import {
  AmbiguousTransferError,
  createIndexerExactTransferLookup,
  createIndexerGatewayStatus,
  createIndexerSettlement,
  verifyX402Transfer,
} from "#src/evidence/indexer-settlement";
import { encodeAbiParameters, encodeEventTopics } from "viem";

const payment = {
  schemaVersion: "1.0" as const,
  rail: "x402-exact" as const,
  network: "eip155:5042002",
  asset: "0x3600000000000000000000000000000000000000" as const,
  payer: "0x0000000000000000000000000000000000000001" as const,
  payTo: "0x0000000000000000000000000000000000000002" as const,
  amount: "1000",
  nonce: `0x${"11".repeat(32)}` as const,
  settlementTx: `0x${"22".repeat(32)}` as const,
  validBefore: 1_800_000_000,
  reservationId: 9,
  index: 2,
};
const indexedProof = {
  transferTx: payment.settlementTx,
  blockNumber: "10",
  blockHash: `0x${"44".repeat(32)}`,
  authorizationUsed: { logIndex: 0, emitter: payment.asset },
  transfer: {
    logIndex: 1,
    emitter: payment.asset,
    from: payment.payer,
    to: payment.payTo,
    value: payment.amount,
  },
  indexedHead: "11",
};

describe("indexer settlement lookup", () => {
  it("looks up an exact indexed transfer without changing the signed PaymentRef", async () => {
    let requestedUrl = "";
    const fetcher: typeof fetch = async (input) => {
      requestedUrl = String(input);
      return Response.json(indexedProof);
    };
    const lookup = createIndexerExactTransferLookup("http://indexer.test", 1_000, fetcher);
    const { settlementTx: _settlementTx, ...stablePayment } = payment;
    await expect(lookup(stablePayment)).resolves.toBe(payment.settlementTx);
    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/settlements/x402-transfer");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      network: payment.network,
      vault: payment.payer,
      nonce: payment.nonce,
      payTo: payment.payTo,
      amount: payment.amount,
      asset: payment.asset,
    });
    expect(stablePayment).not.toHaveProperty("settlementTx");
  });

  it("treats absent proof as pending and ambiguous proof as an error", async () => {
    const notFound = createIndexerExactTransferLookup("http://indexer.test", 1_000, async () =>
      Response.json({ czarCode: "not-found" }, { status: 404 }),
    );
    const ambiguous = createIndexerExactTransferLookup("http://indexer.test", 1_000, async () =>
      Response.json({ czarCode: "ambiguous" }, { status: 409 }),
    );
    await expect(notFound(payment)).resolves.toBeNull();
    await expect(ambiguous(payment)).rejects.toBeInstanceOf(AmbiguousTransferError);
  });

  it("treats indexer 5xx and transport outage as missing proof", async () => {
    const unavailable = createIndexerExactTransferLookup("http://indexer.test", 1_000, async () =>
      Response.json({ czarCode: "unavailable" }, { status: 503 }),
    );
    const unreachable = createIndexerExactTransferLookup("http://indexer.test", 1_000, async () => {
      throw new Error("network details must not escape");
    });
    await expect(unavailable(payment)).resolves.toBeNull();
    await expect(unreachable(payment)).resolves.toBeNull();
  });

  it("refuses an indexer response with a malformed transaction hash", async () => {
    const lookup = createIndexerExactTransferLookup("http://indexer.test", 1_000, async () =>
      Response.json({ ...indexedProof, transferTx: "not-a-transaction" }),
    );
    await expect(lookup(payment)).rejects.toThrow("invalid transfer transaction");
  });

  it("refuses indexer proof with a wrong canonical transfer payee", async () => {
    const lookup = createIndexerExactTransferLookup("http://indexer.test", 1_000, async () =>
      Response.json({
        ...indexedProof,
        transfer: { ...indexedProof.transfer, to: payment.payer },
      }),
    );
    await expect(lookup(payment)).rejects.toThrow("invalid transfer proof");
  });

  it("matches the full vault authorization facts and requires settled status", async () => {
    let requestedUrl = "";
    const fetcher: typeof fetch = async (input) => {
      requestedUrl = String(input);
      return Response.json({
        items: [
          {
            rail: "x402-exact",
            payer: payment.payer,
            payee: payment.payTo,
            nonce: payment.nonce,
            amount: payment.amount,
            settlementTx: `0x${"33".repeat(32)}`,
            status: "settled",
          },
        ],
        nextCursor: null,
      });
    };
    const verifyTransfer = vi.fn(async () => true);
    const settlement = createIndexerSettlement(
      "http://indexer.test",
      50,
      1_000,
      verifyTransfer,
      fetcher,
    );

    await expect(settlement.isSettled(payment)).resolves.toBe(true);
    expect(verifyTransfer).toHaveBeenCalledWith(payment);
    expect(requestedUrl).toContain("vault=0x0000000000000000000000000000000000000001");
  });

  it("does not accept a matching authorization until the indexer marks it settled", async () => {
    const fetcher: typeof fetch = async () =>
      Response.json({
        items: [
          {
            rail: "x402-exact",
            payer: payment.payer,
            nonce: payment.nonce,
            amount: payment.amount,
            status: "reserved",
          },
        ],
        nextCursor: null,
      });
    const settlement = createIndexerSettlement(
      "http://indexer.test",
      50,
      1_000,
      async () => true,
      fetcher,
    );

    await expect(settlement.isSettled(payment)).resolves.toBe(false);
  });

  it("rejects a settled authorization paid to a different payee", async () => {
    const fetcher: typeof fetch = async () =>
      Response.json({
        items: [
          {
            rail: "x402-exact",
            payer: payment.payer,
            payee: "0x0000000000000000000000000000000000000003",
            nonce: payment.nonce,
            amount: payment.amount,
            status: "settled",
          },
        ],
        nextCursor: null,
      });
    const settlement = createIndexerSettlement(
      "http://indexer.test",
      50,
      1_000,
      async () => true,
      fetcher,
    );

    await expect(settlement.isSettled(payment)).resolves.toBe(false);
  });

  it("rejects a matching indexer fact when the transfer transaction lacks proof", async () => {
    const fetcher: typeof fetch = async () =>
      Response.json({
        items: [
          {
            rail: "x402-exact",
            payer: payment.payer,
            payee: payment.payTo,
            nonce: payment.nonce,
            amount: payment.amount,
            status: "settled",
          },
        ],
        nextCursor: null,
      });
    const settlement = createIndexerSettlement(
      "http://indexer.test",
      50,
      1_000,
      async () => false,
      fetcher,
    );

    await expect(settlement.isSettled(payment)).resolves.toBe(false);
  });

  it("reads Gateway transfer status from the vault ledger", async () => {
    const fetcher: typeof fetch = async () =>
      Response.json({
        items: [
          {
            rail: "gateway-batched",
            payer: "0x0000000000000000000000000000000000000005",
            nonce: payment.nonce,
            transferId: "tr_1",
            status: "completed",
          },
        ],
        nextCursor: null,
      });
    const status = createIndexerGatewayStatus(
      "http://indexer.test",
      payment.payer,
      50,
      1_000,
      fetcher,
    );

    await expect(
      status({
        pocket: "0x0000000000000000000000000000000000000005",
        nonce: payment.nonce,
        transferId: "tr_1",
      }),
    ).resolves.toBe("completed");
  });

  it("verifies the facilitator transaction's USDC Transfer independently", async () => {
    const transferAbi = [
      {
        type: "event",
        name: "Transfer",
        anonymous: false,
        inputs: [
          { name: "from", type: "address", indexed: true },
          { name: "to", type: "address", indexed: true },
          { name: "value", type: "uint256", indexed: false },
        ],
      },
    ] as const;
    const topics = encodeEventTopics({
      abi: transferAbi,
      eventName: "Transfer",
      args: { from: payment.payer, to: payment.payTo },
    });
    const data = encodeAbiParameters([{ type: "uint256" }], [BigInt(payment.amount)]);
    const authorizationAbi = [
      {
        type: "event",
        name: "AuthorizationUsed",
        anonymous: false,
        inputs: [
          { name: "authorizer", type: "address", indexed: true },
          { name: "nonce", type: "bytes32", indexed: true },
        ],
      },
    ] as const;
    const authorizationTopics = encodeEventTopics({
      abi: authorizationAbi,
      eventName: "AuthorizationUsed",
      args: { authorizer: payment.payer, nonce: payment.nonce },
    });
    const client = {
      getTransactionReceipt: vi.fn(async () => ({
        status: "success",
        logs: [
          { address: payment.asset, topics, data },
          { address: payment.asset, topics: authorizationTopics, data: "0x" },
        ],
      })),
    };

    await expect(verifyX402Transfer(client as never, payment)).resolves.toBe(true);
    expect(client.getTransactionReceipt).toHaveBeenCalledWith({ hash: payment.settlementTx });
  });

  it("requires AuthorizationUsed for the PaymentRef nonce in the transfer transaction", async () => {
    const transferAbi = [
      {
        type: "event",
        name: "Transfer",
        anonymous: false,
        inputs: [
          { name: "from", type: "address", indexed: true },
          { name: "to", type: "address", indexed: true },
          { name: "value", type: "uint256", indexed: false },
        ],
      },
    ] as const;
    const topics = encodeEventTopics({
      abi: transferAbi,
      eventName: "Transfer",
      args: { from: payment.payer, to: payment.payTo },
    });
    const data = encodeAbiParameters([{ type: "uint256" }], [BigInt(payment.amount)]);
    const client = {
      getTransactionReceipt: vi.fn(async () => ({
        status: "success",
        logs: [{ address: payment.asset, topics, data }],
      })),
    };

    await expect(verifyX402Transfer(client as never, payment)).resolves.toBe(false);
  });

  it.each([
    ["nonce", { nonce: `0x${"33".repeat(32)}` }],
    ["payer", { payer: "0x0000000000000000000000000000000000000003" }],
    ["payee", { payTo: "0x0000000000000000000000000000000000000003" }],
    ["amount", { amount: "1001" }],
  ])("rejects a transfer with the wrong %s", async (_field, changed) => {
    const authorizationAbi = [
      {
        type: "event",
        name: "AuthorizationUsed",
        anonymous: false,
        inputs: [
          { name: "authorizer", type: "address", indexed: true },
          { name: "nonce", type: "bytes32", indexed: true },
        ],
      },
    ] as const;
    const transferAbi = [
      {
        type: "event",
        name: "Transfer",
        anonymous: false,
        inputs: [
          { name: "from", type: "address", indexed: true },
          { name: "to", type: "address", indexed: true },
          { name: "value", type: "uint256", indexed: false },
        ],
      },
    ] as const;
    const client = {
      getTransactionReceipt: vi.fn(async () => ({
        status: "success",
        logs: [
          {
            address: payment.asset,
            topics: encodeEventTopics({
              abi: authorizationAbi,
              eventName: "AuthorizationUsed",
              args: { authorizer: payment.payer, nonce: payment.nonce },
            }),
            data: "0x",
          },
          {
            address: payment.asset,
            topics: encodeEventTopics({
              abi: transferAbi,
              eventName: "Transfer",
              args: { from: payment.payer, to: payment.payTo },
            }),
            data: encodeAbiParameters([{ type: "uint256" }], [BigInt(payment.amount)]),
          },
        ],
      })),
    };
    await expect(verifyX402Transfer(client as never, { ...payment, ...changed })).resolves.toBe(
      false,
    );
  });
});
