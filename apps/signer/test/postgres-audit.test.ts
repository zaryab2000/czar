import { describe, expect, it } from "vitest";
import { postgresAudit, type AuditRow } from "../src/index.ts";

describe("PostgreSQL signer audit", () => {
  it("stores the denied decision and rule without request payload fields", async () => {
    let call: { sql: string; values: readonly unknown[] } | undefined;
    const audit = postgresAudit({
      async query(sql, values) {
        call = { sql, values };
      },
    });
    const row: AuditRow = {
      at: 1_760_800_000_000,
      caller: "cz-15",
      keyRef: "K3",
      kind: "vault-call",
      purpose: { envelopeRef: "12" },
      outcome: "kms_denied",
      rule: "selector-not-allowed",
    };

    await audit.write(row);

    expect(call?.sql).toContain("INSERT INTO audit");
    expect(call?.values[0]).toBe("cz-15");
    expect(call?.values[1]).toBe("signer:vault-call");
    expect(call?.values[3]).toBe("kms_denied");
    expect(JSON.parse(call?.values[2] as string)).toEqual([
      {
        keyRef: "K3",
        purpose: { envelopeRef: "12" },
        rule: "selector-not-allowed",
      },
    ]);
    expect(call?.values.join(" ")).not.toContain("payload");
  });
});
