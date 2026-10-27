import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatUsd, InvalidAmountError } from "@czar/web/money-format";

describe("formatUsd (D51)", () => {
  it.each([
    ["880000", "$0.88"],
    ["1000", "$0.001"],
    ["0", "$0.00"],
    ["1", "$0.000001"],
    ["10000", "$0.01"],
    ["1000000", "$1.00"],
    ["1234500000", "$1,234.50"],
    ["999999999999999", "$999,999,999.999999"],
  ])("%s → %s", (amount, expected) => {
    expect(formatUsd(amount)).toBe(expected);
  });

  it.each(["-1", "0.5", "1e6", "", " 1", "01", "1,000"])("rejects %j", (amount) => {
    expect(() => formatUsd(amount)).toThrow(InvalidAmountError);
  });

  it("is exact beyond the float range", () => {
    expect(formatUsd("9007199254740993000000")).toBe("$9,007,199,254,740,993.00");
  });
});

// No other currency path exists in the web app (T-080): no fxSource, no ISO 4217 code other than USD.
const OTHER_CURRENCIES =
  /\b(EUR|GBP|JPY|INR|CNY|RMB|CAD|AUD|CHF|SEK|NOK|DKK|NZD|SGD|HKD|KRW|BRL|MXN|ZAR|TRY|RUB|AED|SAR|PLN|IDR|THB|MYR|PHP|VND|NGN)\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(tsx?|jsx?|mjs|json|css)$/.test(name) ? [path] : [];
  });
}

describe("USD only", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const files = sourceFiles(root).filter((path) => !path.endsWith("format.test.ts"));

  it("has no fxSource and no other currency code", () => {
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text.includes("fxSource"), file).toBe(false);
      expect(OTHER_CURRENCIES.test(text), file).toBe(false);
    }
  });
});
