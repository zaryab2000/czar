# SCR-018: The specs contradict each other on whether the planner (P-03) receives merchant-derived `StepResult` text.

| Field | Value |
|---|---|
| ID | SCR-018 |
| Filed by | Independent reviewer (G0-01), 2026-10-19 |
| Spec and section | `specs/04-components/server-planning-and-payment.md` (lines 141, 165 vs 385, 388); `specs/01-system-architecture/system-architecture.md` (lines 1032, 1034); `specs/02-data-and-protocol/data-and-protocol.md` (lines 375, 388); `phase-1-acceptance-scenario.md` 4.6 (line 51) |
| Status | Open |
| Review finding | RV-018 (High) in `specs/06-review/2026-10-19-spec-review.md` |

## Problem
- `StepResult.fields[].value` is free merchant text (up to 2,000 chars × 50 fields, copied verbatim by P-02).
- P-03's input table in `ai-prompts.md` (lines 113–119) has no StepResult input and no tools; spec 01 describes planner tools such as `pay_step(stepId)` while CZ-15 §7 says the paying agent uses no model.

## Evidence
- CZ-13 line 141: "The prompt never receives descriptions or any text from merchants (`ai-prompts.md` P-03)."
- §5.6 line 385: "planner / paying agent | P-03, code | **only** `StepResult` objects, schema-validated, wrapped in a labelled `tool_result`".
- Spec 02 line 375: StepResult is "the only form in which untrusted merchant output reaches the planner".
- Quotes above conflict within one file and across specs 01/02/04.
- Failure scenario:
  1. A builder of re-planning (CZ-13, T-092) follows spec 01/02 and feeds StepResults into P-03.
  2. An injection P-01 missed (for example past its 20,000-char window, RV-041) now steers which listed service P-03 picks.

## Proposed change
- State one rule: P-03 never receives StepResult. Re-planning gets only `{stepIndex, StepError.code, flags}`.
- Delete the planner-tools wording from spec 01 §13; correct spec 02 §4.15 and scenario 4.6.

## Affected tasks
- T-045, T-046, T-092, T-101 (M3, M7, M8)

## Decision
- <filled in by Zaryab: accepted or rejected, and why>
