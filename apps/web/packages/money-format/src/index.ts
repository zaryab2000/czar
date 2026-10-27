// USD-only money formatter for the web app (CZ-22, D51). USDC amounts are 6-decimal integer strings
// (`Amount6`) and display as US dollars 1:1. There is no exchange-rate path: Phase 1 shows USD only.
// Integer arithmetic only, never floats.

const AMOUNT6 = /^(0|[1-9][0-9]*)$/;
const USDC_DECIMALS = 6;
const MIN_FRACTION_DIGITS = 2;
const UNIT = 10n ** BigInt(USDC_DECIMALS);

export class InvalidAmountError extends Error {
  constructor() {
    super("amount must be a USDC 6-decimal integer string (Amount6)");
    this.name = "InvalidAmountError";
  }
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * `"880000"` → `"$0.88"`, `"1000"` → `"$0.001"`, `"1000000"` → `"$1.00"`, `"1234500000"` → `"$1,234.50"`.
 * Shows at least two decimals and up to six, dropping trailing zeros past the cents.
 */
export function formatUsd(amount6: string): string {
  if (!AMOUNT6.test(amount6)) throw new InvalidAmountError();
  const value = BigInt(amount6);
  const whole = value / UNIT;
  let fraction = (value % UNIT).toString().padStart(USDC_DECIMALS, "0");
  while (fraction.length > MIN_FRACTION_DIGITS && fraction.endsWith("0"))
    fraction = fraction.slice(0, -1);
  return `$${groupThousands(whole.toString())}.${fraction}`;
}
