# SCR-124: Overall decision for inconclusive structural checks

| Field | Value |
|---|---|
| ID | SCR-124 |
| Filed by | T-047 builder, 2026-10-21 |
| Spec and section | CZ-16 §5.2–§5.3; T-047 acceptance tests; D55 |
| Status | Proposed |

## Problem

- CZ-16 §5.3 permits `pass` when `structural` is `inconclusive`, provided delivery passes and no check fails.
- T-047 acceptance explicitly requires no schema/no shape history to yield `structural: inconclusive` and an overall decision that is not `pass`; D55 says that result is never counted as a pass.

## Evidence

- `docs/specs/04-components/server/server-acceptance-evidence-selection.md` §5.2 records no-schema/no-history as structural `inconclusive` with `detail.parseOk = true`.
- Its §5.3 pass rule says `delivery pass ∧ structural ∉ {fail} ∧ requirement ∉ {fail}`.
- T-047 acceptance requires the overall decision to be not `pass` for the same no-history case.

## Proposed change

Amend the overall decision rule: any failed check yields `fail`; otherwise an inconclusive delivery, structural check, or sandbox run yields `inconclusive`; `pass` requires delivery `pass` and structural and requirement checks to be either `pass` or `not_checked`.

## Affected tasks

- T-047 Acceptance checker minimal
- T-055 ERC-8183 evaluator

## Decision

Pending. T-047 implements the stricter acceptance requirement and never counts a structural-inconclusive result as a pass.
