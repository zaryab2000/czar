# SCR-115: Declare S1 route error responses and add cursor and goal-retention parameters

| Field | Value |
|---|---|
| ID | SCR-115 |
| Filed by | Architect (Claude), 2026-10-21, from the S1 server-skeleton PRD review |
| Spec and section | `docs/specs/02-data-and-protocol/api/openapi.yaml` `pairDevice`, `submitObjective`, `listObjectives`, `getObjective`; `docs/specs/04-components/server/server-planning-and-payment.md` CZ-12 §5 Parameters; `packages/config/src/registry.ts` |
| Status | Open — awaiting Zaryab's acceptance. Blocks T-041 (and T-009's fixtures for these four operations). |

## Problem

- The four T-041 routes must return errors that OpenAPI does not declare. T-009 builds response validators per `operationId`, so the server's own valid problems would fail its contract tests:
  - no `401` on `submitObjective`, `listObjectives`, `getObjective` (DeviceToken auth; 02 §9.1 requires `401 device-revoked`);
  - no `503` on any of the four (CZ-12 §10: Postgres down → `503 upstream-unavailable`);
  - no `400` on `listObjectives` or `getObjective` (bad cursor, limit or path id);
  - no `429` on `getObjective` (02 §9.5: rate-limit headers and `429` on every response).
- `listObjectives`'s `status` query is a free `string`; it should be `ObjectiveStatusValue` (RV-027).
- Two fixed limits in the specs have no `@czar/config` key, and builder rules forbid both magic numbers and invented keys:
  - list cursor expiry, 1 h (02 §9.5);
  - goal text retention, 1 year (01 §11.1, CZ-12 §8).

## Evidence

- `openapi.yaml` responses: `submitObjective` 202/400/409/422/429; `listObjectives` 200/429; `getObjective` 200/404; `pairDevice` 201/400/409/429.
- `packages/config/src/registry.ts` has `api.idempotencyTtlHours`, `api.rateLimit*`, `app.pairingCodeTtlMinutes`, `app.sessionHours`; no cursor or goal-retention key.

## Proposed change

1. `openapi.yaml`:
   - `submitObjective`: add `401` and `503` (`#/components/responses/Problem`).
   - `listObjectives`: add `400`, `401`, `503` (Problem); `status` parameter schema `$ref: "#/components/schemas/ObjectiveStatusValue"`.
   - `getObjective`: add `400`, `401`, `503` (Problem) and `429` (`#/components/responses/RateLimited`).
   - `pairDevice`: add `503` (Problem).
2. CZ-12 §5 Parameters and `@czar/config`:
   - `api.cursorTtlMinutes` 60 — opaque list cursors expire after 1 h (02 §9.5).
   - `api.goalRetentionDays` 365 — goal text deleted after 1 year (01 §11.1, CZ-12 §8).
3. T-009: its contract tests for these four operations accept the new responses.

No new route, field, status value or behaviour; this only declares what the specs already require.

## Affected tasks

- T-041 (blocks), T-009 (fixtures), T-004 (registry entries).

## Decision

- Pending Zaryab.
