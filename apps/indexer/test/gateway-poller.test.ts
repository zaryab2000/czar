import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  type GatewayTransferInsert,
  type GatewayTransferRecord,
  pollGatewayTransfers,
  shouldApplyGatewayStatus,
} from "#src/gateway-poller";

const fixturePath = fileURLToPath(new URL("./fixtures/gateway/transfers.json", import.meta.url));
const recorded = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>[];
const pocket = "0xe5b81fb66503ab5df7ea62dc4fb2096570b90b55";

function memoryStore() {
  const transfers = new Map<string, GatewayTransferRecord>();
  const history: string[] = [];
  return {
    history,
    async find(transferId: string) {
      return transfers.get(transferId) ?? null;
    },
    async save(transfer: GatewayTransferInsert) {
      const row = transfer as GatewayTransferRecord;
      transfers.set(row.transferId, row);
      history.push(row.status);
    },
    all() {
      return [...transfers.values()];
    },
  };
}

function response(transfer: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ transfers: [transfer] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Gateway transfers polling", () => {
  it("keeps completed and failed statuses terminal", () => {
    expect(shouldApplyGatewayStatus("failed", "completed")).toBe(false);
    expect(shouldApplyGatewayStatus("completed", "failed")).toBe(false);
  });

  it("uses the configured Gateway API base URL", async () => {
    const fetcher = vi.fn().mockResolvedValue(response(recorded[0] ?? {}));
    await pollGatewayTransfers(
      { kind: "pocket", address: pocket },
      { pageSize: 100, timeoutMs: 8000, pocketAddresses: new Set([pocket]) },
      memoryStore(),
      { fetch: fetcher, log: vi.fn(), apiBase: "http://127.0.0.1:4999" },
    );
    const call = fetcher.mock.calls.at(0);
    if (!call) throw new Error("Gateway poll did not fetch a page");
    expect(call[0]).toBeInstanceOf(URL);
    expect((call[0] as URL).origin).toBe("http://127.0.0.1:4999");
  });

  it("tracks recorded statuses in order and ignores a stale batched response", async () => {
    const staleBatched = recorded[1];
    if (!staleBatched) throw new Error("Recorded batched fixture is missing");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(recorded[0] ?? {}))
      .mockResolvedValueOnce(response(recorded[1] ?? {}))
      .mockResolvedValueOnce(response(recorded[2] ?? {}))
      .mockResolvedValueOnce(response(staleBatched));
    const store = memoryStore();
    const log = vi.fn();

    for (let index = 0; index < 4; index += 1) {
      await pollGatewayTransfers(
        { kind: "pocket", address: pocket },
        { pageSize: 100, timeoutMs: 8000, pocketAddresses: new Set([pocket]) },
        store,
        { fetch: fetcher, log },
      );
    }

    expect(store.history).toEqual(["received", "batched", "completed"]);
    expect(store.all()).toMatchObject([
      { status: "completed", pocketAddress: pocket, amount: "1000" },
    ]);
    expect(log).toHaveBeenCalledWith("gateway_status_regression");
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("rejects a malformed page without writing any part of that page", async () => {
    const malformed = { ...recorded[1], fromAddress: "not-an-address" };
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ transfers: [recorded[0], malformed] }), { status: 200 }),
      );
    const store = memoryStore();

    const result = await pollGatewayTransfers(
      { kind: "pocket", address: pocket },
      { pageSize: 100, timeoutMs: 8000, pocketAddresses: new Set([pocket]) },
      store,
      { fetch: fetcher, log: vi.fn() },
    );

    expect(result).toEqual({ error: true });
    expect(store.all()).toEqual([]);
  });

  it("stops at a repeated next cursor and reports one walk error", async () => {
    const url = new URL("/v1/x402/transfers", "https://gateway-api-testnet.circle.com");
    url.searchParams.set("from", pocket);
    url.searchParams.set("pageSize", "100");
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ transfers: [recorded[0]] }), {
        status: 200,
        headers: { link: `<${url.href}>; rel="next"` },
      }),
    );
    const store = memoryStore();

    const result = await pollGatewayTransfers(
      { kind: "pocket", address: pocket },
      { pageSize: 100, timeoutMs: 8000, pocketAddresses: new Set([pocket]) },
      store,
      { fetch: fetcher, log: vi.fn() },
    );

    expect(result).toEqual({ error: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(store.history).toEqual(["received"]);
  });

  it("stops and reports an error for a malformed next-page link", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ transfers: [recorded[0]] }), {
        status: 200,
        headers: { link: "<not-a-url; rel=next" },
      }),
    );
    const store = memoryStore();

    const result = await pollGatewayTransfers(
      { kind: "pocket", address: pocket },
      { pageSize: 100, timeoutMs: 8000, pocketAddresses: new Set([pocket]) },
      store,
      { fetch: fetcher, log: vi.fn() },
    );

    expect(result).toEqual({ error: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(store.history).toEqual(["received"]);
  });

  it("uses the configured page size and follows a same-origin Link cursor", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ transfers: [recorded[0]] }), {
          status: 200,
          headers: {
            link: '</v1/x402/transfers?from=pocket&cursor=next>; rel="next"; title="next page"',
          },
        }),
      )
      .mockResolvedValueOnce(response(recorded[1] ?? {}));
    const store = memoryStore();

    const result = await pollGatewayTransfers(
      { kind: "pocket", address: pocket },
      { pageSize: 37, timeoutMs: 3210, pocketAddresses: new Set([pocket]) },
      store,
      { fetch: fetcher, log: vi.fn() },
    );
    const firstRequest = new URL(String(fetcher.mock.calls[0]?.[0]));
    const secondRequest = new URL(String(fetcher.mock.calls[1]?.[0]));

    expect(result).toEqual({ error: false });
    expect(firstRequest.searchParams.get("from")).toBe(pocket);
    expect(firstRequest.searchParams.get("pageSize")).toBe("37");
    expect(secondRequest.searchParams.get("cursor")).toBe("next");
    expect(secondRequest.searchParams.get("pageSize")).toBe("37");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
