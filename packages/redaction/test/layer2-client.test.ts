import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { regexFallback, sidecarLayer2Client } from "@czar/redaction";

function socketPath() {
  return join(mkdtempSync(join(tmpdir(), "czar-l2-")), "czar-redact.sock");
}

describe("layer-2 client", () => {
  it("uses the sidecar's answer when it is up", async () => {
    const path = socketPath();
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.on("data", (frame: string) => {
        const request = JSON.parse(frame) as {
          id: number;
          method: string;
          params: { text: string; language: string };
        };
        expect(request.method).toBe("analyze_anonymize");
        expect(request.params.language).toBe("en");
        socket.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { text: "hi [[R:P:PERSON#1]]", entities: [{ type: "PERSON", count: 1 }] } })}\n`,
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    const client = sidecarLayer2Client({ socketPath: path, timeoutMs: 2000 });
    expect(await client.redact("hi Ada Lovelace", { language: "en" })).toEqual({
      text: "hi [[R:P:PERSON#1]]",
      entities: [{ type: "PERSON", count: 1 }],
      forcedReview: false,
    });
    server.close();
  });

  it("with the helper stopped, uses the regex fallback and forces review (D45)", async () => {
    const client = sidecarLayer2Client({ socketPath: socketPath(), timeoutMs: 500 });
    const result = await client.redact("mail ada@example.com or call 415-555-0142", {
      language: "en",
    });
    expect(result.forcedReview).toBe(true);
    expect(result.text).toBe("mail [[R:P:EMAIL_ADDRESS#1]] or call [[R:P:PHONE_NUMBER#1]]");
  });

  it("falls back on a timeout and on an error reply", async () => {
    const path = socketPath();
    const server = createServer((socket) => {
      socket.on("data", () =>
        socket.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32010, message: "x" } })}\n`,
        ),
      );
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    expect(
      (
        await sidecarLayer2Client({ socketPath: path, timeoutMs: 500 }).redact("x", {
          language: "fr",
        })
      ).forcedReview,
    ).toBe(true);
    server.close();

    const silent = socketPath();
    const mute = createServer(() => undefined);
    await new Promise<void>((resolve) => mute.listen(silent, resolve));
    expect(
      (
        await sidecarLayer2Client({ socketPath: silent, timeoutMs: 100 }).redact("x", {
          language: "en",
        })
      ).forcedReview,
    ).toBe(true);
    mute.close();
  });
});

describe("regex fallback", () => {
  it("numbers distinct values per entity and keeps existing markers", () => {
    const result = regexFallback(
      "a@example.com b@example.com a@example.com [[R:S:aws-access-token]]",
    );
    expect(result.text).toBe(
      "[[R:P:EMAIL_ADDRESS#1]] [[R:P:EMAIL_ADDRESS#2]] [[R:P:EMAIL_ADDRESS#1]] [[R:S:aws-access-token]]",
    );
    expect(result.entities).toEqual([{ type: "EMAIL_ADDRESS", count: 3 }]);
  });

  it("catches IBANs", () => {
    expect(regexFallback("pay DE89 3704 0044 0532 0130 00 today").text).toBe(
      "pay [[R:P:IBAN_CODE#1]] today",
    );
  });

  it("leaves clean text alone but still forces review", () => {
    expect(regexFallback("refactor the router")).toEqual({
      text: "refactor the router",
      entities: [],
      forcedReview: true,
    });
  });
});
