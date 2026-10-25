# SCR-135: CZ-22 §4 passkey transport aligned with SCR-125

| Field | Value |
|---|---|
| ID | SCR-135 |
| Filed by | chief architect, 2026-10-25 (Track A replan, baseline `ce17dad`) |
| Spec and section | `docs/specs/04-components/app/app-and-notifications.md` CZ-22 §4 (`:40`); SCR-125 §1 |
| Status | Accepted (Zaryab, 2026-10-25); Applied (2026-10-25) |

## Problem
- CZ-22 §4 says "`toPasskeyTransport` for the passkey, `toModularTransport(clientUrl + "/arcTestnet", clientKey)` as bundler transport (A6-06, A6-19)" (`app-and-notifications.md:40`).
- SCR-125 (accepted) moved passkey enrolment to Czar's own server: `createAuthChallenge`/`registerPasskey`, server-verified attestation, `rpIdHash = sha256("localhost")`, and a `passkey_credentials` table. The code follows SCR-125: browser WebAuthn plus viem `toWebAuthnAccount` (`apps/web/packages/passkey.ts:25-111`, `apps/web/packages/wallet.ts:30-44`).
- The Lane 5 follow-up prompt's conditional SCR assumed SDK 1.0.16 lacks `toPasskeyTransport`. That premise is false: the SDK exports it (`@circle-fin/modular-wallets-core@1.0.16` `dist/index.d.ts:1062`).
- So the conflict is a real spec contradiction, not a missing export.
- `toPasskeyTransport` routes the ceremony through Circle's RP service, which needs a Circle client key. D92 defers Circle client keys to the testnet stage.

## Evidence
- The verification reports cited here are architect working papers outside the repository; every claim also carries a repository file:line.
- Verification report DE §E4.

## Proposed change
- **CZ-22 §4** text becomes: "The passkey is created and used with browser WebAuthn against Czar's own relying party (SCR-125). The owner account is viem `toWebAuthnAccount` wrapped by Circle `toCircleSmartAccount`. The Circle bundler transport is `toModularTransport(clientUrl + "/arcTestnet", clientKey)` (A6-19). `toPasskeyTransport` is not used: Circle's RP service would hold the credential registration, which SCR-125 keeps in Czar's `passkey_credentials`."
- No code change for the transport itself.
- **Config keys for the app's public-facing values** (K2 is "App config (public-facing API credential)", `docs/specs/01-system-architecture/system-architecture.md:563`):

  | Key | Type | Default | Reason |
  |---|---|---|---|
  | `app.circleClientUrl` | string | no default | Circle Modular Wallets client URL (A6-19); per environment |
  | `app.circleClientKey` | string | no default | K2 public-facing client key (spec 01 `:563`); per environment, never a secret |
  | `app.arcRpcUrl` | string | no default | app-side chain reads; `https://rpc.testnet.arc.io` on testnet, loopback only in the local overlay (SCR-130 rule) |

- **Code defects fixed by brief TA-13, not by this SCR:**
  - Test defaults in production code: `CIRCLE_KEY = "lane5-test-client-key"`, `CIRCLE_URL = http://127.0.0.1:4337` and `ARC_RPC_URL = http://127.0.0.1:8549` (`apps/web/packages/wallet.ts:11-13`).
  - Non-Circle bundlers are wrapped in `toModularTransport` with an `/arcTestnet` suffix (`wallet.ts:47-57`). That suffix is Circle's URL scheme (A6-19), so T-087 must give secondary bundlers their own transport.

## Affected tasks
- T-082, T-087.

## Decision
- Accepted by Zaryab on 2026-10-25 with the Track A replan (context and briefs in `docs/builder-prompts/track-a/`).

## Applied
- CZ-22 §4 App → Circle row
- `@czar/config`: `app.circleClientUrl`, `app.circleClientKey`, `app.arcRpcUrl`
