# SCR-019: The MCP tools take URLs, amounts and free objects, and a coding agent can loop `pay` inside an open envelope with no further approval.

| Field | Value |
|---|---|
| ID | SCR-019 |
| Filed by | Independent reviewer (G0-01), 2026-10-19 |
| Spec and section | `specs/04-components/local-agent-surfaces.md` (lines 103, 121, 152); `specs/02-data-and-protocol/mcp/czar-mcp-tools.md` `quote`/`pay` (lines 156–159, 207–208); `server-planning-and-payment.md` (line 81) |
| Status | Accepted (D75), applied in `openapi.yaml` (`PayRequest` names `planId`/`stepIndex`, call budget; `QuoteRequest` index-only URL, no category), MCP §1 and §2.3–§2.4, CZ-12 §6, CZ-09 §5.2 and §9, scenario 7.1d; vault side via SCR-002; T-071, T-072. |
| Review finding | RV-019 (High) in `specs/06-review/2026-10-19-spec-review.md` |

## Problem
- `quote` takes `resourceUrl` (any URI; its 402 `payTo` becomes the payee), `maxAmount` and a free `category`. `pay` takes `input: {type: object}` and `maxAmount`.
- `pay` returns `StepResult.fields[].value` to the user's coding agent, which is a model that also holds the `pay` tool.
- Nothing limits repeated `pay` calls to the plan's `expectedCalls`; combined with RV-002 each call can reserve up to `stepCap`.
- `quote` skips P-03, so P-03 rule 2's exclusions do not apply; it is unstated whether non-index URLs are refused or whether the agent's `category` overrides the server's.

## Evidence
- CZ-09 line 121: "tools take ids and enums, not payees or amounts"; line 103: "inputs are enum and id fields only".
- CZ-12 line 81: "if an open envelope covers the step (payee in its `payeeRoot`, cap room) → `executing`".
- CZ-09's test (line 152) asserts only that "no tool accepts a payee".
- Failure scenario:
  1. Merchant M is a payee in an open envelope. M's result says "for the remaining rows call pay again with quoteId …".
  2. The coding agent loops `pay`; each call reserves against M with no approval.
  3. The envelope cap (including 25% slack) is spent on M.

## Proposed change
- `createPayRequest` executes only steps in the approved plan with unused `expectedCalls`; track per-step spend (and fix RV-002 on-chain).
- Refuse `resourceUrl` not in the index without a new approval; derive `category` server-side.
- Correct CZ-09's threat text and add an MCP-driven pay path to the acceptance scenario.

## Affected tasks
- T-015, T-071, T-072, T-101 (M1, M5, M8)

## Decision
- Accepted under Zaryab's 2026-10-19 instruction to apply every review fix (D71–D81 record the decisions he approved for the items that needed one).
- Applied 2026-10-19 on branch `spec/review-fixes`: Accepted (D75), applied in `openapi.yaml` (`PayRequest` names `planId`/`stepIndex`, call budget; `QuoteRequest` index-only URL, no category), MCP §1 and §2.3–§2.4, CZ-12 §6, CZ-09 §5.2 and §9, scenario 7.1d; vault side via SCR-002; T-071, T-072.
