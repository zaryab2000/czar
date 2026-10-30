// Signer counters under the cross-cutting §4 metrics rules: `czar_<component>_<metric>`, enum labels only.

/** The keys `czar_signer_gas_low` is labelled with (CZ-27 §5.5). */
export const GAS_LOW_KEYS = ["K3", "K7", "K8", "relayer"] as const;
export type GasLowKey = (typeof GAS_LOW_KEYS)[number];

export interface SignerMetrics {
  incrementGasLow(key: GasLowKey): void;
  gasLowCount(key: GasLowKey): number;
  /** Every signer counter in the Prometheus text exposition format. */
  render(): string;
}

/** In-process signer counters; every series starts at zero so a scrape always sees all keys. */
export function createSignerMetrics(): SignerMetrics {
  const gasLow = new Map<GasLowKey, number>(GAS_LOW_KEYS.map((key) => [key, 0]));
  return {
    incrementGasLow(key) {
      gasLow.set(key, (gasLow.get(key) ?? 0) + 1);
    },
    gasLowCount: (key) => gasLow.get(key) ?? 0,
    render() {
      const lines = [
        "# HELP czar_signer_gas_low Signer gas key found low or not refilled (CZ-27 §5.5).",
        "# TYPE czar_signer_gas_low counter",
        ...GAS_LOW_KEYS.map((key) => `czar_signer_gas_low{key="${key}"} ${gasLow.get(key) ?? 0}`),
      ];
      return `${lines.join("\n")}\n`;
    },
  };
}
