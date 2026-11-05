import type { Config } from "@czar/config";

/** Reject a demo command before it opens a database connection or probes a supplier. */
export function assertDemoCommand(args: readonly string[], config: Config): void {
  if (args.length !== 2 || args[0] !== "--confirm" || !args[1]) {
    throw new Error("Demo command requires --confirm <deploy.environment>.");
  }
  if (config.get("demo.enabled") !== true) {
    throw new Error("Demo command requires demo.enabled = true.");
  }
  if (config.get("selection.paymentNetwork") !== "eip155:5042002") {
    throw new Error("Demo command requires Arc testnet eip155:5042002.");
  }
  if (args[1] !== config.get("deploy.environment")) {
    throw new Error("Demo confirmation does not match deploy.environment.");
  }
}
