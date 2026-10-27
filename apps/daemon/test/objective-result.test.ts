import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deliverManualResult } from "#src/objective-result";
import { openMemoryDatabase } from "#src/database";

const objectiveId = "obj_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const resultId = "res_01K7ZT9P4N5Q6R7S8T9V0W1X2Y";
const result = {
  resultId,
  objectiveId,
  mimeType: "text/markdown",
  body: "## From merchant.example\nThe served body.\n",
  provenance: [],
  createdAt: "2026-10-27T00:00:00.000Z",
};

describe("manual result write-back", () => {
  it("writes the served body once and acknowledges on retry", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "czar-result-"));
    const database = openMemoryDatabase(join(projectRoot, "memory.db"), "0f".repeat(32));
    const printed: string[] = [];
    const acknowledgments: string[] = [];
    const input = {
      objectiveId,
      resultId,
      token: "opaque-token",
      projectRoot,
      database,
      print: (line: string) => printed.push(line),
      acknowledge: async (id: string, acknowledgedResultId: string) => {
        expect(id).toBe(objectiveId);
        acknowledgments.push(acknowledgedResultId);
      },
      fetcher: async (url: URL, init: RequestInit) => {
        expect(url.pathname).toBe(`/v1/results/${resultId}`);
        expect(new Headers(init.headers).get("Authorization")).toBe("Bearer opaque-token");
        return Response.json(result);
      },
    };
    try {
      await deliverManualResult(input);
      await deliverManualResult(input);
    } finally {
      database.close();
    }
    const path = join(projectRoot, ".czar", "results", `${objectiveId}.md`);
    const file = readFileSync(path, "utf8");
    expect(file).toMatch(/^<!-- czar:result v=1 objective=obj_/);
    expect(file.endsWith(result.body)).toBe(true);
    expect(acknowledgments).toEqual([resultId]);
    expect(printed).toEqual([path, path]);
  });

  it("refuses to overwrite a user file and does not acknowledge", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "czar-result-"));
    const database = openMemoryDatabase(join(projectRoot, "memory.db"), "0f".repeat(32));
    const path = join(projectRoot, ".czar", "results", `${objectiveId}.md`);
    mkdirSync(join(projectRoot, ".czar", "results"), { recursive: true });
    writeFileSync(path, "my own file\n");
    let acknowledgments = 0;
    await expect(
      deliverManualResult({
        objectiveId,
        resultId,
        token: "opaque-token",
        projectRoot,
        database,
        print: () => undefined,
        acknowledge: async () => {
          acknowledgments += 1;
        },
        fetcher: async () => Response.json(result),
      }),
    ).rejects.toThrow(/different content/);
    database.close();
    expect(readFileSync(path, "utf8")).toBe("my own file\n");
    expect(acknowledgments).toBe(0);
  });

  it("reuses the writtenAt value when acknowledging after a failed attempt", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "czar-result-"));
    const database = openMemoryDatabase(join(projectRoot, "memory.db"), "0f".repeat(32));
    const attempts: { writtenAt: string; idempotencyKey: string }[] = [];
    const input = {
      objectiveId,
      resultId,
      token: "opaque-token",
      projectRoot,
      database,
      print: () => undefined,
      acknowledge: async (
        _objective: string,
        _result: string,
        writtenAt: string,
        idempotencyKey: string,
      ) => {
        attempts.push({ writtenAt, idempotencyKey });
        if (attempts.length === 1) throw new Error("network down");
      },
      fetcher: async () => Response.json(result),
    };
    try {
      await expect(deliverManualResult(input)).rejects.toThrow(/network down/);
      await deliverManualResult(input);
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toEqual(attempts[1]);
    } finally {
      database.close();
    }
  });

  it("refuses a symlinked result directory", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "czar-result-"));
    const outside = mkdtempSync(join(tmpdir(), "czar-outside-"));
    symlinkSync(outside, join(projectRoot, ".czar"));
    const database = openMemoryDatabase(join(projectRoot, "memory.db"), "0f".repeat(32));
    try {
      await expect(
        deliverManualResult({
          objectiveId,
          resultId,
          token: "opaque-token",
          projectRoot,
          database,
          print: () => undefined,
          acknowledge: async () => undefined,
          fetcher: async () => Response.json(result),
        }),
      ).rejects.toThrow(/not a regular directory/);
    } finally {
      database.close();
    }
  });
});
