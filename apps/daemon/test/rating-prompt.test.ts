import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryDatabase, type MemoryDatabase } from "#src/database";
import { runRatingPrompt } from "#src/results/rating-prompt";

const objectiveId = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const ratingId = "rtg_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const timestamp = "2026-10-31T00:00:00.000Z";

function step(overrides: Record<string, unknown> = {}) {
  return {
    stepIndex: 0,
    merchantLabel: "example.com",
    merchantIsCzar: false,
    receipts: 2,
    effectiveRating: "none",
    canRate: true,
    canCorrect: false,
    ...overrides,
  };
}

function server(steps: readonly Record<string, unknown>[]) {
  const calls: { path: string; init: RequestInit }[] = [];
  const fetcher = async (url: URL, init: RequestInit): Promise<Response> => {
    calls.push({ path: url.pathname, init });
    if (init.method === "GET") {
      return Response.json({
        objectiveId,
        deliveredAt: timestamp,
        windowClosesAt: "2026-11-14T00:00:00.000Z",
        steps,
      });
    }
    const request = JSON.parse(String(init.body)) as { value: string; stepIndex: number };
    return Response.json({
      ratingId,
      objectiveId,
      stepIndex: request.stepIndex,
      value: request.value,
      receipts: 2,
      windowClosesAt: "2026-11-14T00:00:00.000Z",
    }, { status: 202 });
  };
  return { calls, fetcher };
}

describe("CLI rating prompt", () => {
  let database: MemoryDatabase;
  beforeEach(() => {
    database = openMemoryDatabase(join(mkdtempSync(join(tmpdir(), "czar-rating-")), "memory.db"),
      "0f".repeat(32));
  });
  afterEach(() => database.close());

  function deps(fetcher: ReturnType<typeof server>["fetcher"], answers: string[], lines: string[]) {
    return {
      database,
      deviceToken: "T".repeat(43),
      serverOrigin: new URL("http://127.0.0.1:3000"),
      fetcher,
      print: (line: string) => lines.push(line),
      ask: async (prompt: string) => {
        lines.push(prompt);
        return answers.shift() ?? "";
      },
    };
  }

  it("prompts each eligible producing step and posts good with one audit row", async () => {
    const api = server([step(), step({ stepIndex: 1, merchantLabel: "other.example" })]);
    const lines: string[] = [];
    await runRatingPrompt(objectiveId, deps(api.fetcher, ["g", ""], lines));
    expect(lines).toEqual([
      "Was the result from example.com good?  [g] good  [b] bad  [enter] skip",
      "Thanks. Czar will rank example.com higher for tasks like this.",
      "Was the result from other.example good?  [g] good  [b] bad  [enter] skip",
    ]);
    const posts = api.calls.filter((call) => call.init.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.path).toBe("/v1/ratings");
    expect(JSON.parse(String(posts[0]?.init.body))).toEqual({
      objectiveId, stepIndex: 0, value: "good",
    });
    expect(new Headers(posts[0]?.init.headers).get("Idempotency-Key")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(database.prepare("SELECT kind,destination,bytes,summary_counts_json FROM audit_local")
      .all()).toEqual([{ kind: "rating", destination: "server",
      bytes: Buffer.byteLength(String(posts[0]?.init.body)),
      summary_counts_json: '{"ratings":1}' }]);
  });

  it("posts bad only for b and leaves no audit row for other keys", async () => {
    const api = server([step(), step({ stepIndex: 1 })]);
    const lines: string[] = [];
    await runRatingPrompt(objectiveId, deps(api.fetcher, ["x", "b"], lines));
    const posts = api.calls.filter((call) => call.init.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]?.init.body))).toEqual({
      objectiveId, stepIndex: 1, value: "bad",
    });
    expect(lines.at(-1)).toBe("Thanks. Czar will rank example.com lower for tasks like this.");
  });

  it("offers one correction for an existing rating and sends supersedes", async () => {
    const api = server([step({ effectiveRating: "good", ratingId, canRate: false,
      canCorrect: true })]);
    const lines: string[] = [];
    await runRatingPrompt(objectiveId, deps(api.fetcher, ["c", "b"], lines));
    expect(lines[0]).toContain("Current rating for example.com: good");
    expect(lines[0]).toContain("[c] change");
    const post = api.calls.find((call) => call.init.method === "POST");
    expect(JSON.parse(String(post?.init.body))).toEqual({ objectiveId,
      stepIndex: 0, value: "bad", supersedes: ratingId });
  });

  it("shows a closed correction without posting", async () => {
    const api = server([step({ effectiveRating: "bad", ratingId, canRate: false,
      canCorrect: false })]);
    const lines: string[] = [];
    await runRatingPrompt(objectiveId, deps(api.fetcher, ["c"], lines));
    expect(lines).toEqual(["Current rating for example.com: bad."]);
    expect(api.calls).toHaveLength(1);
  });
});
