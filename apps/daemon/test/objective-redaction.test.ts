import { describe, expect, it } from "vitest";
import type { Layer2Client } from "@czar/redaction";
import { parseObjectiveOptions } from "#src/objective-options";
import { redactObjectiveInput } from "#src/objective-redaction";

const options = () =>
  parseObjectiveOptions(
    ["Find prices", "--subject", "Acme", "--field", "monthly price"],
    ["web-search"],
  );

describe("manual objective redaction", () => {
  it("redacts the goal and preserves TaskSpec values after layer 1", async () => {
    const seen: string[] = [];
    const client: Layer2Client = {
      async redact(text) {
        seen.push(text);
        return {
          text: "[[R:P:PERSON#1]] prices",
          entities: [{ type: "PERSON", count: 1 }],
          forcedReview: false,
        };
      },
    };
    const result = await redactObjectiveInput(options(), client);
    expect(seen).toEqual(["Find prices"]);
    expect(result.options.goal).toBe("[[R:P:PERSON#1]] prices");
    expect(result.options.taskSpec.subjects[0]?.label).toBe("Acme");
    expect(result.layer2).toEqual({ hits: 1, entities: ["PERSON"] });
  });

  it("refuses an unmarked hit without printing the text", async () => {
    const client: Layer2Client = {
      async redact(text) {
        return {
          text,
          entities: [{ type: "PERSON", count: 1 }],
          forcedReview: false,
        };
      },
    };
    await expect(redactObjectiveInput(options(), client)).rejects.toThrow(/Entities: PERSON/);
  });

  it("refuses fallback review before submission", async () => {
    const client: Layer2Client = {
      async redact(text) {
        return { text, entities: [], forcedReview: true };
      },
    };
    await expect(redactObjectiveInput(options(), client)).rejects.toThrow(/requires review/);
  });

  it("refuses a planted secret before any layer-2 call", async () => {
    let calls = 0;
    const client: Layer2Client = {
      async redact(text) {
        calls += 1;
        return { text, entities: [], forcedReview: false };
      },
    };
    const secret = "ghp_123456789012345678901234567890123456";
    const planted = parseObjectiveOptions(
      [`Find prices ${secret}`, "--subject", "Acme", "--field", "monthly price"],
      ["web-search"],
    );
    let message = "";
    try {
      await redactObjectiveInput(planted, client);
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/Secret detected/);
    expect(message).not.toContain(secret);
    expect(calls).toBe(0);
  });
});
