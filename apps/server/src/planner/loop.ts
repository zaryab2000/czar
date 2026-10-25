import type { Config } from "@czar/config";
import type { Pool } from "pg";
import { reclaimStalePlanningClaims } from "#src/planner/service";

export interface PlannerLoopDependencies {
  readonly pool: Pool;
  readonly config: Config;
  readonly processNextReceived: () => Promise<boolean>;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
}

export async function pollPlannerOnce(dependencies: PlannerLoopDependencies): Promise<boolean> {
  await reclaimStalePlanningClaims(
    dependencies.pool,
    Number(dependencies.config.get("planner.claimTimeoutSeconds")),
    (dependencies.now ?? (() => new Date()))(),
  );
  return dependencies.processNextReceived();
}

export function startPlannerLoop(dependencies: PlannerLoopDependencies): {
  stop(): Promise<void>;
} {
  let stopped = false;
  let running: Promise<void> | undefined;
  const poll = () => {
    if (stopped || running) return;
    running = pollPlannerOnce(dependencies)
      .then(() => undefined)
      .catch((error: unknown) => dependencies.onError?.(error))
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(poll, Number(dependencies.config.get("planner.pollMs")));
  poll();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
