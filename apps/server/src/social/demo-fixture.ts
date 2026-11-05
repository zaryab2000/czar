import type { TaskSpec } from "@czar/schemas";
import type { SeedableFixture, SupplierFixture } from "#src/social/controlled-fixtures";

interface DemoSupplier {
  readonly serviceId: string;
  readonly payTo: string;
  readonly resource: { readonly url: string; readonly method: "POST" };
}

export function auditTaskSpec(): TaskSpec {
  return {
    schemaVersion: "1.1",
    kind: "list-fill",
    topic: "Controlled smart contract audit history",
    subjects: [{ label: "Czar demonstration contract" }],
    fields: ["severity", "location", "issue", "fix"],
    sourceTrust: "user-prompt",
    output: { format: "json", formatSource: "default" },
  };
}

function supplier(key: string, input: DemoSupplier): SupplierFixture {
  if (!/^svc_[0-9a-f]{32}$/.test(input.serviceId) || !/^0x[0-9a-fA-F]{40}$/.test(input.payTo)) {
    throw new Error(`Demo supplier ${key} needs a verified service ID and payee.`);
  }
  return {
    key,
    serviceId: input.serviceId,
    resource: input.resource,
    payTo: input.payTo.toLowerCase(),
    capability: "code-review",
    taskClass: "smart-contract-audit",
  };
}

/** Build one rated objective per outcome, keeping old and recent evidence distinct. */
export function buildDemoFixture(input: {
  readonly quick: DemoSupplier;
  readonly deep: DemoSupplier;
}): SeedableFixture {
  const experiences: SeedableFixture["experiences"] = [];
  function add(owner: string, supplierKey: string, value: "good" | "bad", days: number): void {
    const key = `${owner}-${supplierKey}-${value}-${experiences.length}`;
    experiences.push({
      key,
      owner,
      supplier: supplierKey,
      objectiveState: "delivered",
      taskSpec: auditTaskSpec(),
      step: { stepIndex: 0, kind: "x402-exact", unitAmount: "50000" },
      observations: [{ callIndex: 0, delivered: 1, settledDaysAgo: days }],
      rating: { value, surface: "web" },
    });
  }
  for (const owner of ["test-one", "test-two", "test-three"]) {
    for (let i = 0; i < 6; i += 1) add(owner, "quick", "good", 20 + i);
  }
  add("test-two", "quick", "bad", 2);
  add("test-three", "quick", "bad", 1);
  for (const owner of ["test-one", "test-two"]) {
    add(owner, "deep", "good", 30);
    add(owner, "deep", "good", 31);
  }
  add("test-three", "deep", "good", 32);
  add("test-three", "deep", "bad", 33);
  return {
    network: "eip155:5042002",
    owners: [
      { key: "test-one", controlled: true, sharing: "structured", handle: "Rep-CZ01" },
      { key: "test-two", controlled: true, sharing: "structured", handle: "Rep-CZ02" },
      { key: "test-three", controlled: true, sharing: "structured", handle: "Rep-CZ03" },
    ],
    suppliers: [supplier("quick", input.quick), supplier("deep", input.deep)],
    experiences,
  };
}
