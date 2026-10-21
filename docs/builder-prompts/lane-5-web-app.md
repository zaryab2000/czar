# Lane 5 — Web app: unified builder prompt

> **Tasks:** T-081, T-082, T-084, T-086 (one branch, one PR)

---

## Preamble

You are a Czar builder on LANE 5 (Web app). Other builders work in parallel on other lanes.

- Work only in your worktree: `../czar-5`. Branch: `codex/lane5-web-app` from the latest `origin/build-v1`.
- You own: `apps/web/`, `apps/server/src/app/`. Do not edit other lanes' folders. Edit shared packages (`schemas`, `hashing`, `config`, `api-contract`) only where your task requires it, in a separate small commit.
- Config registry: append keys only. Migrations: before opening the PR, rebase on `origin/build-v1` and rename your migration to the next free number.
- Your local `arc-anvil` port is **8549**. Postgres: `127.0.0.1:15432` (tests create their own database).
- No hosted model calls (all model tests use recorded replies). No testnet, no funds, no accounts, no keys.
- Never edit `docs/specs`, `docs/product`, `docs/architecture`. Spec gap → stop that item, describe it as an SCR in your report, continue with the rest.
- **Finish** = all acceptance tests pass locally + PR opened into `build-v1` + task report (task, files, commands and results, SCRs, open issues). Do not merge. Do not start another task.

---

## Setup

```bash
# 1 — worktree
git fetch origin
git worktree add ../czar-5 -b codex/lane5-web-app origin/build-v1
cd ../czar-5

# 2 — install
pnpm install

# 3 — verify the scaffold builds
pnpm --filter @czar/web typecheck
pnpm --filter @czar/web build
```

---

## Spec files to read (in full, before writing code)

1. `docs/specs/04-components/app/app-and-notifications.md` — **CZ-22 in its entirety.** This is the primary spec. Every screen, flow, parameter, wording string, security check and test comes from here.
2. `docs/specs/02-data-and-protocol/api/openapi.yaml` — the app-tagged routes (lines 1275–1550) and every schema they reference (`Me`, `SessionRequest`, `SessionResponse`, `ApprovalSummary`, `ApprovalIntent`, `ApprovalIntentRequest`, `SubmittedNotice`, `FreezeIntent`, `EnvelopeDetail`, `LedgerReceipt`, `MonthlyStatement`, `SoulPointer`, `SubjectsRevision`). Also read the top-level `info` and `servers` blocks (lines 1–35) for error shape, pagination, idempotency and rate limits.
3. `docs/specs/02-data-and-protocol/data-and-protocol.md` §9.1–§9.2 — auth model (AppSession, WebAuthn assertion, 24 h, session storage).
4. `docs/specs/03-smart-contracts/czar-vault-factory.md` §5 — `createVault(ownerAccount, salt)` ABI.
5. `docs/specs/03-smart-contracts/czar-vault.md` §5.1 — `openEnvelope`, `freeze`, `unfreeze`, `setCategoryLimits`, `withdraw`; revert names.
6. `docs/specs/04-components/shared/cross-cutting.md` §4 — logging allowlist.
7. `docs/specs/05-build-plan/phase-1-tasks.md` lines 1313–1404 — the four task definitions (T-081, T-082, T-084, T-086) with their full acceptance tests.

---

## What you are building

A complete desktop web app (Next.js 16 / React 19 / Tailwind) that serves as the Czar owner's interface: sign-up with a passkey smart account, vault creation, budget and limits, approval of payment plans, freeze/unfreeze, receipts, envelopes, monthly statement, and privacy settings.

