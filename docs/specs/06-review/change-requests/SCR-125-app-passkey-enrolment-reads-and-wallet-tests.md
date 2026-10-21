# SCR-125: App passkey enrolment and challenge, getMe data sources, local wallet test setup, T-086 split

| Field | Value |
|---|---|
| ID | SCR-125 |
| Filed by | Architect (Claude), 2026-10-21, from the Lane 5 builder's blocker report (T-081, T-082, T-084, T-086) |
| Spec and section | 02 `api/openapi.yaml` (app surface, `Me`); 02 §9.1; CZ-22 §5.2, §5.6, §14; CZ-19 §4; T-081, T-082, T-084, T-086 |
| Status | Accepted (Zaryab, 2026-10-21; architect ruling under his delegation so Lane 5 can finish in one pass) |

## Problem

- `createSession` verifies an assertion "over a server challenge", but no route issues a challenge. No route registers a passkey credential, and no table stores its public key, so neither `createSession` nor onboarding can be built securely.
- `Me.vault` is a required `Address`, but before `VaultCreated` there is no vault. CZ-22 §5.1 says "vault address predicted by the factory", and §5.2 says "VaultCreated seen (getMe.vault set)". The two rules conflict, and the app cannot tell a predicted vault from a created one.
- No spec says where `getMe` reads balances, limits, `frozen` and `paused` from. The indexer projects envelopes and reservations, but not limits, `frozen` or `paused`. It also has no owner-facing route to find a vault by owner or list envelopes by vault.
- `Me.limits[].category` is a name, but `LimitsSet` carries only `categoryId = keccak256(utf8(category))`. The onboarding limits screen has no list of categories to offer.
- CZ-22 §14 asks for "Playwright, local `arc-anvil` + mocked bundler", but the Circle MSCA factory, its modules and EntryPoint v0.7 do not exist on a fresh local chain. The rules also forbid a Circle client key (a sign-up) before the testnet stage (D92).
- T-086 depends on T-070 (shadow totals) and T-095 (ROI ledger and `getMonthlyStatement`). Neither is built, so T-086 cannot be finished in full.

## Decision

### 1. Passkey challenge and enrolment (new routes, app surface)

- **`POST /v1/auth/challenge`** (`createAuthChallenge`, no auth, rate limited).
  - Body: `{purpose: register | session}`.
  - Returns `201 AuthChallenge {challengeId, challenge, expiresAt}`. `challenge` is 32 random bytes, base64url.
  - Each challenge is single use, bound to its purpose, and lasts `app.challengeTtlSeconds` (300).
  - Only `sha256(challenge)` is stored, in the table `auth_challenges (challenge_id PK, challenge_hash, purpose, expires_at, used_at)`.
- **`POST /v1/auth/passkey`** (`registerPasskey`, no auth, rate limited).
  - Body: `PasskeyRegistration {challengeId, credentialId, clientDataJSON, attestationObject, msca}`.
  - Server checks:
    - `clientDataJSON.type = "webauthn.create"`.
    - The challenge matches an unused, unexpired `register` challenge.
    - `origin = http://localhost` (Phase 1, D78).
    - `rpIdHash = sha256("localhost")`, and the UP flag is set.
    - The credential key in `attestedCredentialData` is COSE EC2 P-256 (alg −7).
  - Attestation is not used for trust (any `fmt`). Only the public key is read.
  - **MSCA check.** The server recomputes the counterfactual MSCA address from that public key with the same Circle SDK 1.0.16 call the app uses. An `eth_call` to the MSCA factory is allowed. The server refuses with `422` when the address does not equal `msca`.
  - On success, the server creates the user (`usr_` ULID, with `msca` set). It stores `passkey_credentials (credential_id PK, user_id FK, qx, qy, sign_count, rp_id, created_at)`, marks the challenge used, and returns `201 SessionResponse`.
  - A credential that is already registered returns `409`.
  - Phase 1: one passkey per user.
- **`createSession` verification.** The server checks:
  - The `challengeId` is an unused, unexpired `session` challenge.
  - `type = "webauthn.get"`, the origin and `rpIdHash` match as above, and UP is set.
  - The P-256 signature verifies over `authenticatorData ‖ sha256(clientDataJSON)` against the stored key. Both high-s and low-s are accepted here; low-s normalisation (RV-034) applies only to the on-chain owner signature.
  - If `signCount` is non-zero, it must increase.
  - On success, the server marks the challenge used and issues a 32-byte random token. It stores `sha256(token)` in `sessions` with expiry `app.sessionHours`.

### 2. `Me` changes and data sources

