import { describe, expect, it } from "vitest";
import {
  createLagMonitor,
  HALT_PATHS,
  haltPaths,
  isLiveBucket,
  lagAlert,
  reserveRateAlert,
} from "#src/alerts/rules";
import { createAlertReporter } from "#src/alerts/reporter";
import { createLogger } from "@czar/logging";

describe("indexer alert rules", () => {
  it("alerts only after the configured lag boundary", () => {
    expect(lagAlert(220n, 100n, 120)).toBeNull();
    expect(lagAlert(221n, 100n, 120)).toBe(121n);
  });

  it("checks lag at most once per interval and pages once per lag episode", () => {
    const monitor = createLagMonitor(1000);
    expect(monitor.shouldCheck(0)).toBe(true);
    expect(monitor.shouldCheck(999)).toBe(false);
    expect(monitor.shouldCheck(1000)).toBe(true);
    // A backfill: every check sees lag; only the first pages.
    expect(monitor.observe(5000n)).toBe(true);
    expect(monitor.observe(4000n)).toBe(false);
    expect(monitor.observe(3000n)).toBe(false);
    // Caught up, then behind again: pages again.
    expect(monitor.observe(null)).toBe(false);
    expect(monitor.observe(200n)).toBe(true);
  });

  it("never pages a reserve-rate bucket older than its own width", () => {
    expect(isLiveBucket(1_000n, 940n, 60n)).toBe(true);
    expect(isLiveBucket(1_000n, 939n, 60n)).toBe(false);
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
