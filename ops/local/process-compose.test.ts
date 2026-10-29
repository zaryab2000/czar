import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const composition = readFileSync(new URL("./process-compose.yaml", import.meta.url), "utf8");
const forkComposition = readFileSync(
  new URL("./process-compose.fork.yaml", import.meta.url),
  "utf8",
);
const forkLauncher = readFileSync(new URL("./fork-anvil.mjs", import.meta.url), "utf8");
const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
const k10ReadinessUrl = new URL("../../apps/signer/scripts/check-signer-k10.ts", import.meta.url);
const readiness = readFileSync(k10ReadinessUrl, "utf8");
const k3ReadinessUrl = new URL("../../apps/signer/scripts/check-signer-k3.ts", import.meta.url);
const k3Readiness = readFileSync(k3ReadinessUrl, "utf8");
const serverMain = readFileSync(new URL("../../apps/server/src/main.ts", import.meta.url), "utf8");
const localServer = readFileSync(
  new URL("../../apps/server/src/local-main.ts", import.meta.url),
  "utf8",
);
const localMerchant = readFileSync(
  new URL("../../apps/merchants/src/local-main.ts", import.meta.url),
  "utf8",
);
const merchantRuntime = readFileSync(
  new URL("../../apps/merchants/src/runtime.ts", import.meta.url),
  "utf8",
);

function processSection(name: string): string[] {
  const lines = composition.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start === -1) throw new Error(`Missing process ${name}`);
  const end = lines.findIndex((line, index) => index > start && /^  [a-z0-9-]+:$/.test(line));
  return lines.slice(start, end === -1 ? lines.length : end);
}

function expectDependency(process: string[], name: string, condition: string): void {
  const start = process.indexOf("    depends_on:");
  const dependency = process.indexOf(`      ${name}:`, start + 1);
  expect(dependency, `missing dependency ${name}`).toBeGreaterThan(start);
  expect(process[dependency + 1]).toBe(`        condition: ${condition}`);
}