**Phase 1 constraints:**
- Desktop browser only (Safari + Chrome on macOS). No mobile layouts.
- Origin `http://localhost`, RP ID `localhost`. Browsers treat `http://localhost` as a secure context, so passkeys work.
- No push notifications (stage 2). The pending-approvals list is the only approval channel.
- No service worker. No CDN. Served by the local server.
- USD only. The server supplies `capDisplay` / `amountDisplay` as USD strings. No exchange-rate logic.
- No hosted model calls. The app renders server strings; it never calls a model.
- Resource budget: first load ≤ 300 KB JS gzipped; approval screen interactive ≤ 1.5 s on a mid-range laptop.

**Execution order (build in this sequence):**

1. **T-081** — Server handlers + read routes (createSession, getMe, listEnvelopes, getEnvelope, listReceipts, getSoulPointer)
2. **T-082** — Onboarding screens (passkey MSCA, createVault UserOp, funding, limits)
3. **T-084** — Approvals (listApprovals, getApproval, createApprovalIntent with integrity check, UserOp submit, notifySubmitted)
4. **T-086** — Ledger, receipts, monthly statement, shadow summary

---

## Part 1: T-081 — Server handlers and app read routes

### What to build

Six server handlers in `apps/server/src/app/` and their corresponding data hooks in `apps/web/`.

#### Routes (all require `AppSession` bearer auth)

| operationId | Method + Path | Returns | Notes |
|---|---|---|---|
| `createSession` | `POST /v1/auth/session` | `SessionResponse` (`sessionToken`, `expiresAt`) | Input: `SessionRequest` (WebAuthn assertion fields: `challengeId`, `credentialId`, `authenticatorData`, `clientDataJSON`, `signature` — all base64url). Server verifies the assertion against the stored passkey public key, issues a 24 h bearer. |
| `getMe` | `GET /v1/me` | `Me` | Fields: `userId`, `msca`, `vault`, `network`, `balances` (`vaultBalance`, `free`, `committed`, `mscaBalance`, `pocketOutstanding`, `asOfBlock`), `limits[]` (`category`, `userMax`, `autoLimit`, `usedThisPeriod`, `periodId`, `periodEndsAt`), `mode`, `shadowEndsAt`, `frozen`, `paused`, `displayCurrency` (always `"USD"`). |
| `listEnvelopes` | `GET /v1/envelopes` | Page of `Envelope` | Cursor-paginated. |
| `getEnvelope` | `GET /v1/envelopes/{envelopeRef}` | `EnvelopeDetail` | `envelope`, `reservations[]`, `pockets[]`, `jobs[]`. |
| `listReceipts` | `GET /v1/ledger/receipts` | Page of `LedgerReceipt` | Fields: `objectiveId`, `envelopeRef`, `stepIndex`, `amount`, `amountDisplay`, `rail` (enum: `x402-exact`, `gateway-batched`, `erc8183-job`), `status` (enum: `reserved`, `settled`, `pending`, `completed`, `released`, `refunded`, `failed`, `quarantined`), `merchantIsCzar`, `merchantLabel`, `accepted`, `minutesSaved`, `minutesSource`, `paymentRefHash`, `settlementTx`, `createdAt`. |
| `getSoulPointer` | `GET /v1/soul/pointer` | `SoulPointer` | Always returns `{ available: false, message: "…", desktopUrl: "http://127.0.0.1/soul" }`. Message ≤ 200 chars; before first soul: "Open the Czar viewer on your computer to tell Czar about your work (about five minutes, optional)." (D90). |

#### Implementation notes

- `createSession`: validate the WebAuthn assertion. Generate a random session token. Store with expiry = now + `app.sessionHours` (24). Return `SessionResponse`.
- `getMe`: query the indexer for the user's vault state, balances, limits. `balances.pocketOutstanding` must equal the sum over open envelopes' pocket amounts from the indexer.
- All handlers go in `apps/server/src/app/`. Use shapes from `@czar/schemas` only.
- Pagination follows the top-level OpenAPI convention: `?cursor=&limit=` (max 200), response carries `nextCursor` (null at end).
- Errors are RFC 9457 `problem+json` with `czarCode` and `retryable`.

