import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const composition = readFileSync(new URL("./process-compose.yaml", import.meta.url), "utf8");
const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
const readiness = readFileSync(new URL("./check-signer-k10.ts", import.meta.url), "utf8");
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
  it("waits for migration and successful merchant K10 lookup before listen", () => {
    expect(serverMain.indexOf("await migrate(options.pool)")).toBeLessThan(
      serverMain.indexOf("const objects"),
    );
    expect(localServer.indexOf("await createLocalServerMain")).toBeLessThan(
      localServer.indexOf("await listenOnLoopback(server, port)"),
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
    expect(k10Ready.join("\n")).toContain("ops/local/check-signer-k10.ts");
    expect(readiness).toContain('keyAddress("cz-20", "K10:czar-search")');
  });

  it("documents the single local stack start command", () => {
    expect(readme).toContain("process-compose -f ops/local/process-compose.yaml up");
  });
});
