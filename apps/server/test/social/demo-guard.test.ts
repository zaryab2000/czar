import { describe, expect, it } from "vitest";
import { loadConfig } from "@czar/config";
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
});
