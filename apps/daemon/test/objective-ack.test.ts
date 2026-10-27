import { describe, expect, it } from "vitest";
import { KEYCHAIN_ACCOUNTS } from "#src/keychain";
import { acknowledgeManualResult } from "#src/objective-ack";
import { memoryKeychain } from "#test/support";

const objectiveId = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const resultId = "res_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const writtenAt = "2026-10-27T00:00:00.000Z";
const idempotencyKey = "7bd0c9be-b78e-4b24-a06c-7be2be7ef019";

function pairedKeychain() {
  const keychain = memoryKeychain();
  keychain.set(KEYCHAIN_ACCOUNTS.deviceToken, Buffer.alloc(32, 23).toString("base64url"));
  return keychain;
}

describe("manual result acknowledgment", () => {
  it("retries 5xx with the same key and body, then succeeds", async () => {
    const requests: { key: string | null; body: string }[] = [];
    const delays: number[] = [];
    await acknowledgeManualResult({
      objectiveId,
      resultId,
      writtenAt,
      idempotencyKey,
      keychain: pairedKeychain(),
      sleep: async (ms) => {
        delays.push(ms);
      },
      fetcher: async (_url, init) => {
        requests.push({
          key: new Headers(init.headers).get("Idempotency-Key"),
          body: String(init.body),
        });
        return new Response(null, { status: requests.length < 3 ? 503 : 204 });
      },
    });
    expect(requests).toHaveLength(3);
    expect(new Set(requests.map((request) => request.key)).size).toBe(1);
    expect(requests[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(requests.map((request) => request.body)).size).toBe(1);
    expect(delays).toEqual([250, 500]);
  });

  it("stops on a 4xx response", async () => {
    let calls = 0;
    await expect(
      acknowledgeManualResult({
        objectiveId,
        resultId,
        writtenAt,
        idempotencyKey,
        keychain: pairedKeychain(),
        fetcher: async () => {
          calls += 1;
          return new Response(null, { status: 409 });
        },
      }),
    ).rejects.toThrow(/HTTP 409/);
    expect(calls).toBe(1);
  });
});
