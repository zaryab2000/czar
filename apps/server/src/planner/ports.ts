import type { PaymentRequirements, SanitizedExtensions } from "@czar/x402";
import type { RankingDecision, TaskSpec } from "@czar/schemas";

export interface RankingQuery {
  readonly userId?: string;
  readonly taskClass: string;
  readonly capability: string;
  readonly taskSpec: Pick<TaskSpec, "kind" | "topic" | "fields" | "output">;
  readonly networks: readonly string[];
  readonly rails: readonly ["x402-exact", "gateway-batched", "erc8183-job"];
  readonly max_price_atomic: string;
  readonly unknown_policy: "exclude";
}

export interface PlannerService {
  readonly serviceId: string;
  readonly resource: { readonly url: string; readonly method: "GET" | "POST" | "PUT" | "DELETE" };
  readonly probeInput?: {
    readonly query?: Readonly<Record<string, string>>;
    readonly body?: Readonly<Record<string, unknown>>;
  };
  readonly accepts: readonly PaymentRequirements[];
  readonly providerAddress?: string;
  readonly listedPrice?: string;
  readonly jobDurationSeconds?: number;
  readonly extensions: {
    readonly czar: {
      readonly claim: { readonly status: string };
      readonly evidence: {
        readonly deliveryLcb: number;
        readonly structuralLcb: number;
        readonly nEff: number;
        readonly badges: readonly string[];
      } | null;
      readonly card: Record<string, unknown>;
      readonly source: string;
    };
  };
}

export type ProbeResult =
  | {
      readonly ok: true;
      readonly offers: readonly PaymentRequirements[];
      readonly extensions402?: SanitizedExtensions;
    }
  | { readonly ok: false; readonly reason: "timeout" | "malformed" | "unavailable" };

export interface PlannerPorts {
  readonly ranking: { rank(query: RankingQuery): Promise<RankingDecision> };
  readonly directory: { get(serviceId: string): Promise<PlannerService | null> };
  readonly profiles: { profileIdFor(taskClass: string): string };
  readonly pocketKeys: { createPocketKey(planId: string): Promise<string> };
  readonly agentHosts: { hasAgentHost(deviceId: string): Promise<boolean> };
  readonly allowance: { remaining(userId: string, categoryId: string): Promise<string> };
  readonly health?: {
    openOwnerFacts(userId: string, network: string, serviceId: string): Promise<readonly string[]>;
    isInjectionBlocked(network: string, serviceId: string): Promise<boolean>;
  };
  readonly prober: {
    probe(
      resource: PlannerService["resource"],
      probeInput?: PlannerService["probeInput"],
    ): Promise<ProbeResult>;
  };
}
