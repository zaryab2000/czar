// PM-021: the Anthropic `ModelClient` adapter. Every case runs against a fake HTTP server on
// loopback; nothing here reaches api.anthropic.com, and no real key exists in this file.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { loadConfig } from "@czar/config";
import { computePromptHash, type ModelCallRequest } from "#src/models/proxy";
import {
  ANTHROPIC_VERSION,
  createAnthropicModelClient,
  estimatePromptTokens,
} from "#src/models/anthropic";

const API_KEY = "fake-key-for-tests-7b1c9d";
const INPUT_MARKER = "merchant-body-marker-2f8ad1";
const PROMPT_MARKER = "You are a safety screen for Czar.";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: { answer: { type: "string" } },
} as const;

const systemText = await readFile(new URL("../../../../models/P-01.md", import.meta.url), "utf8");
const promptHash = await computePromptHash("P-01");

interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Record<string, unknown>;
}

interface Fake {
  readonly origin: string;
  readonly requests: readonly CapturedRequest[];
  /** Resolves the first time the fake server has read a whole request body. */
  readonly firstRequest: Promise<void>;
}

const servers: Server[] = [];

async function startFake(handler: (response: ServerResponse) => void): Promise<Fake> {
  const requests: CapturedRequest[] = [];
  let announce: () => void = () => {};
  const firstRequest = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([name, value]) => [
            name,
            Array.isArray(value) ? value.join(",") : (value ?? ""),
          ]),
        ),
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      });
      announce();
      handler(response);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error("fake model server did not bind");
  return { origin: `http://127.0.0.1:${address.port}`, requests, firstRequest };
}

