# SCR-111: The keychain ACL hardening in CZ-27 §3 cannot be set through @napi-rs/keyring

| Field | Value |
|---|---|
| ID | SCR-111 |
| Filed by | Czar builder (tier 2), 2026-10-19 |
| Spec and section | `docs/specs/04-components/server-autonomy-roi-keys.md` CZ-27 §3 "Keychain access (D80 hardening, unverified)"; RV-045 |
| Status | Open |

## Problem
- CZ-27 §3 wants the keychain item's access list to name the signer's own executable rather than `node`. T-035 must check whether `@napi-rs/keyring` does this.
- `@napi-rs/keyring` 2.1.1 (keyring-rs binding) exposes no access-control option: `Entry(service, username, options)` takes only Linux store options. A generic-password item gets the macOS default ACL, which trusts the application that created it.
- The signer runs as a script under `node`, so the trusted application would be the `node` binary. Any other Node process of the same user could then read the item without a prompt.

## Evidence
- `apps/signer/node_modules/@napi-rs/keyring/index.d.ts`, the `Entry` constructor and its options.
- Not yet observed on a Mac (needs device).

## Proposed change
- Phase 1: create the item by hand with `security add-generic-password -s dev.czar.signer.keystore -a keystore -w`, which prompts with no value on argv. Then set "Confirm before allowing access" in Keychain Access, so each read prompts for the login password. Record this as part of the D80 exception.
- Stage 2: package the signer as a single executable and add the item with `-T <that binary>`, or move to `gcp-kms` as planned.

## Affected tasks
- T-035, T-105

## Decision
- 
