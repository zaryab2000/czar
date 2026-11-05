# SCR-185: Plan schema limits that the audit path (SCR-182) exceeds

| Field | Value |
|---|---|
| ID | SCR-185 |
| Filed by | Claude (builder, BR-02), 2026-11-05 |
| Spec and section | `docs/specs/02-data-and-protocol/schemas/plan.schema.json`: `steps[].inputTemplate.inputKeys[].maxLength` and `approvalReasons`; `docs/specs/02-data-and-protocol/data-and-protocol.md` §4.5 |
| Status | Applied |

## Problem
- **SCR-182 §5 needs a 2000-character input key,** but `plan.schema.json` caps `inputKeys[].maxLength` at 1000. The planner validates every plan it builds, so a `code-review` plan at the SCR-182 default (`planner.inputMaxChars["code-review"]` = 2000) is rejected with "Planner created an invalid Plan". SCR-182 §2.1 of the builder brief lists the schema edits a builder may make; this one is not on it.
- **`approvalReasons` allows at most 4 items,** and SCR-182 adds a fifth possible value, `contract-sent`. A code-review plan whose supplier is unrated, in the exploration slot, has an open incident and has an uncleared health fact would carry five reasons and be rejected the same way.

## Evidence
- `plan.schema.json`, `inputKeys[].maxLength`: `"minimum": 1, "maximum": 1000`.
- `plan.schema.json`, `approvalReasons`: `"maxItems": 4`, with the enum `unrated`, `health-fact`, `exploration-slot`, `incident-open` (plus `contract-sent` from SCR-182).
- Test: `apps/server/test/planner/planner.test.ts`, "plans a code-review step at the default cap of 2000 characters" fails with `must be <= 1000` on `/steps/0/inputTemplate/inputKeys/0/maxLength`. It is marked `it.fails` until this request is applied.
- The pay-time check (`input-not-in-template`, `server-planning-and-payment.md` §4) compares input lengths with `inputKeys`, so capping `maxLength` at 1000 in the plan would reject any contract between 1001 and 2000 characters at payment.

## Proposed change
- `plan.schema.json`, `steps[].inputTemplate.inputKeys[].maxLength`: `"maximum": 1000` becomes `"maximum": 2000`.
- `plan.schema.json`, `approvalReasons`: `"maxItems": 4` becomes `"maxItems": 5`.
- Plan stays `schemaVersion "1.4"`. Neither field is in `planHash`.
- Add a change-log line to `data-and-protocol.md` citing SCR-185, and regenerate `packages/schemas` with `pnpm --filter @czar/schemas generate`.
- Then remove the `it.fails` marker in `planner.test.ts` (it starts failing once the schema accepts 2000).

## Affected tasks
- BR-02 (blocked until this is accepted and applied), BR-03, BR-04.

## Decision
- Accepted by the architect on Zaryab's instruction, 2026-11-05, and applied in PR #238.
