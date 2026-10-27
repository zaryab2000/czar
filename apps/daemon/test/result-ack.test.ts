import { describe, expect, it } from "vitest";
import { loadConfig } from "@czar/config";
import type { ResultAck } from "@czar/schemas";
import { KEYCHAIN_ACCOUNTS } from "@czar/daemon";
import { ackResult } from "#src/results/ack-result";
import { memoryKeychain } from "#test/support";

const OBJECTIVE_ID = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const DEVICE_TOKEN = Buffer.alloc(32, 23).toString("base64url");
const IDEMPOTENCY_KEY = "7bd0c9be-b78e-4b24-a06c-7be2be7ef019";
const CONFIG = loadConfig({
  envFile: {
    "daemon.outboxRetryBaseS": 1,
    "writeback.ackRetryMaxS": 4,
  },
});
const ACK: ResultAck = {
  resultId: "res_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
  writtenAt: "2026-10-21T00:00:00.000Z",
  surface: "claude-code-file",
};

describe("result acknowledgement client", () => {
  it("posts the validated acknowledgement using the keychain device token", async () => {
    const keychain = memoryKeychain();
    keychain.set(KEYCHAIN_ACCOUNTS.deviceToken, DEVICE_TOKEN);
    let requestUrl: URL | undefined;
    let requestInit: RequestInit | undefined;
    await ackResult({
      objectiveId: OBJECTIVE_ID,
      resultAck: ACK,
      keychain,
      config: CONFIG,
      serverOrigin: new URL("http://127.0.0.1:3000"),
      idempotencyKey: IDEMPOTENCY_KEY,
      fetcher: async (url, init) => {
        requestUrl = url;
        requestInit = init;
        return new Response(null, { status: 204 });
      },
    });

    expect(requestUrl?.toString()).toBe(
      `http://127.0.0.1:3000/v1/objectives/${OBJECTIVE_ID}/results/ack`,
    );
    expect(requestInit?.method).toBe("POST");
    expect(requestInit?.headers).toMatchObject({
      Authorization: `Bearer ${DEVICE_TOKEN}`,
      "Content-Type": "application/json",
      "Idempotency-Key": IDEMPOTENCY_KEY,
    });
    expect(JSON.parse(String(requestInit?.body))).toEqual(ACK);
  });

  it("does not send without a paired device token", async () => {
    let calls = 0;
    await expect(
      ackResult({
        objectiveId: OBJECTIVE_ID,
        resultAck: ACK,
        keychain: memoryKeychain(),
        config: CONFIG,
        idempotencyKey: IDEMPOTENCY_KEY,
        serverOrigin: new URL("http://127.0.0.1:3000"),
        fetcher: async () => {
          calls += 1;
          return new Response(null, { status: 204 });
        },
      }),
    ).rejects.toThrow(/pair this computer/i);
    expect(calls).toBe(0);
  });

  it("rejects a server URL that contains a path", async () => {
    const keychain = memoryKeychain();
    keychain.set(KEYCHAIN_ACCOUNTS.deviceToken, DEVICE_TOKEN);
    await expect(
      ackResult({
        objectiveId: OBJECTIVE_ID,
        resultAck: ACK,
        keychain,
        config: CONFIG,
        idempotencyKey: IDEMPOTENCY_KEY,
        serverOrigin: new URL("http://127.0.0.1:3000/api"),
        fetcher: async () => new Response(null, { status: 204 }),
      }),
    ).rejects.toThrow(/origin must be an http\(s\) origin/i);
  });

  it("retries network and server failures with the same idempotency key", async () => {
    const keychain = pairedKeychain();
    const delays: number[] = [];
    const keys: unknown[] = [];
    let calls = 0;
    await ackResult({
      objectiveId: OBJECTIVE_ID,
      resultAck: ACK,
      keychain,
      config: CONFIG,
      serverOrigin: new URL("http://127.0.0.1:3000"),
      idempotencyKey: IDEMPOTENCY_KEY,
      sleep: async (milliseconds) => void delays.push(milliseconds),
      fetcher: async (_url, init) => {
        calls += 1;
        keys.push((init.headers as Record<string, string>)["Idempotency-Key"]);
        if (calls === 1) throw new Error("network unavailable");
        if (calls === 2) return new Response(null, { status: 503 });
        return new Response(null, { status: 204 });
      },
    });
    expect(calls).toBe(3);
    expect(delays).toEqual([1000, 2000]);
    expect(keys).toEqual([IDEMPOTENCY_KEY, IDEMPOTENCY_KEY, IDEMPOTENCY_KEY]);
  });

  it("stops on a client error without retrying", async () => {
    const keychain = pairedKeychain();
    const delays: number[] = [];
    let calls = 0;
    await expect(
      ackResult({
        objectiveId: OBJECTIVE_ID,
        resultAck: ACK,
        keychain,
        config: CONFIG,
        idempotencyKey: IDEMPOTENCY_KEY,
        serverOrigin: new URL("http://127.0.0.1:3000"),
        sleep: async (milliseconds) => void delays.push(milliseconds),
        fetcher: async () => {
          calls += 1;
          return new Response(null, { status: 401 });
        },
      }),
    ).rejects.toThrow(/HTTP 401/);
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it("makes three retries after repeated server errors", async () => {
    const keychain = pairedKeychain();
    const delays: number[] = [];
    let calls = 0;
    await expect(
      ackResult({
        objectiveId: OBJECTIVE_ID,
        resultAck: ACK,
        keychain,
        config: CONFIG,
        idempotencyKey: IDEMPOTENCY_KEY,
        serverOrigin: new URL("http://127.0.0.1:3000"),
        sleep: async (milliseconds) => void delays.push(milliseconds),
        fetcher: async () => {
          calls += 1;
          return new Response(null, { status: 503 });
        },
      }),
    ).rejects.toThrow(/HTTP 503/);
    expect(calls).toBe(4);
    expect(delays).toEqual([1000, 2000, 4000]);
  });
});

function pairedKeychain() {
  const keychain = memoryKeychain();
  keychain.set(KEYCHAIN_ACCOUNTS.deviceToken, DEVICE_TOKEN);
  return keychain;
}
