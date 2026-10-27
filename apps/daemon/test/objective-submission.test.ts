import { describe, expect, it } from "vitest";
import { objectiveHash, taskSpecHash } from "@czar/hashing";
import { validateSchema } from "@czar/schemas";
import { parseObjectiveOptions } from "#src/objective-options";
import { buildObjectiveSubmission } from "#src/objective-submission";

const objectiveId = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const deviceId = "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const soulVersionHash = `0x${"a".repeat(64)}`;

describe("manual objective submission", () => {
  it("passes the canonical schema and the server's recomputed hash", () => {
    const options = parseObjectiveOptions(
      ["Find prices", "--subject", "Acme", "--field", "monthly price", "--max-total", "500000"],
      ["web-search"],
    );
    const submission = buildObjectiveSubmission({
      redacted: { options, layer2: { hits: 0, entities: [] } },
      objectiveId,
      deviceId,
      soulVersionHash,
      submittedAt: "2026-10-27T00:00:00.000Z",
    });
    expect(validateSchema("objective-submission", submission)).toBe(true);
    expect(submission.constraints).toEqual({ maxTotal: "500000" });
    expect(submission.objectiveHash).toBe(
      objectiveHash({
        objectiveId,
        soulVersionHash,
        observationHashes: [],
        detector: "placeholder",
        goal: submission.goal,
        capabilities: submission.capabilities,
        minutesSaved: submission.minutesSaved,
        hourlyBand: submission.hourlyBand,
        taskSpecHash: taskSpecHash(submission.taskSpec),
      }),
    );
  });

  it("refuses an invalid device ID before any request", () => {
    const options = parseObjectiveOptions(
      ["Find prices", "--subject", "Acme", "--field", "monthly price"],
      ["web-search"],
    );
    expect(() =>
      buildObjectiveSubmission({
        redacted: { options, layer2: { hits: 0, entities: [] } },
        objectiveId,
        deviceId: "invalid",
        soulVersionHash,
        submittedAt: "2026-10-27T00:00:00.000Z",
      }),
    ).toThrow(/schema validation/);
  });
});
