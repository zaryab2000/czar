# Lane 5 — Web app follow-up: close all acceptance gaps

> **Tasks:** T-081, T-082, T-084, T-086 (same branch, same PR)
> **This prompt covers:** the seven acceptance gaps from the first Lane 5 run. No new tasks. The goal is to pass every acceptance test from the original prompt.

---

## Preamble

You are continuing work on Lane 5. Your branch `codex/lane5-web-app` is five commits ahead of `origin/build-v1`. Do not create a new branch.

- All the preamble rules from the original prompt still apply: you own `apps/web/`, `apps/server/src/app/`, and shared packages only where your task requires a small change. Never edit `docs/specs/`.
- Your local `arc-anvil` port is **8549**. Postgres: `127.0.0.1:15432`.
- No testnet, no funds, no hosted model calls.
- Finish = every acceptance test from the original prompt passes + a PR into `build-v1` + task report.

---

## Setup

```bash
# You already have the worktree; just make sure it's up to date
cd ../czar-5
git fetch origin
git submodule update --init --recursive
pnpm install
```

---

## Spec correction: `createVault` has no salt argument

The original prompt said `createVault(ownerAccount, salt)`. That was wrong. The factory spec (`czar-vault-factory.md` §5, RV-015) says:

```
createVault(address ownerAccount) → address vault
```

The salt is derived internally as `keccak256(abi.encode(ownerAccount))`. Your implementation following the deployed ABI is correct. No change needed.

---

## Gap 1: `/settings/devices` pairing flow → placeholder

The pairing-code issuance route is part of T-061 (daemon), which is not in this bundle.

**Fix:** The `/settings/devices` screen should render a static placeholder:
- Heading: "Devices"
- Body: "Device pairing requires the Czar daemon, which is not available yet. This screen will be active in a later update."
- Do not show a code input or a device list. Do not invent a route.

**This is not an acceptance test item.** It is a shared screen listed for completeness.

---

## Gap 2: `newPayees` badge and unverified-provider badge

### `newPayees` (fixable)

`ApprovalSummary.newPayees` **exists** in the OpenAPI (integer field). The approval screen must show:

- Badge "New payee" on every payee row when `ApprovalSummary.newPayees > 0`.
- The schema gives a count, not per-payee flags. Show the badge on all payees when the count is positive. This is the acceptance test requirement: "Screen shows payees as hosts, 'new payee' badges."

### Unverified-provider badge (spec gap — partial implementation)

The per-provider evidence count (`{n} of 5 checked jobs`) has no API field. Implement the badge **without the count**:

- When a payee's provider status indicates unverified (the server marks this in `ApprovalSummary` when available), show: "Unverified provider" and "Czar can't vouch for this provider."
- Omit the `({n} of 5 checked jobs)` detail. Note this as an SCR in your task report: "No `evidenceCount` field in `ApprovalSummary` for the per-provider evidence detail."

---

## Gap 3: Network fee and subject revision

### Network fee estimate (spec gap — simplified display)

No `feeDisplay` field exists in the OpenAPI's `ApprovalIntent`. The approval screen cannot show a dollar estimate.

**Fix:** Show: "Network fee: paid from your network fee reserve" without a specific amount. This is honest and matches the spec's intent (D52). Note as SCR in your report: "No `feeDisplay` field in `ApprovalIntent`; the fee estimate requires a gas-price oracle integration not yet specified."

### Subject revision result-format (spec gap — display only)

`revisePlanSubjects` only revises subjects. It cannot persist result-format changes.

**Fix:** Keep the result-format selector in the UI for display. When the user changes it, show it locally but do not attempt to POST it. Note as SCR: "`revisePlanSubjects` does not accept `resultFormat` changes; a separate route is needed."

---

## Gap 4: Decline, file-held count, job feedback

### Decline (fixable)

The spec says: "Decline: POST nothing on-chain; plan expires server-side (`plan-expired`)."

