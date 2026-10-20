# SCR-025: The ERC-8183 job brief and `inputCommit` are never defined, so a real provider cannot learn the task and `descriptionHash` cannot be computed.

| Field | Value |
|---|---|
| ID | SCR-025 |
| Filed by | Independent reviewer (G0-01), 2026-10-19 |
| Spec and section | `docs/specs/04-components/server-planning-and-payment.md` CZ-15 (line 366); `docs/specs/02-data-and-protocol/data-and-protocol.md` (lines 334, 452) |
| Status | Accepted, applied in spec 02 §4.21 (`JobBrief`), §5.2 (`inputCommit`), §6.2 (`BriefRequest` type), §6.4 vector, §9.2 (`getJobBrief`); `schemas/job-brief.schema.json`; `openapi.yaml`; CZ-15 §5.4; T-054. |
| Review finding | RV-025 (High) in `docs/specs/06-review/2026-10-19-spec-review.md` |

## Problem
- `inputCommit` is defined nowhere (grep over specs, schemas, OpenAPI).
- There is no route, schema, auth rule or privacy class for the brief; T-054 never publishes one.
- The D53 deliverable URI convention is "stated in the job brief" (spec 02 line 334).

## Evidence
- CZ-15: "The job brief (structured, from `inputTemplate`) is published off-chain at a URI the provider fetches".
- Spec 02 line 452: `descriptionHash` uses `inputCommit`.
- Grep results as above.
- Failure scenario:
  1. T-054 cannot compute `descriptionHash`. If the brief is put at a public URL, objective-derived `inputTemplate` values leak.

## Proposed change
- Define a `JobBrief` schema and `inputCommit`; add `GET /v1/jobs/{jobKey}/brief` authenticated by the provider's signature; class `server-only`.

## Affected tasks
- T-007, T-054, T-055 (M0, M4)

## Decision
- Accepted under Zaryab's 2026-10-19 instruction to apply every review fix (D71–D81 record the decisions he approved for the items that needed one).
- Applied 2026-10-19 on branch `spec/review-fixes`: Accepted, applied in spec 02 §4.21 (`JobBrief`), §5.2 (`inputCommit`), §6.2 (`BriefRequest` type), §6.4 vector, §9.2 (`getJobBrief`); `schemas/job-brief.schema.json`; `openapi.yaml`; CZ-15 §5.4; T-054.
