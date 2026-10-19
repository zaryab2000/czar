# SCR-020: The MCP `pay` tool and the OpenAPI `createPayRequest` have incompatible request and response shapes.

| Field | Value |
|---|---|
| ID | SCR-020 |
| Filed by | Independent reviewer (G0-01), 2026-10-19 |
| Spec and section | `specs/02-data-and-protocol/mcp/czar-mcp-tools.md` `pay` (lines 201, 222); `specs/02-data-and-protocol/api/openapi.yaml` `PayRequest`/`PayResponse` (lines 240–264); `data-and-protocol.md` §7.1 (line 593) |
| Status | Accepted (D75), applied in `openapi.yaml` (`PayRequest`, `PayResponse`, `QuoteResponse`), MCP §2.3–§2.4 (copies of the API schemas), spec 02 §7.1 (`quoteId`, `payRequestId`), §9.2, §10; T-009. |
| Review finding | RV-020 (High) in `specs/06-review/2026-10-19-spec-review.md` |

## Problem
- The MCP server cannot build a valid `PayRequest` (it has no `capability`), and the API has no `quoteId` field to resolve.
- The MCP output fields have no source in the API response.

## Evidence
- MCP: `"required": ["paymentId", "idempotencyKey", "quoteId"]`; output status `["executing", "accepted", "rejected", "failed"]` with `paymentId`, `envelopeRef`, `stepIndex`, `amount`, `settlement`, `result`.
- OpenAPI: `required: [paymentId, idempotencyKey, stepRequest]`, `additionalProperties: false`, `stepRequest` requires `[capability, maxAmount]`; `PayResponse` `required: [status]`, `enum: [executing, approval-required, rejected]`.
- Spec 02 line 593: `quoteId` is for "shadow-mode quotes" only.
- CZ-12 line 81 says `createPayRequest` must "resolve the quote".
- Failure scenario:
  1. T-072 and T-071 are built to their own specs; the T-009 contract tests fail one side; MCP `pay` never works end to end.

## Proposed change
- Pick one contract: add `quoteId` to `PayRequest` (relax `stepRequest`) and extend `PayResponse` with `paymentId`, `amount`, `settlement`, `result`, `accepted`, `failed`; or rewrite the MCP schema to the API.
- Fix the `quoteId` row in spec 02 §7.1.

## Affected tasks
- T-009, T-071, T-072 (M0, M5)

## Decision
- Accepted under Zaryab's 2026-10-19 instruction to apply every review fix (D71–D81 record the decisions he approved for the items that needed one).
- Applied 2026-10-19 on branch `spec/review-fixes`: Accepted (D75), applied in `openapi.yaml` (`PayRequest`, `PayResponse`, `QuoteResponse`), MCP §2.3–§2.4 (copies of the API schemas), spec 02 §7.1 (`quoteId`, `payRequestId`), §9.2, §10; T-009.
