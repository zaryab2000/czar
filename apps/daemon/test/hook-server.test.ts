import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startHookServer, type IntakeState } from "@czar/daemon/hook-server";

const TOKEN = "k16-test-token-value";
let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
});

async function server(state: IntakeState = "observing", maxBodyBytes = 1024) {
  const events: Buffer[] = [];
  let discarded = 0;
  const started = await startHookServer({
    port: 0,
    maxBodyBytes,
    hookToken: () => TOKEN,
    state: () => state,
    onEvent: (body) => events.push(body),
    onDiscard: () => (discarded += 1),
  });
  close = started.close;
  return { port: started.port, events, discarded: () => discarded };
}

function post(
  port: number,
  headers: Record<string, string>,
  body = "{}",
  path = "/v1/hooks",
  method = "POST",
) {
  return new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

describe("hook endpoint (CZ-02 §4, D3-08)", () => {
  it("accepts a hook with the token and no Origin", async () => {
    const { port, events } = await server();
    expect(await post(port, auth, '{"hook_event_name":"PostToolUse"}')).toBe(202);
    expect(events.map(String)).toEqual(['{"hook_event_name":"PostToolUse"}']);
  });

  it("accepts Origin: null (hooks are not browsers)", async () => {
    const { port } = await server();
    expect(await post(port, { ...auth, origin: "null" })).toBe(202);
  });

  it("401 without the token or with a wrong token", async () => {
    const { port, events } = await server();
    expect(await post(port, { "content-type": "application/json" })).toBe(401);
    expect(await post(port, { authorization: "Bearer nope" })).toBe(401);
    expect(await post(port, { authorization: TOKEN })).toBe(401);
    expect(events).toHaveLength(0);
  });

  it("401 with a foreign Origin, even with the token", async () => {
    const { port } = await server();
    expect(await post(port, { ...auth, origin: "https://evil.example" })).toBe(401);
    expect(await post(port, { ...auth, origin: "http://localhost:3000" })).toBe(401);
  });

  it("401 when Host is not loopback (DNS rebinding)", async () => {
    const { port } = await server();
    expect(await post(port, { ...auth, host: `attacker.example:${port}` })).toBe(401);
    expect(await post(port, { ...auth, host: `localhost:${port}` })).toBe(202);
  });

  it("413 above daemon.maxHookBodyBytes", async () => {
    const { port } = await server("observing", 16);
    expect(await post(port, auth, "x".repeat(17))).toBe(413);
  });

  it("503 locked while the keychain is unavailable", async () => {
    const { port } = await server("locked");
    expect(await post(port, auth)).toBe(503);
  });

  it("202 and discard with a count while paused", async () => {
    const { port, events, discarded } = await server("paused");
    expect(await post(port, auth)).toBe(202);
    expect(events).toHaveLength(0);
    expect(discarded()).toBe(1);
  });

  it("404 for other paths and methods", async () => {
    const { port } = await server();
    expect(await post(port, auth, "{}", "/v1/other")).toBe(404);
    expect(await post(port, auth, "", "/v1/hooks", "GET")).toBe(404);
  });

  it("falls back to a free port when the configured one is busy", async () => {
    const first = await server();
    const second = await startHookServer({
      port: first.port,
      maxBodyBytes: 16,
      hookToken: () => TOKEN,
      state: () => "observing",
      onEvent: () => undefined,
    });
    expect(second.port).not.toBe(first.port);
    await second.close();
  });
});
