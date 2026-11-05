// The two audit services (SCR-182 §1): service names (also the K10 key ids), paths, display names and the
// 402 discovery wording. Both say they are run by Czar.
export type AuditKind = "quick" | "deep";

export const AUDIT_KINDS = ["quick", "deep"] as const satisfies readonly AuditKind[];

export interface AuditService {
  /** As in `K10:<serviceName>` and the catalog entry. */
  readonly serviceName: string;
  readonly path: string;
  readonly displayName: string;
  /** The 402 discovery description. */
  readonly description: string;
  readonly tags: readonly string[];
}

export const AUDIT_SERVICES: Readonly<Record<AuditKind, AuditService>> = {
  quick: {
    serviceName: "czar-audit-quick",
    path: "/v1/audit/quick",
    displayName: "Czar Lab Quick Audit",
    description: "Fast first-pass smart contract review. Run by Czar.",
    tags: ["audit", "code-review"],
  },
  deep: {
    serviceName: "czar-audit-deep",
    path: "/v1/audit/deep",
    displayName: "Czar Lab Deep Audit",
    description:
      "Thorough smart contract security review with severity, location and fix for each finding. Run by Czar.",
    tags: ["audit", "code-review"],
  },
};
