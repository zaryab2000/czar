// cross-cutting §2.1 (RV-022): every rule of safeFetch, including the SSRF corpus the spec lists.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSafeFetch,
  isBlockedAddress,
  SafeFetchError,
  type Transport,
} from "@czar/x402/safe-fetch";

const PUBLIC = "93.184.215.14";
const slow: Transport = () => new Promise(() => undefined);

/** A transport that records where it was asked to connect and answers from a script. */
function scripted(
  answers: Record<string, { status: number; headers?: Record<string, string>; body?: string }>,
) {
  const connections: {
    address: string;
    hostname: string;
    path: string;
    headers: Record<string, string>;
  }[] = [];
  const transport: Transport = async (target) => {
    connections.push({
      address: target.address,
      hostname: target.hostname,
      path: target.path,
      headers: target.headers,
    });
    const answer = answers[`${target.hostname}${target.path}`] ?? { status: 200, body: "ok" };
    const body = Buffer.from(answer.body ?? "");
    return {
      status: answer.status,
      headers: answer.headers ?? {},
      body: (async function* () {
        yield body;
      })(),
    };
  };
  return { transport, connections };
}

function fetcherWith(
  dns: Record<string, string[]>,
  transport: Transport,
  extra: Partial<Parameters<typeof createSafeFetch>[0]> = {},
) {
  const lookups: string[] = [];
  const safeFetch = createSafeFetch({
    resolve: async (host) => {
      lookups.push(host);
      const answers = dns[host];
      if (answers === undefined) throw new Error("ENOTFOUND");
      return answers.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
    transport,
    localMerchantOrigins: [],
    interfaceAddresses: () => ["192.0.2.10"],
    version: "0.0.0",
    maxRedirects: 3,
    maxBytes: 2 * 1024 * 1024,
    timeoutMs: 8000,
    ...extra,
  });
  return { safeFetch, lookups };
}

async function blockedRule(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof SafeFetchError) {
      expect(error.code).toBe("fetch-blocked");
      return error.rule;
    }
    throw error;
  }
  throw new Error("expected the fetch to be blocked");
}

describe("safeFetch SSRF corpus (cross-cutting §2.1)", () => {
  const { transport, connections } = scripted({});
  const { safeFetch } = fetcherWith(
    {
      "api.example.com": [PUBLIC],
      localhost: ["127.0.0.1"],
      "evil.example": ["10.0.0.5"],
      "mixed.example": [PUBLIC, "10.0.0.5"],
      "v6.example": ["fd00::1"],
    },
    transport,
  );

  it.each([
    ["http:// scheme", "http://api.example.com/x", "scheme"],
    ["port 8443", "https://api.example.com:8443/x", "port"],
    ["localhost", "https://localhost/x", "blocked-address"],
    ["127.1", "https://127.1/x", "blocked-address"],
    ["0x7f000001", "https://0x7f000001/x", "blocked-address"],
    ["[::ffff:127.0.0.1]", "https://[::ffff:127.0.0.1]/x", "blocked-address"],
    ["public name resolving to 10.0.0.5", "https://evil.example/x", "blocked-address"],
    ["one of several answers private", "https://mixed.example/x", "blocked-address"],
    ["ULA IPv6 answer", "https://v6.example/x", "blocked-address"],
    ["metadata address literal", "https://169.254.169.254/latest/meta-data", "blocked-address"],
    ["credentials in the URL", "https://user:pw@api.example.com/x", "credentials"],
    ["unresolvable name", "https://nowhere.example/x", "dns"],
    ["not a URL", "not a url", "url"],
  ])("refuses %s", async (_name, url, rule) => {
    const before = connections.length;
    expect(await blockedRule(() => safeFetch(url))).toBe(rule);
    expect(connections.length).toBe(before);
  });

  it("allows a public https URL and connects to the checked address with the original host", async () => {
    const response = await safeFetch("https://api.example.com/v1/search?q=1");
    expect(response.status).toBe(200);
    expect(connections.at(-1)).toMatchObject({
      address: PUBLIC,
      hostname: "api.example.com",
      path: "/v1/search?q=1",
    });
    expect(connections.at(-1)?.headers["user-agent"]).toBe("Czar/0.0.0");
    expect(connections.at(-1)?.headers["cookie"]).toBeUndefined();
  });
});

describe("DNS pinning", () => {
  it("resolves once per request; a second answer that would change is never used", async () => {
    let calls = 0;
    const { transport, connections } = scripted({});
    const safeFetch = createSafeFetch({
      resolve: async () => {
        calls += 1;
        return [{ address: calls === 1 ? PUBLIC : "127.0.0.1", family: 4 }];
      },
      transport,
      localMerchantOrigins: [],
      interfaceAddresses: () => [],
      version: "0.0.0",
      maxRedirects: 3,
      maxBytes: 1024,
      timeoutMs: 1000,
    });
    await safeFetch("https://rebind.example/x");
    expect(calls).toBe(1);
    expect(connections[0]?.address).toBe(PUBLIC);
  });
});

