import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { versionFromBareProbe } from "#src/social/controlled-local";

const servers: Server[] = [];

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server port.");
  return `http://127.0.0.1:${address.port}`;
}

describe("controlled supplier probe", () => {
  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  it("never follows a local supplier redirect to an unapproved origin", async () => {
    let redirectedRequests = 0;
    const target = await listen((_request, response) => {
      redirectedRequests += 1;
      response.writeHead(402, { "content-type": "application/json" });
      response.end("{}");
    });
    const source = await listen((_request, response) => {
      response.writeHead(302, { location: `${target}/v1/search` });
      response.end();
    });
    await expect(
      versionFromBareProbe(
        {
          key: "redirecting-supplier",
          serviceId: `svc_${"a".repeat(32)}`,
          resource: { url: `${source}/v1/search`, method: "GET" },
          capability: "web-search",
          taskClass: "data-json.search",
        },
        "eip155:5042002",
        [source],
      ),
    ).rejects.toThrow();
    expect(redirectedRequests).toBe(0);
  });
});
