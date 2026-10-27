import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Layer2Client } from "@czar/redaction";
import { runManualObjective } from "#src/objective-command";
import { openMemoryDatabase } from "#src/database";
import { parseObjectiveOptions } from "#src/objective-options";

const updatedAt = "2026-10-27T00:00:00.000Z";
const key = "0f".repeat(32);
const cleanLayer2: Layer2Client = {
  async redact(text) {
    return { text, entities: [], forcedReview: false };
  },
};

describe("manual objective command", () => {
  it("refuses fallback without a review decision before any request", async () => {
    const db = openMemoryDatabase(
      join(mkdtempSync(join(tmpdir(), "czar-objective-command-")), "memory.db"),
      key,
    );
    let calls = 0;
    try {
      await expect(
        runManualObjective(
          parseObjectiveOptions(
            ["Find Ada prices", "--subject", "Acme", "--field", "price"],
            ["web-search"],
          ),
          {
            database: db,
            deviceId: "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
            deviceToken: "opaque-token",
            layer2: {
              async redact(text) {
                return { text, entities: [], forcedReview: true };
              },
            },
            pollSeconds: 5,
            print: () => undefined,
            fetcher: async () => {
              calls += 1;
              throw new Error("unexpected request");
            },
          },
        ),
      ).rejects.toThrow(/review declined/);
      expect(calls).toBe(0);
    } finally {
      db.close();
    }
  });

  it("submits a reviewed fallback and records its forced-review flag", async () => {
    const db = openMemoryDatabase(
      join(mkdtempSync(join(tmpdir(), "czar-objective-command-")), "memory.db"),
      key,
    );
    let reviewed = "";
    let requests = 0;
    try {
      await runManualObjective(
        parseObjectiveOptions(
          ["Find Ada prices", "--subject", "Acme", "--field", "price"],
          ["web-search"],
        ),
        {
          database: db,
          deviceId: "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
          deviceToken: "opaque-token",
          layer2: {
            async redact(text) {
              return { text, entities: [], forcedReview: true };
            },
          },
          pollSeconds: 5,
          confirmFallback: async (goal) => {
            reviewed = goal;
            return true;
          },
          print: () => undefined,
          fetcher: async (_url, init) => {
            requests += 1;
            const id =
              init.method === "POST"
                ? (JSON.parse(String(init.body)) as { objectiveId: string }).objectiveId
                : _url.pathname.split("/").at(-1);
            return Response.json(
              {
                objectiveId: id,
                status: init.method === "POST" ? "received" : "failed",
                updatedAt,
              },
              { status: init.method === "POST" ? 202 : 200 },
            );
          },
        },
      );
      expect(reviewed).toContain("Find Ada");
      expect(requests).toBe(2);
      const row = db.prepare("SELECT summary_counts_json FROM audit_local").get() as {
        summary_counts_json: string;
      };
      expect(JSON.parse(row.summary_counts_json)).toEqual({ forcedReview: 1 });
    } finally {
      db.close();
    }
  });

  it("submits, prints only the ID and states, then stops at terminal state", async () => {
    const db = openMemoryDatabase(
      join(mkdtempSync(join(tmpdir(), "czar-objective-command-")), "memory.db"),
      key,
    );
    const lines: string[] = [];
    const requests: string[] = [];
    try {
      await runManualObjective(
        parseObjectiveOptions(
          ["Find private prices", "--subject", "Acme", "--field", "price"],
          ["web-search"],
        ),
        {
          database: db,
          deviceId: "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
          deviceToken: "opaque-token",
          layer2: cleanLayer2,
          pollSeconds: 5,
          now: () => new Date(updatedAt),
          print: (line) => lines.push(line),
          fetcher: async (url, init) => {
            requests.push(url.pathname);
            const objectiveId =
              init.method === "POST"
                ? (JSON.parse(String(init.body)) as { objectiveId: string }).objectiveId
                : url.pathname.split("/").at(-1);
            return Response.json(
              { objectiveId, status: init.method === "POST" ? "received" : "failed", updatedAt },
              { status: init.method === "POST" ? 202 : 200 },
            );
          },
        },
      );
      expect(requests).toHaveLength(2);
      expect(lines[0]).toMatch(/^obj_[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(lines[1]).toBe(`${lines[0]}: failed`);
      expect(lines.join("\n")).not.toContain("Find private prices");
      expect(lines.join("\n")).not.toContain("opaque-token");
    } finally {
      db.close();
    }
  });

  it("refuses a planted secret before network activity", async () => {
    const db = openMemoryDatabase(
      join(mkdtempSync(join(tmpdir(), "czar-objective-command-")), "memory.db"),
      key,
    );
    let calls = 0;
    try {
      await expect(
        runManualObjective(
          parseObjectiveOptions(
            [
              "Use ghp_123456789012345678901234567890123456",
              "--subject",
              "Acme",
              "--field",
              "price",
            ],
            ["web-search"],
          ),
          {
            database: db,
            deviceId: "dev_01K7ZT9P4N5Q6R7S8T9V0W1X2Y",
            deviceToken: "opaque-token",
            layer2: cleanLayer2,
            pollSeconds: 5,
            print: () => undefined,
            fetcher: async () => {
              calls += 1;
              throw new Error("unexpected request");
            },
          },
        ),
      ).rejects.toThrow(/Secret detected/);
      expect(calls).toBe(0);
    } finally {
      db.close();
    }
  });
});
