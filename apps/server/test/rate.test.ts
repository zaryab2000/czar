import { describe, expect, it } from "vitest";
import { validateRecordedExchange } from "@czar/api-contract";
import { setupDatabase } from "#test/db";
import { createTestContext, seedDevice, TEST_TOKEN } from "#test/fixtures";

const getPool = setupDatabase();

describe("database-backed rate limits", () => {
  it("daemon600thRequestPasses_and601stIsRetryable429", async () => {
    const pool = getPool();
    const context = createTestContext(pool);
    await seedDevice(pool);
    let sixHundredth: Response | undefined;
    for (let attempt = 1; attempt <= 601; attempt += 1) {
      const response = await context.app.request("/v1/objectives", {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      if (attempt === 600) sixHundredth = response;
      if (attempt === 601) {
        expect(response.status).toBe(429);
        const body = (await response.json()) as any;
        expect(body.czarCode).toBe("rate-limited");
        expect(body.retryable).toBe(true);
        expect(
          validateRecordedExchange("listObjectives", {
            responseStatus: response.status,
            responseBody: body,
          }).valid,
        ).toBe(true);
        expect(response.headers.get("RateLimit-Remaining")).toBe("0");
      }
    }
    expect(sixHundredth?.status).toBe(200);
    context.clock.advance(60_000);
    const reset = await context.app.request("/v1/objectives", {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(reset.status).toBe(200);
    expect(reset.headers.get("RateLimit-Remaining")).toBe("599");
  });

  it("pair120thAttemptPassesLimit_and121stIsRetryable429", async () => {
    const context = createTestContext(getPool());
    let oneHundredTwentieth: Response | undefined;
    for (let attempt = 1; attempt <= 121; attempt += 1) {
      const suffix = String(attempt).padStart(12, "0");
      const response = await context.app.request("/v1/devices/pair", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `00000000-0000-4000-8000-${suffix}`,
        },
        body: JSON.stringify({
          pairingCode: "99999999",
          deviceName: "Limit test",
          platform: "macos",
        }),
      });
      if (attempt === 120) oneHundredTwentieth = response;
      if (attempt === 121) {
        expect(response.status).toBe(429);
        expect(response.headers.get("RateLimit-Remaining")).toBe("0");
      }
    }
    expect(oneHundredTwentieth?.status).toBe(400);
    expect(oneHundredTwentieth?.headers.get("RateLimit-Remaining")).toBe("0");
  });
});
