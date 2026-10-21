# SCR-113: Define pairing token replay and lifetime

| Field | Value |
|---|---|
| ID | SCR-113 |
| Filed by | Builder manager, 2026-10-21 |
| Spec and section | `docs/specs/02-data-and-protocol/data-and-protocol.md` §9.1 and §9.3; `docs/specs/02-data-and-protocol/api/openapi.yaml` `PairResponse` and `pairDevice` |
| Status | Open — revision requested from ARCHITECT AGENT |

## Problem

- `pairDevice` requires an `Idempotency-Key`. The general POST rule says that the same key and body replay the original response, but the pairing contract says the bearer token is returned only once. Replaying the original response would reveal the token again.
- `PairResponse.expiresAt` is required but neither the token lifetime nor a renewal or re-pair procedure is specified. The pairing code's five-minute expiry is defined, but that code is consumed by a successful exchange and is distinct from the issued bearer token.

## Evidence

- `openapi.yaml` defines `PairResponse` with required `deviceToken` and `expiresAt`; `deviceToken` is described as shown once. `pairDevice` also requires `Idempotency-Key`.
- `data-and-protocol.md` §9.1 says the server returns the device token once; §9.3 requires same-key/same-body response replay for creating POSTs and names only `completeModelCall` as an exception.
- `system-architecture.md` K15 lists app revocation for the device token but no expiry or renewal path.
- T-041 requires a passing `pairDevice` contract test. T-009 cannot lock a deterministic expected replay and response shape until this conflict is resolved.

## Proposed change

1. Amend spec 02 §9.3 with a narrow `pairDevice` exception: on a successful first call, return `201 PairResponse` containing the token. A retry with the same `Idempotency-Key` and byte-identical body returns `409` with `czarCode: replay-not-stored`; it never returns the bearer again. The server stores the request fingerprint and success marker, but never the raw token or a replayable response body. A different body under the same key still returns `409 idempotency-conflict`.
2. In `openapi.yaml`, remove `expiresAt` from `PairResponse` and its `required` list. State in spec 02 §9.1 that the Phase 1 device token remains valid until revoked in the app. Keep the pairing code's five-minute expiry unchanged.
3. Add T-009 contract cases for the first `201`, same-key/same-body `409 replay-not-stored`, same-key/different-body `409 idempotency-conflict`, and a revoked bearer returning `401 device-revoked`.

If a token expiry is intended instead, define its duration, renewal or re-pair flow, and `PairResponse.expiresAt` semantics in the canonical specs before T-041 implements pairing. Do not use the already-consumed code expiry as the token expiry.

## Affected tasks

- T-009, T-041, T-061; T-081/T-082 for the eventual app pairing flow.

## Decision

- 2026-10-21: Zaryab requested that the ARCHITECT AGENT revise this proposal. This is not acceptance of the proposed replay or lifetime behavior. The canonical specs remain unchanged.
- ARCHITECT AGENT: review the conflict and return one internally consistent recommendation for retry behavior, token lifetime, renewal or re-pair behavior, and the exact `PairResponse` schema. Cite the existing K15, OpenAPI and idempotency rules; identify every affected contract test. Apply no canonical change until the SCR acceptance process is complete.

- 2026-10-21, ARCHITECT AGENT (Claude) recommendation — one consistent rule set:
  - **Retry:** keep the proposal. `pairDevice` joins `completeModelCall` as a no-replay exception in 02 §9.3: same key and same body after success → `409 replay-not-stored`; different body → `409 idempotency-conflict`. The server stores key and fingerprint only, never the token or a replayable body. This keeps AM-18 ("shown once") and the general rule consistent by naming the exception, the same way RV-043 does.
  - **Lifetime:** the device token has no expiry in Phase 1 and is valid until revoked. This matches K15 and 02 §9.1, which define only revocation. Phase 1 runs on one Mac (D70), so a renewal protocol would add an unspecified flow for no gain.
  - **Lost first response:** the daemon cannot recover the token; it asks the person for a new 8-digit code (5-minute TTL). The consumed code cannot be reused. This is acceptable because pairing is a one-time, attended action.
  - **Renewal / re-pair:** re-pairing is the only renewal path: revoke the old device in the app, pair again with a new code. No new route.
  - **`PairResponse`:** `{deviceId, deviceToken}`, both required; `expiresAt` removed.
  - **Exact edits:** `docs/specs/08-server-build/01-server-skeleton.md` Appendix A items 1–2.
  - **Affected contract tests (T-009/T-041):** `pairDevice` first `201` without `expiresAt`; same-key/same-body `409 replay-not-stored`; same-key/different-body `409 idempotency-conflict`; revoked bearer on `submitObjective` → `401 device-revoked` (needs SCR-115's `401` declaration).
  - Not applied to canonical files until Zaryab accepts.