describe("redirects", () => {
  it("re-checks every target: a redirect from a public host to 169.254.169.254 is refused", async () => {
    const { transport, connections } = scripted({
      "api.example.com/start": {
        status: 302,
        headers: { location: "https://169.254.169.254/latest/meta-data/" },
      },
    });
    const { safeFetch } = fetcherWith({ "api.example.com": [PUBLIC] }, transport);
    expect(await blockedRule(() => safeFetch("https://api.example.com/start"))).toBe(
      "blocked-address",
    );
    expect(connections.map((c) => c.address)).toEqual([PUBLIC]);
  });

  it("follows at most fetch.maxRedirects (3)", async () => {
    const answers: Record<string, { status: number; headers: Record<string, string> }> = {};
    for (let i = 0; i < 5; i += 1)
      answers[`api.example.com/r${i}`] = { status: 301, headers: { location: `/r${i + 1}` } };
    const { transport, connections } = scripted(answers);
    const { safeFetch } = fetcherWith({ "api.example.com": [PUBLIC] }, transport);
    expect(await blockedRule(() => safeFetch("https://api.example.com/r0"))).toBe("max-redirects");
    expect(connections).toHaveLength(4);
  });

  it("follows a relative redirect within the limit and drops Authorization on a cross-origin hop", async () => {
    const { transport, connections } = scripted({
      "a.example/one": { status: 307, headers: { location: "https://b.example/two" } },
      "b.example/two": { status: 200, body: "done" },
    });
    const { safeFetch } = fetcherWith(
      { "a.example": [PUBLIC], "b.example": ["93.184.215.15"] },
      transport,
    );
    const response = await safeFetch("https://a.example/one", {
      authorization: { origin: "https://a.example", value: "Bearer t" },
    });
    expect(new TextDecoder().decode(response.body)).toBe("done");
    expect(connections[0]?.headers["authorization"]).toBe("Bearer t");
    expect(connections[1]?.headers["authorization"]).toBeUndefined();
  });
});

describe("limits", () => {
  it.each([
    ["ECONNREFUSED", "connection-refused"],
    ["ECONNRESET", "connection-reset"],
    ["ENETUNREACH", "network-unreachable"],
  ])("classifies %s without exposing transport details", async (code, outcome) => {
    const { safeFetch } = fetcherWith({ "api.example.com": [PUBLIC] }, async () => {
      throw Object.assign(new Error("private transport detail"), { code });
    });
    await expect(safeFetch("https://api.example.com/x")).rejects.toMatchObject({
      code: "upstream-unavailable",
      outcome,
      message: "upstream-unavailable: transport",
    });
  });

  it("keeps DNS failure outside seller-side outcomes", async () => {
    const { safeFetch } = fetcherWith({}, slow);
    await expect(safeFetch("https://missing.example/x")).rejects.toMatchObject({
      code: "fetch-blocked",
      rule: "dns",
    });
  });

  it("distinguishes a timeout after connection from one before connection", async () => {
    const connected = fetcherWith(
      { "api.example.com": [PUBLIC] },
      (target) => {
        target.onConnected?.();
        return new Promise(() => undefined);
      },
      { timeoutMs: 10 },
    );
    await expect(connected.safeFetch("https://api.example.com/x")).rejects.toMatchObject({
      outcome: "connected-timeout",
    });
    const before = fetcherWith({ "api.example.com": [PUBLIC] }, slow, { timeoutMs: 10 });
    await expect(before.safeFetch("https://api.example.com/x")).rejects.toMatchObject({
      outcome: "timeout-before-connect",
    });
  });

  it("classifies a local abort without blaming the seller", async () => {
    const { safeFetch } = fetcherWith({ "api.example.com": [PUBLIC] }, async () => {
      throw Object.assign(new Error("local"), { code: "ABORT_ERR" });
    });
    await expect(safeFetch("https://api.example.com/x")).rejects.toMatchObject({
      outcome: "local-abort",
    });
  });

  it("refuses a body over the caller's byte cap", async () => {
    const { transport } = scripted({
      "api.example.com/big": { status: 200, body: "x".repeat(2048) },
    });
    const { safeFetch } = fetcherWith({ "api.example.com": [PUBLIC] }, transport);
    expect(
      await blockedRule(() => safeFetch("https://api.example.com/big", { maxBytes: 1024 })),
    ).toBe("max-bytes");
  });

  it("times out as upstream-unavailable (retryable)", async () => {
    const { safeFetch } = fetcherWith({ "api.example.com": [PUBLIC] }, slow, { timeoutMs: 50 });
    await expect(safeFetch("https://api.example.com/slow")).rejects.toMatchObject({
      code: "upstream-unavailable",
      rule: "timeout",
    });
  });

  it("never sends Authorization to an origin the caller did not name", async () => {
    const { transport, connections } = scripted({});
    const { safeFetch } = fetcherWith({ "api.example.com": [PUBLIC] }, transport);
    await safeFetch("https://api.example.com/x", {
      authorization: { origin: "https://other.example", value: "Bearer t" },
    });
    expect(connections[0]?.headers["authorization"]).toBeUndefined();
  });

  it("caller headers cannot override cookie, host or user-agent", async () => {
    const { transport, connections } = scripted({});
    const { safeFetch } = fetcherWith({ "api.example.com": [PUBLIC] }, transport);
    await safeFetch("https://api.example.com/x", {
      headers: { cookie: "a=b", host: "evil", "user-agent": "x", "x-czar": "1" },
    });
    expect(connections[0]?.headers).toMatchObject({
      host: "api.example.com",
      "user-agent": "Czar/0.0.0",
      "x-czar": "1",
    });
    expect(connections[0]?.headers["cookie"]).toBeUndefined();
  });
});

