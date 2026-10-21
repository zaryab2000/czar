# SCR-120: Planner defaults the rule-based plan needs

| Field | Value |
|---|---|
| ID | SCR-120 |
| Filed by | Architect (Claude), 2026-10-21, from the T-045 pre-build review |
| Spec and section | CZ-13 §5 Parameters and §6 fallback (`server-planning-and-payment.md`); 02 §4.6 `callInputs`; `plan.schema.json` `droppedSteps[].reason` |
| Status | Accepted (Zaryab, 2026-10-21; architect ruling under his delegation to make T-045 buildable in one pass) |

## Problem

- No parameter sets `Plan.expiresAt` (the envelope expiry) for a plan without job steps.
- The rule-based fallback names default template strings but not the input key they fill; merchants name their own input keys (Czar's `czar-search` takes `q`).
- Capabilities other than `web-search` and `page-extract` have no default template, and `droppedSteps[].reason` allowed only `no-agent`.
- 02 §4.6 wrote `callInputsHash = H(jcs(callInputs))`, but `H` already applies `jcs`.
- "marked `fallbackPlanner: true` in `routingReason`" did not say how, since `routingReason` is a string.

## Decision

- `planner.envelopeTtlHours` 48 (24 h approval window plus 24 h to run); job steps raise it (CZ-13 6b); never beyond `MAX_ENVELOPE_DURATION` (30 days).
- The fallback binds the default template to the candidate card's single `string` input field (`maxLength` 1000); candidates without exactly one such field are skipped in the fallback (`why` reason `output-format`).
- Capabilities without a default template are dropped in the fallback with the new reason `no-template` (schema enum extended; `@czar/schemas` regenerated).
- `callInputsHash = H(callInputs)` = `keccak256(jcs(callInputs))`.
- Fallback plans append `;fallback-planner` to each paid step's `routingReason`.

## Affected tasks

- T-045 (planner core), T-092 (P-03 planner).
