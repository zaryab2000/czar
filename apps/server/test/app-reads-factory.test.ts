import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readsSource = readFileSync(new URL("../src/app/reads.ts", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");

describe("app reads vault factory (SCR-158 §8)", () => {
  it("never reads the vault factory from process.env", () => {
    expect(readsSource).not.toContain("CZAR_VAULT_FACTORY_ADDRESS");
    expect(readsSource).not.toMatch(/process\.env\[[^\]]*FACTORY/);
  });

  it("takes the factory from the server's deployment-manifest vaultFactory", () => {
    expect(readsSource).toMatch(/readonly vaultFactory: Address/);
    expect(appSource).toMatch(/appReadDependencies[\s\S]*?vaultFactory: dependencies\.vaultFactory/);
  });
});
