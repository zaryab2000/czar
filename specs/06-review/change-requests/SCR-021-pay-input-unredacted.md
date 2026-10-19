# SCR-021: MCP `pay.input` sends arbitrary agent-supplied data to Czar's server and the merchant without redaction.

| Field | Value |
|---|---|
| ID | SCR-021 |
| Filed by | Independent reviewer (G0-01), 2026-10-19 |
| Spec and section | `specs/02-data-and-protocol/api/openapi.yaml` `PayRequest.stepRequest.input` (line 256); CZ-09 `pay` flow (`local-agent-surfaces.md` lines 77–83); spec 01 (line 962) |
| Status | Open |
| Review finding | RV-021 (High) in `specs/06-review/2026-10-19-spec-review.md` |

## Problem
- The `pay` flow checks only the JSON schema. Layers 1 and 2 never run on `input`.
- `input` is stored server-side (`step_executions.payload`, CZ-12 line 69) and forwarded to a merchant the agent may have chosen via `resourceUrl`.

## Evidence
- `input: { type: object, description: Structured input only; never free user text (layer 3). }` in a `redacted-to-server` object.
- Spec 01 line 962: "Layer 3 … is partial in Phase 1."
- The `redacted-to-server` class promises redaction that nothing performs on this field.
- Failure scenario:
  1. A careless or injected coding agent puts file contents, API keys or customer PII into `input`.
  2. The data is stored on Czar's server and sent to an outside merchant.

## Proposed change
- Constrain `input` to the capability's `inputTemplate` keys with types and length limits.
- Run layer-1 and layer-2 redaction in `czar-mcp` before forwarding; test with secret and PII fixtures.

## Affected tasks
- T-071, T-072 (M5)

## Decision
- <filled in by Zaryab: accepted or rejected, and why>
