import { profileId } from "@czar/hashing";

export interface DataJsonProfile extends Readonly<Record<string, unknown>> {
  readonly profile_id: string;
  readonly task_class: "data-json";
  readonly version: 1;
  readonly code_hash: string;
}

export function dataJsonProfile(codeHash: string): DataJsonProfile {
  const core = {
    task_class: "data-json" as const,
    version: 1 as const,
    input_generator: { kind: "parametric", spec: {} },
    checks: [
      {
        name: "delivery",
        kind: "delivery",
        dimension: "delivery",
        spec: {
          timeoutMs: "acceptance.deliveryTimeoutMs",
          maxBodyBytes: "acceptance.maxBodyBytes",
        },
      },
      {
        name: "structural",
        kind: "structural",
        dimension: "structural",
        spec: {
          validator: "ajv@8.20.0",
          draft: "2020-12",
          schemaMaxBytes: "acceptance.schemaMaxBytes",
        },
      },
      {
        name: "requirement",
        kind: "requirement",
        dimension: "requirement",
        spec: { keys: "inputTemplate.expectedKeys" },
      },
    ],
    tolerances: {},
    abstain_rules: {},
    cost_estimate_usd: 0,
    receipt_checks: ["delivery", "structural", "requirement"],
    limits: ["no-correctness-check"],
    code_hash: codeHash,
  };
  return { profile_id: profileId(core), ...core };
}
