import { describe, expect, it } from "vitest";
import { healthFacts, type HealthRow } from "#src/evidence/health";

const base: HealthRow = {
  obsId: `obs_${"1".repeat(32)}`,
  userId: "usr_owner",
  network: "eip155:5042002",
  serviceId: `svc_${"2".repeat(32)}`,
  versionId: "ver_unknown",
  rail: "x402-exact" as const,
  settledAt: null,
  releasedAt: null,
  delivered: null,
  jobState: null,
};

function row(index: number, changes: Partial<HealthRow> = {}): HealthRow {
  return { ...base, obsId: `obs_${index.toString(16).padStart(32, "0")}`, ...changes };
}

const config = { consecutiveFailures: 3 };

describe("SCR-160 health facts", () => {
  it("H1 requires a settled undelivered payment after retries, not a pending response", () => {
    const paid = row(1, { settledAt: new Date(), delivered: 0 });
    const pending = row(2, { settledAt: new Date() });
    expect(healthFacts([paid, pending], [], config)).toEqual([
      { fact: "settled-not-delivered", obsId: paid.obsId },
    ]);
    expect(
      healthFacts([pending], [{ kind: "retry-exhausted", obsId: pending.obsId }], config),
    ).toEqual([{ fact: "settled-not-delivered", obsId: pending.obsId }]);
  });

  it("H2 requires three consecutive releases and a settlement resets the run", () => {
    const released = [1, 2, 3].map((index) => row(index, { releasedAt: new Date() }));
    expect(healthFacts(released.slice(0, 2), [], config)).toEqual([]);
    expect(healthFacts(released, [], config)).toContainEqual({
      fact: "repeated-unsettled-failure",
      obsId: released[0]?.obsId,
    });
    expect(
      healthFacts(
        [released[0]!, row(4, { settledAt: new Date(), delivered: 1 }), ...released.slice(1)],
        [],
        config,
      ),
    ).toEqual([]);
  });

  it("H3 requires complete mined history and excludes submitted expiry", () => {
    const expired = row(1, {
      rail: "erc8183-job",
      settledAt: new Date(),
      jobState: "Expired",
    });
    expect(healthFacts([expired], [], config)).toEqual([]);
    expect(
      healthFacts(
        [expired],
        [{ kind: "job-history", obsId: expired.obsId, submitted: false }],
        config,
      ),
    ).toEqual([{ fact: "job-failed", obsId: expired.obsId }]);
    expect(
      healthFacts(
        [expired],
        [{ kind: "job-history", obsId: expired.obsId, submitted: true }],
        config,
      ),
    ).toEqual([]);
  });

  it("H3 accepts only verified supplier-failure rejection reasons", () => {
    const job = row(1, { rail: "erc8183-job", settledAt: new Date() });
    for (const reason of ["report-fail", "czar:deliverable-missing", "czar:late"] as const) {
      expect(
        healthFacts([job], [{ kind: "job-rejected", obsId: job.obsId, reason }], config),
      ).toEqual([{ fact: "job-failed", obsId: job.obsId }]);
    }
    for (const reason of [
      "czar:undecided",
      "czar:fees-changed",
      "czar:owner-froze",
      "czar:unfunded-submit",
      "unknown",
    ] as const) {
      expect(
        healthFacts([job], [{ kind: "job-rejected", obsId: job.obsId, reason }], config),
      ).toEqual([]);
    }
  });

  it("H3 does not recast an excluded rejection as a funded expiry", () => {
    const expired = row(1, {
      rail: "erc8183-job",
      settledAt: new Date(),
      jobState: "Expired",
    });
    expect(
      healthFacts(
        [expired],
        [
          { kind: "job-history", obsId: expired.obsId, submitted: false },
          { kind: "job-rejected", obsId: expired.obsId, reason: "czar:undecided" },
        ],
        config,
      ),
    ).toEqual([]);
  });

  it("H4 requires an injection quarantine with the screen available", () => {
    const paid = row(1);
    expect(
      healthFacts(
        [paid],
        [{ kind: "boundary", obsId: paid.obsId, flags: ["injection-quarantined"], limits: [] }],
        config,
      ),
    ).toEqual([{ fact: "injection-blocked", obsId: paid.obsId }]);
    expect(
      healthFacts(
        [paid],
        [
          {
            kind: "boundary",
            obsId: paid.obsId,
            flags: ["injection-quarantined"],
            limits: ["screen-unavailable"],
          },
        ],
        config,
      ),
    ).toEqual([]);
  });
});
