import type { Config } from "@czar/config";
import type { AcceptanceReport, Step } from "@czar/schemas";
import type { Logger } from "@czar/logging";
import type { Pool } from "pg";

export type ScreenOutcome =
  | { readonly available: true; readonly label: "none" | "injection-suspect" | "pii-suspect" }
  | { readonly available: false };

export interface AcceptanceCheckInput {
  readonly obsId: string;
  readonly profileId: string;
  readonly envelopeRef: string;
  readonly stepIndex: number;
  readonly jobKey?: string;
  readonly bodyRef?: string;
  readonly serviceId: string;
  readonly step: Step;
  readonly bodyText: string | null;
  readonly statusCode: number | null;
  readonly responseArrived: boolean;
  readonly elapsedMs: number;
  readonly maxTimeoutSeconds: number;
  readonly mimeType: string;
  readonly paid: boolean;
  readonly screen: ScreenOutcome;
  readonly deliveredAsIs?: boolean;
  readonly outputFormat?: "markdown-table" | "csv" | "json" | "markdown-list" | "prose";
}

export interface AcceptancePorts {
  readonly outputSchema: {
    forService(serviceId: string): Promise<Readonly<Record<string, unknown>> | null>;
  };
  readonly shapeHistory: { forService(serviceId: string): Promise<string | null> };
  readonly validatorIdentity: { address(): Promise<string> };
  readonly clock: { now(): Date };
}

export interface AcceptanceDependencies {
  readonly pool: Pool;
  readonly config: Config;
  readonly ports: AcceptancePorts;
  readonly logger: Logger;
}

export interface AcceptanceResult {
  readonly report: AcceptanceReport;
  readonly stepResultFlags: readonly "schema-mismatch"[];
}