### Tests for T-081

- Contract tests for all six operations.
- `getMe.balances.pocketOutstanding` equals the sum over open envelopes from the indexer.
- `getSoulPointer` returns `available: false`.

---

## Part 2: T-082 — Onboarding

### What to build

The full onboarding flow as a state machine (CZ-22 §5.2):

```
NoAccount → PasskeyCreated → VaultPending → VaultReady → Funded → LimitsSet → Ready
```

#### Screens and routes

| Screen | Route | What happens |
|---|---|---|
| Welcome | `/` | "Create your account" button. |
| Create account | `/onboarding/passkey` | Circle passkey ceremony using `@circle-fin/modular-wallets-core` 1.0.16: `toPasskeyTransport` for the passkey. The MSCA address is counterfactual until its first UserOp. RP ID = `localhost`. |
| Create vault | `/onboarding/vault` | Submit `createVault(ownerAccount, salt)` as the first UserOp through the Circle bundler transport (`toModularTransport`). Display "Setting up your vault on Arc. This takes a few seconds." Poll `getMe` until `vault` is set (`VaultCreated` indexed). If reverts `VaultExists` → treat as success. |
| Add money | `/onboarding/fund` | Show `Me.balances.vaultBalance`. Show the vault address for the user to copy. Show a link to the testnet faucet. Poll `getMe` until `vaultBalance > 0`. Display "Add USDC to your vault. On the test network, use the faucet link below." Never promise a country. |
| Set limits | `/onboarding/limits` | Show categories. User sets `userMax` and `autoLimit` per category. Submit `setCategoryLimits(categoryId, userMax, autoLimit)` UserOp per category. Display "How much may Czar spend per week without asking? You can change this any time." Wait for `LimitsSet` indexed. |

#### Passkey details