**Fix:** Decline is a purely local action:
1. User taps "Decline" → show confirm sheet: "Decline this plan?"
2. On confirm → navigate back to `/approvals`. Display a transient toast: "Declined. Czar won't spend on this."
3. Do not POST anything. The plan expires server-side naturally.
4. The `declined` status in the `listApprovals` filter is set by the server when the plan expires without approval. The app does not need to set it.

### File-held count and "This was wrong" (spec gap — omit)

No API route for job feedback. No `fileHeldCount` field.

**Fix:** Omit these UI elements entirely. Do not render "files held for review" or "This was wrong" in the receipt view. Note as SCR in your report: "No `fileHeldCount` field and no job-feedback route in the OpenAPI."

---

## Gap 5: E2E test — use real server, not mocked auth

Per SCR-125, Playwright tests must run on `arc-anvil` forked read-only from Arc testnet at a pinned block, with a test-only mock bundler and the CDP virtual authenticator. The auth flow should use the real server.

**Fix the passkey E2E (`apps/web/e2e/passkey.spec.ts`):**

1. **Real server.** Start the server (with `arc-anvil` and Postgres) as a test fixture. `createAuthChallenge` and `registerPasskey` and `createSession` must hit the real server, not be mocked.
2. **Mock bundler.** Keep your mock bundler (`mock-bundler.mjs`) — it handles UserOps on the local fork. This is correct per SCR-125.
3. **CDP virtual authenticator.** Keep using the Chromium CDP virtual authenticator. This is correct per SCR-125.
4. **Prove the indexer gate.** The test must verify that `VaultCreated` and `LimitsSet` are indexed before the payment screens become reachable. Sequence:
   - Passkey created → `registerPasskey` → `createSession` succeeds
   - `createVault` UserOp → wait for `VaultCreated` from the indexer (poll `getMe` until `vault` is set)
   - `setCategoryLimits` UserOp → wait for `LimitsSet` from the indexer
   - Only then: assert the home/approval screens are navigable
