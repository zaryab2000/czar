import type { Keychain } from "#src/keychain";
import { AckResultError, ackResult, type ResultAckFetch } from "#src/results/ack-result";

export interface ManualAckInput {
  readonly objectiveId: string;
  readonly resultId: string;
  readonly writtenAt: string;
  readonly idempotencyKey: string;
  readonly keychain: Keychain;
  readonly fetcher?: ResultAckFetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Retries only network and server failures, using one stable key for every attempt. */
export async function acknowledgeManualResult(input: ManualAckInput): Promise<void> {
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await ackResult({
        objectiveId: input.objectiveId,
        resultAck: {
          resultId: input.resultId,
          writtenAt: input.writtenAt,
          surface: "claude-code-file",
        },
        keychain: input.keychain,
        serverOrigin: new URL("http://localhost"),
        idempotencyKey: input.idempotencyKey,
        ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
      });
      return;
    } catch (error) {
      if (
        !(error instanceof AckResultError) ||
        (error.status !== null && error.status < 500) ||
        attempt === 3
      )
        throw error;
      await sleep(250 * 2 ** (attempt - 1));
    }
  }
}
