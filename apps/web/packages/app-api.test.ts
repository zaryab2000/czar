import { afterEach, describe, expect, it, vi } from "vitest";

const validConfig = {
  circleClientUrl: "https://wallet.example.test",
  circleClientKey: "public-e2e-key",
  arcRpcUrl: "https://rpc.example.test",
  bundlerOrder: ["circle", "pimlico", "alchemy", "zerodev"],
  bundlerEndpoints: {},
  vaultFactory: "0x00000000000000000000000000000000000000f1",
  webauthnRpId: "app.czar.example",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("getAppWalletConfig", () => {
  it("loads and validates fresh same-origin config without credentials or caching", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(validConfig), {
          status: 200,
          headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { getAppWalletConfig } = await import("#src/app-api");

    await expect(getAppWalletConfig()).resolves.toEqual(validConfig);
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/app/wallet-config",
      expect.objectContaining({
        cache: "no-store",
        credentials: "omit",
        mode: "same-origin",
      }),
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ Accept: "application/json" });
  });

  it("rejects missing values instead of using browser defaults", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ...validConfig, arcRpcUrl: "" }), {
          status: 200,
          headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { getAppWalletConfig } = await import("#src/app-api");

    await expect(getAppWalletConfig()).rejects.toThrow(
      "Czar received invalid wallet configuration.",
    );
  });

  it.each([
    ["no vault factory", { vaultFactory: undefined }],
    ["a malformed vault factory", { vaultFactory: "0x1234" }],
    ["no WebAuthn RP ID", { webauthnRpId: undefined }],
    ["an empty WebAuthn RP ID", { webauthnRpId: "" }],
    ["an RP ID with a scheme", { webauthnRpId: "https://app.czar.example" }],
  ])("rejects a config with %s (SCR-157 §3)", async (_label, change) => {
    const body = JSON.stringify({ ...validConfig, ...change });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(body, {
            status: 200,
            headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
          }),
      ),
    );
    const { getAppWalletConfig } = await import("#src/app-api");

    await expect(getAppWalletConfig()).rejects.toThrow(
      "Czar received invalid wallet configuration.",
    );
  });

  it("rejects a response without the no-store policy", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(validConfig), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { getAppWalletConfig } = await import("#src/app-api");

    await expect(getAppWalletConfig()).rejects.toThrow("Czar could not load wallet configuration.");
  });
});

describe("manual-return pagination", () => {
  it("collects every page without treating a partial count as the total", async () => {
    const { manualReturnsFixture } = await import("#src/summary-fixtures");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString(), "http://localhost");
      const secondPage = url.searchParams.get("cursor") === "next-page";
      return Response.json({
        items: secondPage ? [manualReturnsFixture[1]] : [manualReturnsFixture[0]],
        nextCursor: secondPage ? null : "next-page",
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { appApi } = await import("#src/app-api");

    await expect(appApi.listAllManualReturns()).resolves.toEqual({
      items: [manualReturnsFixture[0], manualReturnsFixture[1]],
      nextCursor: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("app results and ratings", () => {
  it("collects result cards across pages", async () => {
    const fetchMock = vi.fn(async (path: string) => {
      const cursor = path.includes("cursor=second") ? "second" : "first";
      return new Response(
        JSON.stringify({
          items: [{ objectiveId: cursor }],
          nextCursor: cursor === "first" ? "second" : null,
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const { appApi } = await import("#src/app-api");

    await expect(appApi.listAllAppResults()).resolves.toMatchObject({
      items: [{ objectiveId: "first" }, { objectiveId: "second" }],
      nextCursor: null,
    });
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/v1/app/results?",
      "/v1/app/results?cursor=second",
    ]);
  });

  it("returns the 202 rating body and sends the session and idempotency key", async () => {
    const accepted = {
      ratingId: "rtg_01J00000000000000000000000",
      objectiveId: "obj_01J00000000000000000000000",
      stepIndex: 0,
      value: "good",
      receipts: 1,
      windowClosesAt: "2026-11-01T00:00:00.000Z",
    };
    const storage = new Map([
      ["czar.appSession", "test-session"],
      ["czar.appSessionExpiresAt", "2099-01-01T00:00:00.000Z"],
    ]);
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      removeItem: (key: string) => storage.delete(key),
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(accepted), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const { appApi } = await import("#src/app-api");

    await expect(
      appApi.submitAppRating({ objectiveId: accepted.objectiveId, stepIndex: 0, value: "good" }),
    ).resolves.toEqual(accepted);
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(path).toBe("/v1/app/ratings");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      objectiveId: accepted.objectiveId,
      stepIndex: 0,
      value: "good",
    });
    expect(headers.get("Authorization")).toBe("Bearer test-session");
    expect(headers.get("Idempotency-Key")).toBeTruthy();
  });

  it("preserves empty 202 responses for submission notices", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 202 })),
    );
    const { appApi } = await import("#src/app-api");
    await expect(
      appApi.notifySubmitted("plan_01J00000000000000000000000", {
        userOpHash: `0x${"11".repeat(32)}`,
      }),
    ).resolves.toBeUndefined();
  });
});
