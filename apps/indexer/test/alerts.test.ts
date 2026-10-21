import { describe, expect, it } from "vitest";
import { HALT_PATHS, haltPaths, lagAlert, reserveRateAlert } from "#src/alerts/rules";
import { createAlertReporter } from "#src/alerts/reporter";
import { createLogger } from "@czar/logging";

describe("indexer alert rules", () => {
  it("alerts only after the configured lag boundary", () => {
    expect(lagAlert(220n, 100n, 120)).toBeNull();
    expect(lagAlert(221n, 100n, 120)).toBe(121n);
  });

  it("alerts only when a reservation rate exceeds its limit", () => {
    expect(reserveRateAlert(60, 60)).toBe(false);
    expect(reserveRateAlert(61, 60)).toBe(true);
  });

  it("maps pinned dependency events to the exact affected payment paths", () => {
    const upgrades = [
      ["usdc", ["x402-exact", "gateway-nano", "erc8183-job"]],
      ["gatewayWallet", ["gateway-nano"]],
      ["gatewayMinter", ["gateway-nano"]],
      ["erc8183", ["erc8183-job"]],
    ] as const;
    for (const [proxy, paths] of upgrades) {
      expect(haltPaths(proxy, "Upgraded")).toEqual(paths);
    }
    for (const event of [
      "RoleGranted",
      "HookWhitelistUpdated",
      "PlatformFeeUpdated",
      "EvaluatorFeeUpdated",
    ]) {
      expect(haltPaths("erc8183", event)).toEqual(["erc8183-job"]);
    }
    expect(haltPaths("usdc", "RoleGranted")).toEqual([]);
    expect(HALT_PATHS.erc8183).toEqual(["erc8183-job"]);
  });

  it("emits allowlisted alert fields through the injectable JSON log sink", () => {
    const lines: string[] = [];
    const reporter = createAlertReporter(
      createLogger({ service: "indexer", component: "CZ-19", sink: (line) => lines.push(line) }),
    );
    reporter("dependency-upgraded", { blockNumber: 9, hash: `0x${"a".repeat(64)}` });
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      event: "dependency_upgraded",
      level: "error",
      rule: "dependency-upgraded",
      blockNumber: 9,
      hash: `0x${"a".repeat(64)}`,
    });
    expect(JSON.parse(lines[0] ?? "{}")).not.toHaveProperty("droppedFields");
  });
});