function replyJson(body: unknown, status = 200): (response: ServerResponse) => void {
  return (response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
}

function replyText(text: string, status = 200): (response: ServerResponse) => void {
  return (response) => {
    response.writeHead(status, { "content-type": "text/plain" });
    response.end(text);
  };
}

function completionBody(text: string, usage = { input_tokens: 31, output_tokens: 7 }): unknown {
  return { content: [{ type: "text", text }], usage };
}

function testConfig(origin: string, overrides: Readonly<Record<string, unknown>> = {}) {
  return loadConfig({
    envFile: {
      "models.anthropic.baseUrl": origin,
      ...overrides,
    },
  });
}

function request(
  input: Record<string, unknown> = { sourceLabel: { kind: "merchant-body" }, text: INPUT_MARKER },
  overrides: Partial<ModelCallRequest> = {},
): ModelCallRequest {
  return {
    prompt: "P-01",
    promptHash,
    input,
    schema: SCHEMA as unknown as Record<string, unknown>,
    ...overrides,
  };
}

function client(
  origin: string,
  options: {
    readonly overrides?: Readonly<Record<string, unknown>>;
    readonly readSecretFile?: (path: string) => Promise<string>;
    readonly reads?: string[];
  } = {},
) {
  const reads = options.reads ?? [];
  return createAnthropicModelClient({
    config: testConfig(origin, options.overrides),
    readSecretFile:
      options.readSecretFile ??
      (async (path: string) => {
        reads.push(path);
        return `${API_KEY}\n`;
      }),
    fetchFn: fetch,
  });
}

function callOptions(overrides: Partial<{ maxTotalTokens: number; timeoutMs: number }> = {}) {
  return {
    maxTotalTokens: 4000,
    timeoutMs: 10_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

describe("createAnthropicModelClient", () => {
  it("returns the validated output and the mapped usage", async () => {
    const fake = await startFake(
      replyJson(
        completionBody(JSON.stringify({ answer: "clean" }), {
          input_tokens: 123,
          output_tokens: 45,
        }),
      ),
    );

    const completion = await client(fake.origin).complete(request(), callOptions());

    expect(completion).toStrictEqual({
      output: { answer: "clean" },
      usage: { inputTokens: 123, outputTokens: 45 },
    });
  });

  it("sends the prompt file as system, the labelled JSON input as the user message, and the configured model", async () => {
    const fake = await startFake(replyJson(completionBody(JSON.stringify({ answer: "clean" }))));

    await client(fake.origin).complete(request(), callOptions({ maxTotalTokens: 4000 }));

    expect(fake.requests).toHaveLength(1);
    const sent = fake.requests[0]!;
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe("/v1/messages");
    expect(sent.headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
    expect(sent.headers["x-api-key"]).toBe(API_KEY);
    expect(sent.headers["content-type"]).toContain("application/json");
    expect(sent.body["model"]).toBe("claude-haiku-5-5");
    expect(sent.body["system"]).toBe(systemText);
    const messages = sent.body["messages"] as { role: string; content: string }[];
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toContain(
      JSON.stringify({ sourceLabel: { kind: "merchant-body" }, text: INPUT_MARKER }),
    );
    expect(messages[0]!.content).toContain(JSON.stringify(SCHEMA));
    expect(sent.body["max_tokens"]).toBe(
      4000 - estimatePromptTokens(`${sent.body["system"] as string}${messages[0]!.content}`),
    );
  });

  it("reads the key once, from the server's credential folder", async () => {
    const fake = await startFake(replyJson(completionBody(JSON.stringify({ answer: "clean" }))));
    const reads: string[] = [];
    const modelClient = client(fake.origin, { reads });

    await modelClient.complete(request(), callOptions());
    await modelClient.complete(request(), callOptions());

    expect(fake.requests).toHaveLength(2);
    expect(reads).toStrictEqual(["/run/czar/secrets/server/anthropic-api-key"]);
  });

  it("throws before any request when the key file cannot be read", async () => {
    const fake = await startFake(replyJson(completionBody(JSON.stringify({ answer: "clean" }))));
    const modelClient = client(fake.origin, {
      readSecretFile: () => Promise.reject(new Error("ENOENT")),
    });

    await expect(modelClient.complete(request(), callOptions())).rejects.toThrow(
      /anthropic api key/i,
    );
    expect(fake.requests).toHaveLength(0);
  });

  it("throws before any request when the key file is blank", async () => {
    const fake = await startFake(replyJson(completionBody(JSON.stringify({ answer: "clean" }))));
    const modelClient = client(fake.origin, { readSecretFile: async () => "   \n" });

    await expect(modelClient.complete(request(), callOptions())).rejects.toThrow(
      /anthropic api key/i,
    );
    expect(fake.requests).toHaveLength(0);
  });

  it("throws before any request when the prompt hash does not match the prompt file", async () => {
    const fake = await startFake(replyJson(completionBody(JSON.stringify({ answer: "clean" }))));

    await expect(
      client(fake.origin).complete(
        request(undefined, { promptHash: `0x${"a".repeat(64)}` }),
        callOptions(),
      ),
    ).rejects.toThrow(/prompt hash/i);
    expect(fake.requests).toHaveLength(0);
  });

  it("throws before any request when the estimated prompt exceeds models.anthropic.maxPromptTokens", async () => {
    const fake = await startFake(replyJson(completionBody(JSON.stringify({ answer: "clean" }))));
    // 350,000 single-byte characters ≈ 116,667 estimated tokens, over the 100,000 default.
    const oversize = { sourceLabel: { kind: "merchant-body" }, text: "a".repeat(350_000) };

    await expect(client(fake.origin).complete(request(oversize), callOptions())).rejects.toThrow(
      /prompt too large/i,
    );
    expect(fake.requests).toHaveLength(0);
  });

  it("throws before any request when the reserved ceiling leaves no room for an answer", async () => {
    const fake = await startFake(replyJson(completionBody(JSON.stringify({ answer: "clean" }))));

    await expect(
      client(fake.origin).complete(request(), callOptions({ maxTotalTokens: 1 })),
    ).rejects.toThrow(/token ceiling/i);
    expect(fake.requests).toHaveLength(0);
  });

  it("throws when the reply is not JSON", async () => {
    const fake = await startFake(replyJson(completionBody("I am not JSON")));

    await expect(client(fake.origin).complete(request(), callOptions())).rejects.toThrow(
      /not a JSON object/i,
    );
  });

  it("throws when the reply is JSON that does not match the request schema", async () => {
    const fake = await startFake(replyJson(completionBody(JSON.stringify({ answer: 42 }))));

    await expect(client(fake.origin).complete(request(), callOptions())).rejects.toThrow(
      /schema/i,
    );
  });

  it("throws when the reply carries no text block", async () => {
    const fake = await startFake(replyJson({ content: [], usage: { input_tokens: 1, output_tokens: 1 } }));

    await expect(client(fake.origin).complete(request(), callOptions())).rejects.toThrow(
      /no text/i,
    );
  });

  it("throws when the reply carries no usable usage counts", async () => {
    const fake = await startFake(
      replyJson({ content: [{ type: "text", text: JSON.stringify({ answer: "clean" }) }] }),
    );

    await expect(client(fake.origin).complete(request(), callOptions())).rejects.toThrow(/usage/i);
  });

  it("throws when the body is not JSON at all", async () => {
    const fake = await startFake(replyText("<html>gateway</html>"));

    await expect(client(fake.origin).complete(request(), callOptions())).rejects.toThrow(
      /anthropic/i,
    );
  });

  for (const status of [400, 401, 429, 500] as const) {
    it(`throws with the status only on HTTP ${status}`, async () => {
      const fake = await startFake(
        replyJson({ error: { message: `secret detail ${INPUT_MARKER}` } }, status),
      );

      const failure = await client(fake.origin)
        .complete(request(), callOptions())
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toContain(String(status));
      expect(message).not.toContain(INPUT_MARKER);
      expect(message).not.toContain(API_KEY);
      expect(message).not.toContain(PROMPT_MARKER);
    });
  }

  it("throws on timeout", async () => {
    const fake = await startFake(() => {
      // never answers; the adapter's own timeout must end the call
    });

    const failure = await client(fake.origin)
      .complete(request(), callOptions({ timeoutMs: 250 }))
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/timed out/i);
  }, 30_000);

  it("cancels when the caller's signal aborts", async () => {
    const fake = await startFake(() => {
      // never answers; the caller's abort must end the call
    });
    const controller = new AbortController();
    const pending = client(fake.origin).complete(request(), {
      maxTotalTokens: 4000,
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    const settled = pending.then(
      () => undefined,
      (error: unknown) => error,
    );

    await fake.firstRequest;
    controller.abort();

    const failure = await settled;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/aborted/i);
  }, 30_000);

  it("writes neither the key nor any prompt text to stdout, stderr or the console", async () => {
    const fake = await startFake(replyJson(completionBody(JSON.stringify({ answer: INPUT_MARKER }))));
    const captured: string[] = [];
    const record = (...args: unknown[]) => {
      for (const arg of args) captured.push(typeof arg === "string" ? arg : JSON.stringify(arg));
    };
    const spies = [
      vi.spyOn(process.stdout, "write"),
      vi.spyOn(process.stderr, "write"),
      vi.spyOn(console, "log"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
      vi.spyOn(console, "debug"),
    ];

    try {
      await client(fake.origin).complete(request(), callOptions());
      const failing = await startFake(replyJson({ error: { message: "nope" } }, 500));
      await client(failing.origin)
        .complete(request(), callOptions())
        .catch(() => undefined);
      for (const spy of spies)
        for (const call of spy.mock.calls) record(...(call as unknown as unknown[]));
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    const text = captured.join("\n");
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(INPUT_MARKER);
    expect(text).not.toContain(PROMPT_MARKER);
  });

  it("refuses an api key file name that is not a plain file name", async () => {
    const fake = await startFake(replyJson(completionBody(JSON.stringify({ answer: "clean" }))));
    const modelClient = client(fake.origin, {
      overrides: { "models.anthropic.apiKeyFile": "../signer/client-tokens/server" },
    });

    await expect(modelClient.complete(request(), callOptions())).rejects.toThrow(/file name/i);
    expect(fake.requests).toHaveLength(0);
  });
});
