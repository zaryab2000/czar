import { describe, expect, it } from "vitest";
import type { ResultAck } from "@czar/schemas";
import { KEYCHAIN_ACCOUNTS } from "@czar/daemon";
import { ackResult } from "#src/results/ack-result";
import { memoryKeychain } from "#test/support";

const OBJECTIVE_ID = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const DEVICE_TOKEN = Buffer.alloc(32, 23).toString("base64url");
const IDEMPOTENCY_KEY = "7bd0c9be-b78e-4b24-a06c-7be2be7ef019";
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
      idempotencyKey: IDEMPOTENCY_KEY,
      fetcher: async (url, init) => {
        requestUrl = url;
        requestInit = init;
        return new Response(null, { status: 204 });
      },
    });

    expect(requestUrl?.toString()).toBe(
      `http://localhost/v1/objectives/${OBJECTIVE_ID}/results/ack`,
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
        fetcher: async () => {
          calls += 1;
          return new Response(null, { status: 204 });
        },
      }),
    ).rejects.toThrow(/pair this computer/i);
    expect(calls).toBe(0);
  });
});
