# SCR-024: T-055 rejects a job on a deliverable hash mismatch; the spec says `inconclusive`.

| Field | Value |
|---|---|
| ID | SCR-024 |
| Filed by | Independent reviewer (G0-01), 2026-10-19 |
| Spec and section | `specs/05-build-plan/phase-1-tasks.md` T-055 (line 766); `specs/04-components/server-acceptance-evidence-selection.md` CZ-16 (line 277) |
| Status | Open |
| Review finding | RV-024 (High) in `specs/06-review/2026-10-19-spec-review.md` |

## Problem
- `reject` refunds and permanently fails the provider; `inconclusive` retries until expiry. The task and the spec disagree.

## Evidence
- T-055: "a mismatch calls `reject`".
- CZ-16: bytes "must hash … to `deliverable`, else `inconclusive` with `detail.hashMismatch`".
- Builder rules: specs are the source of truth, but tasks list the acceptance tests the builder must pass.
- Failure scenario:
  1. A CDN serves a stale copy once; the evaluator rejects an honest provider, who is unpaid and down-ranked.

## Proposed change
- Align T-055 with CZ-16, or change CZ-16 through an SCR; state it once.

## Affected tasks
- T-055 (M4)

## Decision
- <filled in by Zaryab: accepted or rejected, and why>
