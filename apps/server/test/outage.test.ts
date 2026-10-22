import { createLogger } from "@czar/logging";
import { validateRecordedExchange } from "@czar/api-contract";
import { loadConfig } from "@czar/config";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "#src/app";

const pool = new Pool({
  connectionString: "postgres://postgres@127.0.0.1:1/postgres",
  connectionTimeoutMillis: 100,
});
const app = createApp({
  pool,
  config: loadConfig(),
  logger: createLogger({ service: "server", component: "CZ-12", sink: () => undefined }),
  clock: { now: () => new Date("2026-10-21T00:00:00.000Z") },
  random: { bytes: (length) => Buffer.alloc(length, 1) },
});

afterAll(async () => pool.end());

describe("database outage", () => {
  it("postgresUnavailable_returns503WithRateHeadersAndNoPartialWrite", async () => {
    const response = await app.request("/v1/objectives", {
      headers: { Authorization: "Bearer unavailable-test-token" },
    });
    const body = (await response.json()) as any;
    expect(response.status).toBe(503);
    expect(body.czarCode).toBe("upstream-unavailable");
    expect(body.retryable).toBe(true);
    expect(response.headers.get("RateLimit-Limit")).toBe("600");
    expect(response.headers.get("RateLimit-Remaining")).not.toBeNull();
    expect(response.headers.get("RateLimit-Reset")).not.toBeNull();
    expect(body.detail).not.toContain("127.0.0.1");
    expect(
      validateRecordedExchange("listObjectives", {
        responseStatus: response.status,
        responseBody: body,
      }).valid,
    ).toBe(true);
  });
});
