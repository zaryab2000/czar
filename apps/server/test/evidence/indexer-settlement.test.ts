import { describe, expect, it, vi } from "vitest";
import {
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

describe("indexer settlement lookup", () => {
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
});