describe("local process composition", () => {
  it("resolves K3 and K10 config fallbacks to the root local overlay", () => {
    const k10ConfigPath = new URL("../../../env/local.toml", k10ReadinessUrl);
    const k3ConfigPath = new URL("../../../env/local.toml", k3ReadinessUrl);
    expect(readiness).toContain('new URL("../../../env/local.toml", import.meta.url)');
    expect(k3Readiness).toContain('new URL("../../../env/local.toml", import.meta.url)');
    expect(existsSync(k10ConfigPath)).toBe(true);
    expect(existsSync(k3ConfigPath)).toBe(true);
  });

  it("keeps clean Arc Anvil separate from the fork profile", () => {
    const cleanArc = processSection("arc-anvil").join("\n");
    expect(cleanArc).toContain("arc-anvil --network arc --chain-id 5042002");
    expect(cleanArc).not.toContain("--fork-url");
    expect(forkComposition).toContain("command: node ops/local/fork-anvil.mjs");
    expect(forkLauncher).toContain("latest - FORK_BLOCK_OFFSET");
    expect(forkLauncher).toContain('"--host",\n    "127.0.0.1"');
  });

  it("routes the mock bundler and web app through the local services", () => {
    expect(forkComposition).toContain("pnpm --filter @czar/web exec node e2e/mock-bundler.mjs");
    expect(forkComposition).toContain("CZAR_ARC_RPC_URL=http://127.0.0.1:8545");
    expect(forkComposition).toContain("CZAR_MOCK_BUNDLER_PORT=4337");
    expect(forkComposition).toContain(
      "CZAR_MOCK_BUNDLER_CORS_ORIGINS=http://localhost:3001,http://localhost:3100",
    );
    expect(forkComposition).toContain("CZAR_SERVER_URL=http://127.0.0.1:3000");
    expect(forkComposition).toContain("port: 3001");
    expect(forkComposition).toContain("command: pnpm --filter @czar/web dev --port 3001");
    expect(forkComposition).not.toContain("dev -- --port");
  });

  it("waits for migration and successful merchant K10 lookup before listen", () => {
    expect(serverMain.indexOf("await migrate(options.pool)")).toBeLessThan(
      serverMain.indexOf("const objects"),
    );
    expect(localServer.indexOf("await createLocalServerMain")).toBeLessThan(
      localServer.indexOf("await listen(server, port)"),
    );
    expect(localMerchant.indexOf("await migrateMerchant(pool)")).toBeLessThan(
      localMerchant.indexOf("await createMerchantServer"),
    );
    expect(
      merchantRuntime.indexOf('await options.signer.keyAddress("cz-20", "K10:czar-search")'),
    ).toBeLessThan(merchantRuntime.indexOf("await listen("));

    const merchants = processSection("merchants");
    expectDependency(processSection("server"), "postgres", "process_healthy");
    expectDependency(merchants, "server", "process_healthy");
    expectDependency(merchants, "signer", "process_healthy");
    expectDependency(merchants, "merchant-k10-ready", "process_completed_successfully");
    expectDependency(merchants, "circle-standins", "process_healthy");

    const k10Ready = processSection("merchant-k10-ready");
    expectDependency(k10Ready, "postgres", "process_healthy");
    expectDependency(k10Ready, "server", "process_healthy");
    expectDependency(k10Ready, "signer", "process_healthy");
    expect(k10Ready.join("\n")).toContain(
      "pnpm --filter @czar/signer exec node --disable-warning=ExperimentalWarning",
    );
    expect(k10Ready.join("\n")).toContain("scripts/check-signer-k10.ts");
    expect(readiness).toContain('keyAddress("cz-20", "K10:czar-search")');
    expect(k3Readiness).toContain('keyAddress("cz-15", "K3")');
  });

  it("routes every database consumer through the SCR-151 chain-session launcher", () => {
    for (const [process, pkg] of [
      ["indexer", "@czar/indexer"],
      ["server", "@czar/server"],
      ["signer", "@czar/signer"],
      ["merchants", "@czar/merchants"],
    ] as const) {
      const section = processSection(process).join("\n");
      expect(section).toContain(
        `command: node ops/local/chain-session.mjs --role ${process} -- pnpm --filter ${pkg} start:local`,
      );
      expect(section).toMatch(
        /(CZAR_)?DATABASE_URL=postgres:\/\/postgres@127\.0\.0\.1:15433\/postgres/,
      );
    }
    // The indexer establishes the session; server, signer and merchants start after it (A2).
    expectDependency(processSection("server"), "indexer", "process_healthy");
    expectDependency(processSection("signer"), "server", "process_healthy");
    expectDependency(processSection("merchants"), "server", "process_healthy");
    expect(composition).not.toMatch(/\bDROP\b/);
    expect(forkComposition).not.toContain("chain-session.mjs");
  });

  it("marks the signer ready only when its socket accepts a connection", () => {
    // A stale socket file survives every signer exit, so a file-existence probe passes before the
    // new signer listens and merchant-k10-ready then fails with ECONNREFUSED.
    const signer = processSection("signer").join("\n");
    expect(signer).not.toContain("test -S");
    expect(signer).toContain('require("node:net").connect(');
    expect(signer).toContain("Library/Application Support/Czar/signer/signer.sock");
  });

  it("records the A1 indexer start block from the deploy step on both deploy paths", () => {
    const deploy = readFileSync(new URL("./deploy.sh", import.meta.url), "utf8");
    expect(deploy).toContain('node "$ROOT/ops/local/record-start-block.mjs" --existing-deployment');
    expect(deploy).toContain(
      'node "$ROOT/ops/local/record-start-block.mjs" --deploy-started-ms "$DEPLOY_STARTED_MS"',
    );
    expect(deploy.indexOf("DEPLOY_STARTED_MS=")).toBeLessThan(deploy.indexOf("script/deploy.sh"));
  });

  it("documents the single local stack start command", () => {
    expect(readme).toContain("process-compose -f ops/local/process-compose.yaml up");
  });
});
