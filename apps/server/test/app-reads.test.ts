import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import type { Address } from "viem";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { validateRecordedExchange } from "@czar/api-contract";
import type { AppPage, Envelope, EnvelopeDetail } from "@czar/schemas";
import { setupDatabase } from "#test/db";
import { createTestContext, seedDevice, TEST_USER_ID } from "#test/fixtures";
import { sumOpenEnvelopePockets } from "#src/app/reads";

const getPool = setupDatabase();
const APP_TOKEN = Buffer.alloc(32, 54).toString("base64url");
const FACTORY = "0xA624047E961D13bF49711e1383e7A3EBD3E25ef4" as Address;
const VAULT = "0x0000000000000000000000000000000000000011" as Address;
const MSCA = "0x0000000000000000000000000000000000000022" as Address;
const HASH = `0x${"1".repeat(64)}` as `0x${string}`;
const ENVELOPE_REF = `eip155:5042002:${VAULT.toLowerCase()}:1`;
const envelope: Envelope = {
  schemaVersion: "1.1",
  envelopeRef: ENVELOPE_REF,
  vault: VAULT,
  envelopeId: 1,
  objectiveHash: HASH,
  planHash: HASH,
  payeeRoot: HASH,
  categoryId: HASH,
  cap: "1000000",
  maxStepAmount: "1000000",
  pocketCapBps: 0,
  expiresAt: 1_800_000_000,
  approver: "owner",
  approvalTx: HASH,
  spent: "0",
  reserved: "0",
  pocketOutstanding: "0",
  jobEscrowed: "0",
  state: "Open",
  lastEventBlock: 1,
};
const detail: EnvelopeDetail = { envelope, reservations: [], pockets: [], jobs: [] };

describe("app read routes", () => {
  beforeAll(async () => seedDevice(getPool()));
  beforeEach(async () => {
    await getPool().query("DELETE FROM sessions");
    await getPool().query("UPDATE users SET msca=NULL,vault=NULL WHERE user_id=$1", [TEST_USER_ID]);
  });

  it("returns contract-valid Me with an uncreated predicted vault", async () => {
    const indexer = await startIndexer((url) => {
      if (url.pathname === "/vaults") return { status: 404, body: {} };
      return { status: 404, body: {} };
    });
    try {
      const pool = getPool();
      await seedAppSession(pool);
      await pool.query("UPDATE users SET msca=$2 WHERE user_id=$1", [TEST_USER_ID, MSCA]);
      const { app } = createTestContext(pool, { appReadOptions: readOptions(indexer.url) });
      const response = await app.request("/v1/me", { headers: appHeaders() });
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(response.headers.get("X-Czar-Bundler-Order")).toBe("circle,pimlico,alchemy,zerodev");
      expect(response.headers.get("X-Czar-Bundler-Endpoints")).toBe("{}");
      expect(body).toMatchObject({ vaultCreated: false, msca: MSCA, frozen: false, paused: false });
      expect(
        validateRecordedExchange("getMe", { responseStatus: response.status, responseBody: body })
          .valid,
      ).toBe(true);
    } finally {
      await indexer.close();
    }
  });

  it("lists envelopes, returns an owned envelope detail, and lists receipts", async () => {
    const indexer = await startIndexer((url) => {
      if (url.pathname === "/vaults") return { status: 200, body: { vault: VAULT } };
      if (url.pathname === "/envelopes" && url.searchParams.has("vault")) {
        return { status: 200, body: { items: [envelope], nextCursor: null } };
      }
      if (url.pathname === `/envelopes/${encodeURIComponent(ENVELOPE_REF)}`) {
        return { status: 200, body: detail };
      }
      if (url.pathname === "/receipts") {
        return { status: 200, body: { items: [], nextCursor: null } };
      }
      return { status: 404, body: {} };
    });
    try {
      const pool = getPool();
      await seedAppSession(pool);
      await pool.query("UPDATE users SET msca=$2 WHERE user_id=$1", [TEST_USER_ID, MSCA]);
      const { app } = createTestContext(pool, { appReadOptions: readOptions(indexer.url) });
      const headers = appHeaders();
      const list = await app.request("/v1/envelopes?limit=20", { headers });
      const listBody = (await list.json()) as AppPage<Envelope>;
      expect(list.status).toBe(200);
      expect(
        validateRecordedExchange("listEnvelopes", {
          responseStatus: list.status,
          responseBody: listBody,
        }).valid,
      ).toBe(true);
      expect(listBody.items).toHaveLength(1);

      const envelopeResponse = await app.request(
        `/v1/envelopes/${encodeURIComponent(ENVELOPE_REF)}`,
        { headers },
      );
      const envelopeBody = await envelopeResponse.json();
      expect(envelopeResponse.status).toBe(200);
      expect(
        validateRecordedExchange("getEnvelope", {
          responseStatus: envelopeResponse.status,
          responseBody: envelopeBody,
        }).valid,
      ).toBe(true);

      const receipts = await app.request("/v1/ledger/receipts", { headers });
      const receiptBody = await receipts.json();
      expect(receipts.status).toBe(200);
      expect(
        validateRecordedExchange("listReceipts", {
          responseStatus: receipts.status,
          responseBody: receiptBody,
        }).valid,
      ).toBe(true);
    } finally {
      await indexer.close();
    }
  });

  it("sums pocket balances only for open envelopes", async () => {
    const closedRef = `${ENVELOPE_REF}-closed`;
    const openEnvelope = { ...envelope, pocketOutstanding: "70" };
    const closedEnvelope = { ...envelope, envelopeRef: closedRef, state: "Closed" as const };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      if (url.pathname === "/envelopes") {
        return Response.json({ items: [openEnvelope, closedEnvelope], nextCursor: null });
      }
      const envelopeRef = decodeURIComponent(url.pathname.slice("/envelopes/".length));
      return Response.json({
        envelope: envelopeRef === ENVELOPE_REF ? openEnvelope : closedEnvelope,
        reservations: [],
        pockets: [{ outstanding: "70" }, { outstanding: "30" }],
        jobs: [],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(sumOpenEnvelopePockets("http://indexer.test", VAULT)).resolves.toBe(100n);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

async function seedAppSession(pool: ReturnType<typeof getPool>): Promise<void> {
  await pool.query("INSERT INTO sessions (token_hash,user_id,expires_at) VALUES ($1,$2,$3)", [
    createHash("sha256").update(APP_TOKEN).digest(),
    TEST_USER_ID,
    new Date("2030-01-01T00:00:00Z"),
  ]);
}

function appHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${APP_TOKEN}` };
}

function readOptions(indexerUrl: string) {
  return { rpcUrl: "http://127.0.0.1:8549", factoryAddress: FACTORY, indexerUrl };
}

async function startIndexer(
  respond: (url: URL) => { status: number; body: unknown },
): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const result = respond(new URL(request.url ?? "/", "http://127.0.0.1"));
    response.writeHead(result.status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(result.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Indexer test server failed to bind.");
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    close: async () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
