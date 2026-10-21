import { describe, expect, it } from "vitest";
import { HALT_PATHS, lagAlert, reserveRateAlert } from "#src/alerts/rules";

describe("indexer alert rules", () => {
  it("alerts only after the configured lag boundary", () => {
    expect(lagAlert(220n, 100n, 120)).toBeNull();
    expect(lagAlert(221n, 100n, 120)).toBe(121n);
  });

  it("alerts only when a reservation rate exceeds its limit", () => {
    expect(reserveRateAlert(60, 60)).toBe(false);
    expect(reserveRateAlert(61, 60)).toBe(true);
  });

  it("maps upgrades and ERC-8183 admin events to the affected payment paths", () => {
    expect(HALT_PATHS).toEqual({
      usdc: ["x402-exact", "gateway-nano", "erc8183-job"],
      gatewayWallet: ["gateway-nano"],
      gatewayMinter: ["gateway-nano"],
      erc8183: ["erc8183-job"],
    });
  });
});
