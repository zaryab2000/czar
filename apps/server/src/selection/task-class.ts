import type { Config } from "@czar/config";

/**
 * The CZ-18 task class of a capability (`planner.capabilityToTaskClass`, identity when unmapped).
 * SCR-160 §9.1: observations, ratings and supplier_counts are keyed by this value, and selection
 * reads counts by it, so the planner and every payer write path must derive it here.
 */
export function taskClassFor(capability: string, config: Config): string {
  const mapping = config.get("planner.capabilityToTaskClass") as Record<string, string>;
  return mapping[capability] ?? capability;
}