- **New required field `vaultCreated` (boolean).** `vault` is always an address: the factory's `predictVault(msca)` until `VaultCreated` is indexed, then the created vault. `VaultReady` in CZ-22 §5.2 means `vaultCreated = true`.
- **Every chain read is pinned to one block,** which `asOfBlock` reports, and goes through `@czar/vault-client`:

  | `Me` field | Source |
  |---|---|
  | `vaultBalance` | `USDC.balanceOf(vault)` |
  | `free` | `freeBalance()` |
  | `committed` | `committedTotal()` |
  | `mscaBalance` | USDC balance of the MSCA |
  | `frozen` | `frozen()` |
  | `paused` | the factory's `guardianPaused()` |
  | `limits[]` | `getLimits(keccak256(utf8(category)))` for each known category (below) |
  | `periodId` | the current period, `block.timestamp / PERIOD_LENGTH` (03 `PERIOD_LENGTH`, 7 days) |
  | `usedThisPeriod` | `usedInPeriod` when the stored `periodId` equals the current one, else `"0"` (the vault rolls the period lazily) |
  | `periodEndsAt` | `(periodId + 1) × PERIOD_LENGTH` |

  Before `vaultCreated`, the vault fields are `"0"`, `frozen` and `paused` are `false`, and `limits` is `[]`.
- **From the indexer** (CZ-19 query routes):
  - `vaultCreated` and the vault address: new route `GET /vaults?owner=<msca>`.
  - `pocketOutstanding`: the sum over the vault's open envelopes.
  - `listEnvelopes`: new route `GET /envelopes?vault=&cursor=&limit=`, paged in SQL like the SCR-119 routes.
  - `getEnvelope`: the existing route.
  - `listReceipts`: the existing `/receipts?vault=`, joined with the server's plans and objectives for `objectiveId`, `merchantLabel` and `merchantIsCzar`. `paymentRefHash` comes from `@czar/hashing`.
- **From the server DB:** `mode`, `shadowEndsAt`, `userId`, `msca`.
- **Known categories.** These are the distinct values of `planner.categoryByCapability` (Phase 1: `research`, `data`, `creative`, `general`). The onboarding limits screen offers exactly these. A `categoryId` with no known name is left out of `Me.limits`.
- **Indexer ownership.** For this bundle, Lane 5 may add the two read-only routes to `apps/indexer/src/api/`, in their own commit, with no schema change.

### 3. Local wallet test setup (CZ-22 §14)

- **Chain.** `arc-anvil --network arc --fork-url https://rpc.testnet.arc.io --fork-block-number <pinned>`.
  - The fork is read-only toward testnet: it sends no transaction, needs no funds and uses no keys.
  - It brings EntryPoint v0.7, the Circle MSCA factory and its modules exactly as deployed.
  - The Czar contracts are deployed onto the fork with `contracts/script/deploy.sh`.
  - The pinned block and the EntryPoint the factory targets are recorded in the task report (closes the A6-07 build check for tests).
- **Bundler.** A test-only mock bundler under `apps/web/e2e/`.
  - It implements exactly the JSON-RPC methods that Circle SDK 1.0.16's modular transport calls, and lists them in the task report.
  - It simulates each UserOp, then submits `EntryPoint.handleOps` from an `anvil_impersonateAccount` beneficiary. No private key is used.
- **Funding and passkeys.** The MSCA's gas comes from `anvil_setBalance`, in tests only. The passkey is Playwright's CDP virtual authenticator (`ctap2`, internal, resident key, user verification).
- **Endpoints.** New key `app.bundlerEndpoints` (object, bundler name → URL, default `{}`). Tests point `circle` at the mock bundler with a non-secret dummy client key. Real endpoints and the Circle client key are set at the testnet stage (D92, needs Zaryab's approval).

### 4. T-086 split

- **Built in the Lane 5 bundle:**
  - The receipts, envelopes, home and statement screens, with the exact CZ-22 §12 wording.
  - The `listReceipts`, `listEnvelopes` and `getEnvelope` routes.
  - The wording snapshot test, and the `merchantIsCzar` refund test.
  - The statement page and the shadow summary card, rendered from schema-valid fixtures.
- **Deferred:**
  - The `getMonthlyStatement` route, which is T-095's output.
  - Live shadow totals, which come from T-070.
  - Both are wired when those tasks land. T-086's own acceptance tests are unchanged.

## Affected tasks

- T-081: section 1 routes and `createSession`; section 2 `Me` and read routes.
- T-082: section 1 enrolment; section 3 test setup.
- T-084: section 3 test setup.
- T-086: section 4.
- T-095, T-070: wire their data into the screens T-086 built.
