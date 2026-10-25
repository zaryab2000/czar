# SCR-140: Deliver public wallet configuration before sign-in

| Field | Value |
|---|---|
| ID | SCR-140 |
| Filed by | Lane Orchestrator, 2026-10-25, from TA-13 preflight |
| Spec and section | CZ-22 §4; 02 §9.2; OpenAPI `getMe` and app routes; SCR-135 |
| Status | Proposed for Zaryab's approval by merge; applied in this branch |

## Problem

- SCR-135 requires `app.circleClientUrl`, `app.circleClientKey` and `app.arcRpcUrl`
  without defining how browser code obtains them. `Me` has no configuration fields.
- Passkey registration derives the counterfactual smart-account address with an Arc
  RPC call **before** a session exists. The existing authenticated `GET /v1/me`
  headers cannot provide its RPC URL.
- The browser currently falls back to local test values. A static build with those
  defaults can silently use the wrong RPC or Circle endpoint.

## Decision

Use one same-origin, unauthenticated, read-only endpoint:

`GET /v1/app/wallet-config` (`getAppWalletConfig`) → `200 AppWalletConfig`.

The body contains exactly these public values from the server's validated
`@czar/config`: `circleClientUrl`, `circleClientKey` (K2, public-facing),
`arcRpcUrl`, `bundlerOrder`, and `bundlerEndpoints`. The OpenAPI component is
normative. No new config key, credential, chain choice or wallet transport is
introduced. The server sends `Cache-Control: no-store`, does not require a
session, and never logs the body or full endpoint URLs. It supplies no
cross-origin access grant. The client fetches it from the current origin with
`cache: "no-store"` before its first chain read or wallet action, including
counterfactual address derivation during registration.

Missing or invalid values fail clearly before that operation. In particular,
there is no hardcoded localhost, test key, or `NEXT_PUBLIC_*` fallback. URL
validation allows HTTPS; HTTP is allowed only for loopback values under the
existing SCR-130 local-only guard. The server fails startup when its required
SCR-135 keys are missing. The browser validates the response and uses the same
configuration for passkey and wallet code. A page reload obtains fresh values.

This endpoint **replaces** the `X-Czar-Bundler-Order` and
`X-Czar-Bundler-Endpoints` delivery on `GET /v1/me`; `getMe` again returns only
the `Me` contract. There is one source for all browser wallet configuration.
The existing bundler order, endpoint selection, and transport behavior remain
unchanged. T-087 still owns secondary-bundler transport corrections.

## Evidence

- `apps/web/app/onboarding/passkey/page.tsx` calls `counterfactualMsca` before
  `registerPasskey`; `apps/web/packages/passkey.ts` uses an Arc RPC URL there.
- `apps/server/src/app/reads.ts` currently places bundler settings in `/v1/me`
  headers; `apps/web/packages/app-api.ts` reads them only after authenticated
  `getMe`. `apps/web/packages/wallet.ts` and `passkey.ts` contain test defaults.
- CZ-22 §4 names the three SCR-135 keys and K2's public-facing role. The
  OpenAPI `getMe` response is solely `Me`.

## Affected task and acceptance

TA-13 / T-082: implement the endpoint, browser loader and shared response
contract in one PR. Put any shared-package change in a separate small commit.
Test unauthenticated retrieval; missing or malformed config; registration
before a session; consistent RPC and Circle values across passkey and wallet;
no fallback; no wallet action when loading fails; and E2E with explicit local
config. Run package tests, typechecks and lint under D94. No live Circle,
Arc Anvil round trip, testnet or real-device check is added to TA-13.

## Approval

Zaryab's merge of the spec PR accepts this narrow integration contract. Until
then TA-13 remains gated; TA-15 is independent and can proceed.
