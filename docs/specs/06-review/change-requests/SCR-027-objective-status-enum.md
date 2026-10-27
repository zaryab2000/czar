# SCR-027: Objective status values differ between the CZ-12 state machine and the OpenAPI enum.

| Field | Value |
|---|---|
| ID | SCR-027 |
| Filed by | Independent reviewer (G0-01), 2026-10-19 |
| Spec and section | `docs/specs/04-components/server/server-planning-and-payment.md` CZ-12 (lines 33–47); `docs/specs/02-data-and-protocol/api/openapi.yaml` (line 163); `mcp/czar-mcp-tools.md` (line 41) |
| Status | Accepted, applied in `openapi.yaml` (`ObjectiveStatusValue`), CZ-12 §5 and §12, MCP `get_objectives`, `docs/specs/04-components/local/local-soul-and-drives.md` §5.7 (`serverStatus`), scenario 3.2; T-009, T-041, T-073. |
| Review finding | RV-027 (High) in `docs/specs/06-review/2026-10-19-spec-review.md` |

## Problem
- `opening`, `replanning`, `expired`, `dismissed` are missing from the API; `approved`, `accepted`, `closed`, `cancelled` are never produced; underscores vs hyphens.

## Evidence
- CZ-12 states: `received`, `planning`, `no_supplier`, `awaiting_approval`, `opening`, `executing`, `replanning`, `delivered`, `failed`, `expired`, `dismissed`.
- OpenAPI: `enum: [received, planning, no-supplier, awaiting-approval, approved, executing, accepted, delivered, failed, closed, cancelled]`.
- MCP `get_objectives` and `docs/specs/04-components/local/local-soul-and-drives.md` line 429 use the hyphenated API forms.
- Failure scenario:
  1. `getObjective` for an objective in `opening` fails response validation in the T-009 harness; daemon `?status=` filters miss rows stored with underscores.

## Proposed change
- Make the OpenAPI enum canonical; rename CZ-12 states to hyphens; add the four missing states; drop or map the unused ones.

## Affected tasks
- T-009, T-041, T-067, T-072, T-073 (M0, M3, M5)

## Decision
- Accepted under Zaryab's 2026-10-19 instruction to apply every review fix (D71–D81 record the decisions he approved for the items that needed one).
- Applied 2026-10-19 on branch `spec/review-fixes`: Accepted, applied in `openapi.yaml` (`ObjectiveStatusValue`), CZ-12 §5 and §12, MCP `get_objectives`, `docs/specs/04-components/local/local-soul-and-drives.md` §5.7 (`serverStatus`), scenario 3.2; T-009, T-041, T-073.