describe("own interfaces and the local merchant exception", () => {
  it("refuses an address of the machine's own interfaces", async () => {
    const { transport } = scripted({});
    const { safeFetch } = fetcherWith({ "self.example": ["192.0.2.10"] }, transport);
    expect(await blockedRule(() => safeFetch("https://self.example/"))).toBe("blocked-address");
  });

  let server: Server;
  let origin: string;
  beforeAll(async () => {
    server = createServer((_req, res) => res.end("merchant"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("lets exactly a configured local merchant origin through, over the real transport", async () => {
    const safeFetch = createSafeFetch({
      localMerchantOrigins: [origin],
      interfaceAddresses: () => [],
      version: "0.0.0",
      maxRedirects: 3,
      maxBytes: 1024,
      timeoutMs: 2000,
    });
    const response = await safeFetch(`${origin}/v1/search`);
    expect(new TextDecoder().decode(response.body)).toBe("merchant");
    const otherPort = `http://127.0.0.1:${Number(origin.split(":").at(-1)) + 1}/`;
    expect(await blockedRule(() => safeFetch(otherPort))).toBe("scheme");
  });

  it("lets only configured local stand-in origins through", async () => {
    const safeFetch = createSafeFetch({
      localMerchantOrigins: [],
      localStandinOrigins: [origin],
      interfaceAddresses: () => [],
      version: "0.0.0",
      maxRedirects: 3,
      maxBytes: 1024,
      timeoutMs: 2000,
    });
    const response = await safeFetch(`${origin}/v1/balances`);
    expect(new TextDecoder().decode(response.body)).toBe("merchant");
    expect(await blockedRule(() => safeFetch("http://127.0.0.1:4998/v1/balances"))).toBe("scheme");
  });

  it("reports response arrival when the body stream resets after HTTP headers", async () => {
    const interrupted = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.flushHeaders();
      res.write("partial");
      setImmediate(() => res.socket?.destroy());
    });
    await new Promise<void>((resolve) => interrupted.listen(0, "127.0.0.1", resolve));
    const interruptedOrigin = `http://127.0.0.1:${(interrupted.address() as AddressInfo).port}`;
    const safeFetch = createSafeFetch({
      localMerchantOrigins: [interruptedOrigin],
      interfaceAddresses: () => [],
      version: "0.0.0",
      maxRedirects: 0,
      maxBytes: 1024,
      timeoutMs: 2000,
    });
    try {
      await expect(safeFetch(`${interruptedOrigin}/paid`)).rejects.toMatchObject({
        code: "upstream-unavailable",
        responseArrived: true,
      });
    } finally {
      await new Promise<void>((resolve) => interrupted.close(() => resolve()));
    }
  });
});

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "127.255.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.255.255",
    "0.0.0.0",
    "0.1.2.3",
    "224.0.0.1",
    "239.255.255.255",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fdff::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:7f00:1",
    "::127.0.0.1",
    "::ffff:169.254.169.254",
  ])("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    "93.184.215.14",
    "8.8.8.8",
    "172.32.0.1",
    "100.128.0.1",
    "2606:4700::1111",
    "::ffff:8.8.8.8",
  ])("allows %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe("createSafeFetchFromConfig", () => {
  it("reads fetch.* and treats an unset local origin list as empty", async () => {
    const { loadConfig } = await import("@czar/config");
    const { createSafeFetchFromConfig } = await import("@czar/x402/safe-fetch");
    const safeFetch = createSafeFetchFromConfig(loadConfig(), "0.0.0");
    await expect(safeFetch("http://127.0.0.1:4021/")).rejects.toMatchObject({
      code: "fetch-blocked",
      rule: "scheme",
    });
  });
});