- Use `@circle-fin/modular-wallets-core` 1.0.16.
- RP ID: `localhost` (browsers treat `http://localhost` as a secure context).
- `setPasskey(rpIdHash = sha256("localhost"))` (the vault's passkey record).
- Client normalises P-256 `s` to low-s before `executeOwnerAction` (RV-034).
- `PasskeyUnsupported` state: "Passkeys did not work in this browser. Please open Czar in Safari or Chrome on your Mac."

#### Network fee reserve (D52)

- Show `Me.balances.mscaBalance` as "Network fee reserve: {amount}".
- Gas is paid in native USDC by the MSCA. If `createVault` UserOp is rejected for gas, send the user to "Add money" first (small amount to the MSCA, then the vault).

#### Bundler transport

- Primary: Circle bundler via `toModularTransport(clientUrl + "/arcTestnet", clientKey)`.
- Fallback order: `app.bundlerOrder` = `circle, pimlico, alchemy, zerodev` (A6-15 to A6-19).
- `SubmittedNotice.bundler` records which bundler succeeded.

### Tests for T-082

- Playwright with a virtual authenticator: passkey account → `createVault` UserOp → `VaultCreated` indexed before any payment screen is reachable → `setCategoryLimits` → `LimitsSet` indexed.
- "Network fee reserve" balance shows `getMe.balances.mscaBalance` (D52).
- `grep -r` finds no test-keystore owner code path outside `tests/`; no testnet vault in the scenario is owned by the test keystore (D64).
- Desktop-browser passkey test: `PasskeyCreated` reached and a later `createSession` succeeds.

---

## Part 3: T-084 — Approvals

### What to build

The complete approval flow (CZ-22 §5.3).

#### Server routes (add to `apps/server/src/app/`)

| operationId | Method + Path | Notes |
|---|---|---|
| `listApprovals` | `GET /v1/approvals` | Returns page of `ApprovalSummary`. Filter by `?status=` (enum: `pending`, `intent-issued`, `submitted`, `opened`, `expired`, `declined`). |
| `getApproval` | `GET /v1/approvals/{planId}` | Returns the full `Plan`. |
| `revisePlanSubjects` | `POST /v1/approvals/{planId}/subjects` | Input: `SubjectsRevision` (`subjects[{label, sourceLine?, addedByUser?}]`). Returns updated `Plan` with new `planHash` and cap. |
| `createApprovalIntent` | `POST /v1/approvals/{planId}/intent` | Input: `ApprovalIntentRequest` (`fillInPlace` boolean, default true, D85). Returns `ApprovalIntent` with `planId`, `planHash`, `objectiveHash`, `payeeRoot`, `vault`, `to`, `calldata`, `value` ("0"), `chainId`, `decoded` (`cap`, `maxStepAmount`, `pocketCapBps`, `expiresAt`, `categoryId`, `objectiveHash`, `planHash`, `payeeRoot`), `expiresAt`. |
| `notifySubmitted` | `POST /v1/approvals/{planId}/submitted` | Input: `SubmittedNotice` (`userOpHash`, `bundler` enum). Returns 202. Idempotent on `userOpHash`. |

#### Approval screen (`/approve/{planId}`)

Display all of these (CZ-22 §9, §12):

- **Goal:** "Spend up to {capDisplay} ({cap} USDC) on \"{goal}\""
- **Subject list (D84):** "Czar will look up {fields} for: {subject 1}, {subject 2}, …" with "Edit list"; source line "From {fileName}, {topic}"
- **Subject edit:** `revisePlanSubjects` → "List updated. New estimate: {capDisplay}."
- **Fill option (D85):** checkbox "Fill {fileName} when done", ticked by default → `ApprovalIntentRequest.fillInPlace`
- **Steps:** each step with amount, rail description:
  - x402/nanopayment: "Paid per call, checked before the next step"
  - ERC-8183 job: "Held in escrow, money back if rejected"
  - Step reason (D91): "Fills: {fills}. {summary}."
- **Payees:** shown as `{host}`. Badge "New payee" when `ApprovalSummary.newPayees > 0` and the payee was never paid before.
  - Lab service (D83): badge "Czar test merchant"
  - Unverified provider (N1): badge "Not enough evidence yet ({n} of 5 checked jobs)" and "Czar can't vouch for this provider."
- **Alternates (D36):** "If a service fails, Czar may use up to 2 backup services under the same step limit."
- **Alternative not chosen (D91):** "{host} not chosen: {reason}" with exact reason strings from §12.
- **Result format (D91):** "Result as: {format}" with selector; `editedByUser` flag.
- **Job context notice (D86):** "This job gets only the task description and up to 2,000 characters of context, no files."
- **Files held for review (N2):** "{n} file(s) from this result are held for review on your Mac. Open the Czar viewer to release or delete them."
- **Real-market panel (D83):** header "Real market (Arc mainnet)"; read-only.
- **Cap warning:** when cap > `app.largeCapWarnBps` (5000 bps = 50%) of the category's `userMax`.
- **Network fee:** "Network fee: about {feeDisplay}, paid from your network fee reserve"
- **Expiry:** "This plan expires {expiresAt}"
- **Approve button:** "Approve {capDisplay}"

#### RV-044 integrity check (critical security)

Before the UserOp is signed, the app **on the device**:

1. Recomputes `payeeRoot` from exactly the payee leaves it shows the user (payees, alternates, pocket leaf if any, each with its step and cap) using `@czar/hashing`.
2. Recomputes `planHash` from the displayed plan fields using `@czar/hashing`.
3. Re-encodes `openEnvelope(decoded)` using `@czar/vault-client`.
4. Refuses unless the result equals `ApprovalIntent.calldata` byte for byte.
5. Also checks `ApprovalIntent.expiresAt`.

On mismatch: `czarCode: validation` → "Something changed in this plan. Please reload."

This means a compromised server cannot show three known merchants while the calldata commits an extra attacker leaf.

#### UserOp submission

1. Build the UserOp: `{to: vault, data: calldata, value: 0}`, signed by the passkey.
2. Submit through the Circle bundler. On rejection, try the next in `app.bundlerOrder`.
3. After all fail: "The network is busy. Your approval was not sent. Try again in a minute."
4. On success: `notifySubmitted({userOpHash, bundler})`.
5. Show "Approved, waiting for the network".
6. Poll until `EnvelopeOpened` indexed. If not seen within `app.approvalConfirmTimeoutSeconds` (120), offer "Check again" and "Resubmit".
7. Before resubmitting, check `getEnvelope` by the expected `envelopeRef` from `Me` counters (the vault rejects a second open only by the envelope counter, so a resubmit after silent success would open a second envelope).

#### Alternate flows

- **Decline:** POST nothing on-chain; plan expires server-side (`plan-expired`). Display "Declined. Czar won't spend on this."
- **Plan expired before tap:** `createApprovalIntent` returns `plan-expired` → "This plan expired. Czar will re-price it if the need is still open."
- **Insufficient free balance:** server pre-checks `Me.balances.free` → "Not enough available money for this plan. Add money or lower the plan."
- **Frozen/paused:** approvals disabled with the banner text; `createApprovalIntent` returns `frozen` / `paused`.
- **Session expired:** `session-expired` → passkey sign-in sheet; pending list reloads after.

#### Freeze flow (CZ-22 §5.4)

- Freeze: "Freeze" button → confirm sheet → `createFreezeIntent({action: "freeze"})` → UserOp with `calldata` (ABI `freeze()`) → "Freezing…" → `Me.frozen` true → banner.
- Banner: "Frozen. No payments can start until you unfreeze. Money already on its way back to you still arrives."
- Paused banner: "Czar paused all spending for safety. Nothing can start. Your money stays in your vault."
- Unfreeze: same flow with `unfreeze()` (owner only).
- Freeze with jobs (M3): "Unstarted specialist jobs were cancelled and refunded. {n} submitted job(s) on hold until you unfreeze."

#### Pending list

- Route `/approvals`. Polls every `app.pendingPollSeconds` (15 s) while open.
- Badge count in the browser tab title.
- "Czar needs your approval for these. Nothing is spent until you approve."

### Tests for T-084

- The app re-encodes `openEnvelope(decoded)` and refuses to submit if it differs from `calldata`.
- **Tampered calldata test:** a server fixture showing three payees while the calldata commits a fourth is refused.
- After subject edit, the app recomputes the new `planHash` before approve.
- Playwright: approve → UserOp mines → `EnvelopeOpened` with the plan's `planHash` → objective moves to `executing`.
- Screen shows payees as hosts, "new payee" badges, and the path labels from CZ-22 §12.

---

## Part 4: T-086 — Ledger, receipts, monthly statement

### What to build

#### Screens

| Screen | Route | Data source |
|---|---|---|
| Receipts | `/receipts` | `listReceipts` (paginated) |
| Monthly statement | `/statement/{yyyy-mm}` | `getMonthlyStatement` → `MonthlyStatement` (`month`, `totalSpent`, `totalSpentDisplay`, `totalMinutesSaved`, `objectives`, `receipts`, `byCategory[{category, spent, minutesSaved}]`) |
| Envelopes | `/envelopes`, `/envelopes/{envelopeRef}` | `listEnvelopes`, `getEnvelope` |
| Home | `/home` | `Me`, pending count, last receipts |

#### Receipt status wording (CZ-22 §12 — exact strings, no variations)

| `LedgerReceipt.status` | Display text |
|---|---|
| `reserved` | "Reserved" |
| `settled` | "Paid" |
| `pending` | "Paid, settling (up to 16 minutes)" |
| `completed` | "Paid" |
| `released` | "Not charged" |
| `refunded` | "Refunded" — but when `merchantIsCzar` is true: "Refunded by Czar (Czar service)" |
| `failed` | "Failed, not charged" |
| `quarantined` | (shown as a line item; wording per the §12 table for x402 step failed after payment: "Paid {amount}; the result failed Czar's check. This merchant was rated down. Third-party calls are not refundable.") |

#### Additional receipt wording

- x402 step failed after payment: "Paid {amount}; the result failed Czar's check. This merchant was rated down. Third-party calls are not refundable."
- Job rejected: "Rejected by Czar's check. {amount} returned to your vault."
- Job paid (H5): "Paid {amount} after the work arrived in the agreed form. Czar checked the form, not whether it's correct." plus "This was wrong" action.
- Auto-approved envelope: "Auto-approved within your weekly limit for {category}".
- `AllowanceExceeded` (agent path, shown in envelopes): "Needed your approval: above your weekly limit for {category}."

#### Monthly statement

- "Czar saved you {hours} hours for {totalSpentDisplay} in {month}."
- Breakdown by category.

#### Shadow summary

- Uses shadow totals from T-070 (if available from server). Display the shadow summary card on the home screen.

#### Home screen (`/home`)

- `Me` data: available balance, committed, pocket funds, network fee reserve.
- Pending approval count (from `listApprovals?status=pending`).
- Last few receipts.
- Approve and Freeze buttons.

### Tests for T-086

- **Snapshot test:** renders every `LedgerReceipt.status` value (including `pending` and `quarantined`) with the exact wording from CZ-22 §12.
- Czar-merchant refunds show "Refunded by Czar (Czar service)" only when `merchantIsCzar` is true (AM-05, D35).

---

## Shared screens

### Settings

| Screen | Route | Content |
|---|---|---|
| Privacy | `/settings/privacy` | Read-only text: "Raw work data stays on your computer. Only redacted excerpts are sent to compile your Work Soul, through a Czar relay that stores nothing. Objectives sent to Czar's server are redacted first." |
| Devices | `/settings/devices` | Device list with pairing code: "Pair your computer: enter this code in the Czar daemon within 5 minutes: {code}". Code TTL = `app.pairingCodeTtlMinutes` (5). |
| Work Soul | `/settings/soul` | `getSoulPointer` text only (D34). "Your Work Soul is viewable on your computer. Open the Czar viewer there to read, edit or delete any line." |

### Not-found

- `/not-found` for unknown routes.

### Session management

- `AppSession` bearer token stored in session storage. Cleared on sign-out. Expires 24 h (02 §9.1).
- `localStorage`: display preferences, last-viewed tab, onboarding step. No money data. Wrapped in try/catch.
- Plans, receipts, balances are always fetched, never cached as truth.

### Navigation

- App-level nav: Home, Approvals, Envelopes, Receipts, Settings.
- Frozen banner visible on every screen when `Me.frozen` is true.
- Paused banner visible on every screen when `Me.paused` is true.

---

## Named parameters to register in `@czar/config`

| Key | Default | Reason |
|---|---|---|
| `app.approvalConfirmTimeoutSeconds` | `120` | 0.5 s blocks plus bundler latency; well past normal |
| `app.pendingPollSeconds` | `15` | pending list is the only Phase 1 approval channel |
| `app.sessionHours` | `24` | 02 §9.1 |
| `app.newPayeeWarnThreshold` | `1` | any new payee gets a warning |
| `app.largeCapWarnBps` | `5000` | warn when cap > 50% of category userMax |
| `app.bundlerOrder` | `circle, pimlico, alchemy, zerodev` | A6-15 to A6-19 |
| `app.pairingCodeTtlMinutes` | `5` | 02 §9.1 |

---

## Code rules (from CLAUDE.md — binding)

- Named parameters only. Every threshold, timeout, retry count, limit and amount is a key in `@czar/config`. No magic numbers.
- Amounts are USDC 6-decimal integer strings in APIs (`Amount6`), `uint256` on-chain. Never floats.
- Shapes from `@czar/schemas` only. Hashes from `@czar/hashing` only. Vault calls through `@czar/vault-client` only.
- Absolute imports only. Pinned dependency versions only.
- Follow the logging allowlist in cross-cutting §4. Never log objective text, soul text, merchant bodies, hook payloads, file paths, emails or full URLs with query strings.
- Use `#src/*` and `#test/*` import maps.

---

## Failure handling (CZ-22 §10)

| Failure | App behaviour | User sees |
|---|---|---|
| No passkey support | record `passkey-unsupported` | "Passkeys did not work in this browser. Please open Czar in Safari or Chrome on your Mac." |
| Circle transport error | next bundler in `app.bundlerOrder` | "Sending…" then success or busy message |
| `createVault` reverts `VaultExists` | treat as success; `getMe` | — |
| `openEnvelope` reverts | decode name via `@czar/vault-client`; map to wording | §12 table |
| Network offline | cached last `Me` with "Offline — balances may be stale"; approvals disabled | — |
| Indexer lag | "Syncing…" badge from `Me.balances.asOfBlock` age > 120 blocks | — |

---

## Acceptance tests — combined checklist

All of these must pass before opening the PR.

### T-081 acceptance
- [ ] Contract tests pass for all six operations (`createSession`, `getMe`, `listEnvelopes`, `getEnvelope`, `listReceipts`, `getSoulPointer`).
- [ ] `getMe.balances.pocketOutstanding` equals the sum over open envelopes from the indexer.
- [ ] `getSoulPointer` returns `available: false`.

### T-082 acceptance
- [ ] Playwright with virtual authenticator: passkey → `createVault` UserOp → `VaultCreated` indexed before any payment screen is reachable → `setCategoryLimits` → `LimitsSet` indexed.
- [ ] "Network fee reserve" shows `getMe.balances.mscaBalance`.
- [ ] `grep -r` finds no test-keystore owner code path outside `tests/`.
- [ ] Desktop passkey test: `PasskeyCreated` reached and `createSession` succeeds.

### T-084 acceptance
- [ ] The app re-encodes `openEnvelope(decoded)` and refuses if it differs from `calldata`.
- [ ] Tampered calldata test: server fixture showing 3 payees while calldata commits a 4th → refused.
- [ ] After subject edit, app recomputes `planHash` before approve.
- [ ] Playwright: approve → UserOp mines → `EnvelopeOpened` with the plan's `planHash`.
- [ ] Screen shows payees as hosts, "new payee" badges, and CZ-22 §12 wording.

### T-086 acceptance
- [ ] Snapshot test renders every `LedgerReceipt.status` value with exact CZ-22 §12 wording.
- [ ] Czar-merchant refunds show "Refunded by Czar (Czar service)" only when `merchantIsCzar` is true.

### Cross-cutting
- [ ] `pnpm --filter @czar/web typecheck` passes.
- [ ] `pnpm --filter @czar/web build` succeeds.
- [ ] `pnpm --filter @czar/web test` passes.
- [ ] `pnpm --filter @czar/web e2e` passes.
- [ ] First load ≤ 300 KB JS gzipped.

---

## Task report (required)

When all acceptance tests pass, open one PR into `build-v1` from branch `codex/lane5-web-app` and post a task report containing:

1. **Task IDs:** T-081, T-082, T-084, T-086
2. **Files changed** (list them all)
3. **Test commands and their results** (paste the terminal output)
4. **SCRs filed** (if any spec gaps were found)
5. **Open issues** (anything you could not verify — especially items depending on testnet interaction, which is deferred per D92)

---

## PR metadata

- **Title:** `feat(web): Lane 5 — complete web app (T-081, T-082, T-084, T-086)`
- **Base:** `build-v1`
- **Branch:** `codex/lane5-web-app`
