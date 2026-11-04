import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("SCR-164 social API binding", () => {
  it("reads the public feed without an owner token and uses the server poll header", async () => {
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) =>
        key === "czar.appSession" ? "private-token" : "2099-01-01T00:00:00Z",
      removeItem: vi.fn(),
    });
    const fetchMock = vi.fn(
      async (_path: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ items: [], nextCursor: null }), {
          headers: { "X-Czar-Social-Poll-Seconds": "15" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { appApi } = await import("#src/app-api");

    await expect(appApi.listSocialFeed()).resolves.toEqual({
      page: { items: [], nextCursor: null },
      pollSeconds: 15,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/v1/social/feed");
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has("Authorization")).toBe(false);
  });

  it("rejects a missing or invalid social poll header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ items: [], nextCursor: null })),
    );
    const { appApi } = await import("#src/app-api");
    await expect(appApi.listSocialFeed()).rejects.toThrow("social feed timing");
  });

  it("does not clear an owner session when a public endpoint returns 401", async () => {
    const removeItem = vi.fn();
    vi.stubGlobal("sessionStorage", {
      getItem: () => "owner-token",
      removeItem,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    const { appApi } = await import("#src/app-api");

    await expect(appApi.getSocialThread("thr_missing")).rejects.toThrow();
    expect(removeItem).not.toHaveBeenCalled();
  });

  it("sends an owner token and idempotency key for mutations", async () => {
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) =>
        key === "czar.appSession" ? "owner-token" : "2099-01-01T00:00:00Z",
      removeItem: vi.fn(),
    });
    const fetchMock = vi.fn(
      async (_path: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { appApi } = await import("#src/app-api");

    await appApi.deleteSocialPost("pst_test");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/v1/social/posts/pst_test");
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Authorization")).toBe("Bearer owner-token");
    expect(headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
  });
});
