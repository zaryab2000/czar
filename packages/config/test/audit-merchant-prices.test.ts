// MR-08 / SCR-182 §1, §6: the two audit merchants' prices. A is the cheaper first pass, B the thorough
// review, and the planner must be able to pay either without the owner raising a limit.
import { describe, expect, it } from "vitest";
import { loadConfig, PARAMETERS } from "@czar/config";

const QUICK = "merchants.audit.quick.priceAtomic";
const DEEP = "merchants.audit.deep.priceAtomic";

describe("audit merchant prices (SCR-182)", () => {
  const config = loadConfig();
  const price = (key: typeof QUICK | typeof DEEP) => BigInt(String(config.get(key)));

  it("prices Czar Lab Quick Audit at 0.50 and Czar Lab Deep Audit at 1.00 testnet USDC", () => {
    expect(config.get(QUICK)).toBe("500000");
    expect(config.get(DEEP)).toBe("1000000");
  });

  it("keeps the quick audit cheaper than the deep audit", () => {
    expect(price(QUICK) < price(DEEP)).toBe(true);
  });

  it("keeps both prices at or under the planner's default maximum per unit", () => {
    const ceiling = BigInt(Number(config.get("planner.defaultMaxUnitAtomic")));
    expect(price(QUICK) <= ceiling).toBe(true);
    expect(price(DEEP) <= ceiling).toBe(true);
  });

  it("registers both as USDC atomic strings with a reason and an SCR-182 source", () => {
    for (const key of [QUICK, DEEP]) {
      const spec = PARAMETERS.find((parameter) => parameter.key === key);
      expect(spec?.type).toBe("string");
      expect(spec?.unit).toBe("USDC atomic");
      expect(spec?.source).toContain("SCR-182");
      expect(spec?.reason).not.toBe("");
    }
  });
});
