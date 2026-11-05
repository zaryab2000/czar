import { randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@czar/config";
import { openDemoContext } from "#src/social/demo-context";
import { assertDemoCommand } from "#src/social/demo-guard";

const demoConfig = () =>
  loadConfig({
    envFile: {
      "demo.enabled": true,
      "deploy.environment": "cloud-testnet",
      "selection.paymentNetwork": "eip155:5042002",
    },
  });

describe("SCR-183 demo command guard", () => {
  it("accepts only an explicitly confirmed demo deployment on Arc testnet", () => {
    expect(() => assertDemoCommand(["--confirm", "cloud-testnet"], demoConfig())).not.toThrow();
  });

  it("refuses each missing safety condition before database access", () => {
    const otherwiseValid = {
      "demo.enabled": true,
      "deploy.environment": "cloud-testnet",
      "selection.paymentNetwork": "eip155:5042002",
    };
    for (const changed of [
      { "demo.enabled": false },
      { "selection.paymentNetwork": "eip155:1" },
      { "deploy.environment": "local" },
    ]) {
      const config = loadConfig({ envFile: { ...otherwiseValid, ...changed } });
      expect(() => assertDemoCommand(["--confirm", "cloud-testnet"], config)).toThrow();
    }
    for (const args of [[], ["--confirm", "local"], ["--confirm", "cloud-testnet", "x"]]) {
      expect(() => assertDemoCommand(args, demoConfig())).toThrow();
    }
  });

  it("refuses the reset entry point before opening a database without confirmation", async () => {
    const configPath = resolve(tmpdir(), `czar-demo-guard-${randomUUID()}.toml`);
    await writeFile(
      configPath,
      [
        '"demo.enabled" = true',
        '"deploy.environment" = "cloud-testnet"',
        '"selection.paymentNetwork" = "eip155:5042002"',
      ].join("\n"),
    );
    try {
      const env = { CZAR_CLOUD_CONFIG: configPath };
      await expect(openDemoContext([], env)).rejects.toThrow("--confirm");
      await expect(openDemoContext(["--confirm", "wrong"], env)).rejects.toThrow(
        "does not match deploy.environment",
      );
    } finally {
      await unlink(configPath);
    }
  });
});
