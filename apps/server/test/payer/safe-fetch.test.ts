import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "@czar/config";
import { createSafeFetchFromConfig } from "@czar/x402/safe-fetch";

describe("payer_noLocalhostFetchExceptConfiguredMerchants", () => {
  const server = createServer((_request, response) => response.end("local merchant"));
  let origin: string;

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("blocks an unconfigured loopback origin and permits the exact configured merchant", async () => {
    const blockedFetch = createSafeFetchFromConfig(loadConfig(), "0.0.0");
    await expect(blockedFetch(origin)).rejects.toMatchObject({
      code: "fetch-blocked",
      rule: "scheme",
    });

    const merchantFetch = createSafeFetchFromConfig(
      loadConfig({ envFile: { "fetch.localMerchantOrigins": [origin] } }),
      "0.0.0",
    );
    const response = await merchantFetch(origin);
    expect(new TextDecoder().decode(response.body)).toBe("local merchant");
  });
});
