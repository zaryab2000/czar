import type { Logger } from "@czar/logging";

export type AlertRule = "dependency-upgraded" | "indexer-lag" | "reserve-rate";

export function createAlertReporter(logger: Pick<Logger, "error">) {
  return (rule: AlertRule, fields: Readonly<Record<string, unknown>>): void => {
    logger.error(rule.replaceAll("-", "_"), { ...fields, rule });
  };
}