5. **WebKit skip.** Keep the WebKit virtual-authenticator skip — this is expected (WebKit doesn't support CDP virtual authenticators).

### Acceptance test coverage

After this fix, these acceptance items must pass:
- `passkey account → createVault UserOp → VaultCreated indexed before any payment screen is reachable → setCategoryLimits → LimitsSet indexed` ✓
- `Desktop passkey test: PasskeyCreated reached and createSession succeeds` ✓

---

## Gap 6: Circle SDK `toPasskeyTransport`

The spec (CZ-22 §4) explicitly requires `toPasskeyTransport` from `@circle-fin/modular-wallets-core` 1.0.16.

**Investigation steps:**

1. Check the installed package's actual exports:
   ```bash
   node -e "const m = require('@circle-fin/modular-wallets-core'); console.log(Object.keys(m).filter(k => /passkey|transport/i.test(k)))"
   ```
   Also check sub-path exports:
   ```bash
   cat node_modules/@circle-fin/modular-wallets-core/package.json | grep -A 20 '"exports"'
   ```
2. If `toPasskeyTransport` exists under a different import path or name, use it.
3. If it genuinely does not exist in the installed version:
   - Keep the browser WebAuthn API approach as the implementation (it works).
   - Note as SCR in your report: "`@circle-fin/modular-wallets-core` 1.0.16 does not export `toPasskeyTransport`; the spec names it but the SDK does not provide it. Browser WebAuthn APIs are used instead. Spec should be updated to match the SDK's actual API."
   - This does not block the acceptance tests — the passkey ceremony works via browser WebAuthn.

---

## Summary of what to fix vs note

| Gap | Action | Blocks acceptance? |
|---|---|---|
| 1 — Devices | Placeholder screen | No |
| 2 — `newPayees` badge | **Fix:** use `ApprovalSummary.newPayees` | **Yes** — T-084 acceptance |
| 2 — Evidence count | Simplified badge, note SCR | No |
| 3 — `feeDisplay` | Static text, note SCR | No |
| 3 — Result-format revision | Display only, note SCR | No |
| 4 — Decline | **Fix:** local-only dismiss | **Yes** — T-084 acceptance |
| 4 — File-held, feedback | Omit, note SCR | No |
| 5 — E2E real server | **Fix:** wire to real server + indexer | **Yes** — T-082 acceptance |
| 6 — `toPasskeyTransport` | Investigate SDK; keep WebAuthn if absent, note SCR | Conditional |
| 7 — `createVault` salt | Already correct | No |

---

## Acceptance tests — full checklist (re-run all)

### T-081
- [ ] Contract tests pass for all six operations.
- [ ] `getMe.balances.pocketOutstanding` equals the sum over open envelopes from the indexer.
- [ ] `getSoulPointer` returns `available: false`.

### T-082
- [ ] Playwright with virtual authenticator: passkey → `createVault` UserOp → `VaultCreated` indexed before any payment screen is reachable → `setCategoryLimits` → `LimitsSet` indexed.
- [ ] "Network fee reserve" shows `getMe.balances.mscaBalance`.
- [ ] `grep -r` finds no test-keystore owner code path outside `tests/`.
- [ ] Desktop passkey test: `PasskeyCreated` reached and `createSession` succeeds.

### T-084
- [ ] The app re-encodes `openEnvelope(decoded)` and refuses if it differs from `calldata`.
- [ ] Tampered calldata test: server fixture showing 3 payees while calldata commits a 4th → refused.
- [ ] After subject edit, app recomputes `planHash` before approve.
- [ ] Playwright: approve → UserOp mines → `EnvelopeOpened` with the plan's `planHash`.
- [ ] Screen shows payees as hosts, "new payee" badges, and CZ-22 §12 wording.

### T-086
- [ ] Snapshot test renders every `LedgerReceipt.status` value with exact CZ-22 §12 wording.
- [ ] Czar-merchant refunds show "Refunded by Czar (Czar service)" only when `merchantIsCzar` is true.

### Cross-cutting
- [ ] `pnpm --filter @czar/web typecheck` passes.
- [ ] `pnpm --filter @czar/web build` succeeds.
- [ ] `pnpm --filter @czar/web test` passes.
- [ ] `pnpm --filter @czar/web e2e` passes.
- [ ] First load ≤ 300 KB JS gzipped.
- [ ] `pnpm --filter @czar/server test` passes.
- [ ] `pnpm -r typecheck` passes.
- [ ] `pnpm lint` passes.

---

## Final checks (all must pass)

```bash
pnpm --filter @czar/web typecheck
pnpm --filter @czar/web build
pnpm --filter @czar/web test
pnpm --filter @czar/web e2e
pnpm --filter @czar/server test
pnpm -r typecheck
pnpm lint
```

---

## Task report (required)

1. **Task IDs:** T-081, T-082, T-084, T-086 (follow-up run).
2. **Files changed** (list only files touched in this follow-up, not the original run).
3. **Test commands and results** (paste terminal output for every command above).
4. **SCRs** (text only, in the report — do not create files under `docs/`):
   - SCR: No `feeDisplay` field in `ApprovalIntent`.
   - SCR: No `evidenceCount` per provider in `ApprovalSummary`.
   - SCR: `revisePlanSubjects` cannot persist result-format changes.
   - SCR: No `fileHeldCount` field or job-feedback route.
   - SCR (conditional): `toPasskeyTransport` not exported by Circle SDK 1.0.16.
5. **Open issues** — anything deferred (T-061 devices, T-095 statement, T-070 shadow totals).

---

## PR metadata

- **Title:** `feat(web): Lane 5 — complete web app (T-081, T-082, T-084, T-086)`
- **Base:** `build-v1`
- **Branch:** `codex/lane5-web-app`
