import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const STARTUP_TIMEOUT_MS = 5_000;
const STARTUP_POLL_MS = 25;
const TEST_ORIGINS = ["http://localhost:3001", "http://localhost:3100", "http://localhost:3200"];
const MOCK_BUNDLER_PATH = fileURLToPath(new URL("../e2e/mock-bundler.mjs", import.meta.url));
const WEB_ROOT = fileURLToPath(new URL("../", import.meta.url));

describe("mock bundler CORS origins", () => {
  let child: ChildProcess | undefined;
  let bundlerPort = 0;
  let childError = "";

  beforeAll(async () => {
    bundlerPort = await availablePort();
    const startedChild = spawn(process.execPath, [MOCK_BUNDLER_PATH], {
      cwd: WEB_ROOT,
      env: {
        NODE_ENV: "test",
        CZAR_MOCK_BUNDLER_PORT: String(bundlerPort),
        CZAR_MOCK_BUNDLER_CORS_ORIGINS: TEST_ORIGINS.join(","),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child = startedChild;
    startedChild.stderr?.on("data", (chunk: Buffer) => {
      childError += chunk.toString();
    });
    await waitForBundler();
  }, STARTUP_TIMEOUT_MS + 1_000);

  afterAll(async () => {
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child?.once("exit", () => resolve()));
  });

  it("allows configured localhost origins and rejects other origins", async () => {
    for (const origin of TEST_ORIGINS) {
      const response = await preflight(origin);
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
      expect(response.headers.get("vary")).toContain("Origin");
    }

    for (const origin of ["http://localhost:3002", "https://attacker.example"]) {
      const response = await preflight(origin);
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  async function preflight(origin: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${bundlerPort}/`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Authorization, Content-Type",
      },
    });
  }

  async function waitForBundler(): Promise<void> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child?.exitCode !== null && child?.exitCode !== undefined) {
        throw new Error(`Mock bundler exited before startup: ${childError}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${bundlerPort}/health`);
        if (response.ok) return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_MS));
      }
    }
    throw new Error(`Mock bundler did not become ready: ${childError}`);
  }
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === "string") {
    throw new Error("Could not reserve an ephemeral mock bundler port.");
  }
  return address.port;
}
