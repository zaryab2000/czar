# 00 Verified lane snapshot (Track A replan)

- **Baseline:** `build-v1` at `ce17dadce27fc25c9e424c1b656da416af370f46` (merge of PR #61), fetched 2026-10-25. It matches the handoff SHA; no later commits.
- **Method:**
  - Five read-only verification passes over code at that SHA, then an independent citation check.
  - Status labels come from production code and real entry points only. Task reports, PR titles, the lane tracker and fixtures were used as pointers.
- **Labels:**
  - `IMPLEMENTED`: code exists, a started entry point composes it, and tests exist.
  - `UNWIRED`: specified and built, but no started process calls it.
  - `MISSING-PRODUCER`: a needed input has no production producer.
  - `DECISION`: an unresolved spec conflict or silence.
  - `DEFERRED-VALIDATION`: only local-chain, live, device or testnet acceptance remains.
  - `GAP`: searched for and not found.
- **Not read:** the uncommitted contents of the `codex/lane2-runtime-integration` worktree (`/Users/zar/Code/ai-on-chain/czar-2-runtime`). Folder access was refused by the permission check. Its committed handoff (PR #61: `apps/server/T-046-054-lane2-follow-up-report.md`, `reports/m3-thin-slice.md`) was read and verified.

## Headline
- **Nothing in the running stack moves money today.**
  - The only started server entry, `start:local` → `apps/server/src/local-main.ts:29-38` → `createLocalApp` → `createApp`, serves:
    - objectives, approvals and auth
    - reads and job delivery
    - the pairing route
  - It never composes `createServerMain` (`apps/server/src/main.ts:118`; callers: `test/main.test.ts`, `test/evidence/receipt-arc.test.ts` only), the planner loop, the payer, the boundary, acceptance or receipts.
  - Nothing calls the signer: `createSignerClient` (`apps/signer/src/socket.ts:97`) has no production caller.
  - The merchant process answers only `/health` (`apps/merchants/src/local-main.ts:1-16`).
- **The money modules themselves are substantial and tested.** Lane 2's payers, Lane 3's acceptance checker and Lane 1's contracts, vault client and signer are real code. The gap is composition, missing producers and seven unowned areas, not missing payment logic.
- **Two signer self-blocks would refuse the first receipt and the first evidence commit:**
  - `sl-receipt` checks the server's own `evidence_receipts`, which the server writes only after signing (`apps/signer/src/postgres-projection.ts:299-306` vs `apps/server/src/evidence/receipts.ts:56-70,195`).
  - K8 `oel-commit` checks the indexer `anchors` table, which fills only from on-chain commits (`postgres-projection.ts:346-352`).
  - Both are hidden by test doubles (`apps/server/test/payer/test-signer.ts:58`, `apps/signer/test/local-chain.test.ts:98`).
- **Records drift:**
  - SCR-127 is cited (`ops/local/T-040-task-report.md:20,63`) but was never filed, and SCR-124 is absent; the highest filed SCR is 126.
  - D92 is cited everywhere but missing from `docs/product/decisions-log.md` (it ends at D91, `:554`).
  - The lane tracker (`docs-internal/lane-tracker/tasks.json`, local and gitignored, outside this repository) records baseline `59ffdb6` (PR #52). It predates PRs #60 and #61.

## Lane 1 — contracts, signer, vault client, chain

| Item | Status | Evidence |
|---|---|---|
| Contracts T-010–T-021, T-023–T-025 | IMPLEMENTED | `contracts/src/*`, 17 test files, fuzz/invariant suites, `contracts/script/deploy.sh` via `ops/local/deploy.sh:61` |
| T-026 `@czar/vault-client` | IMPLEMENTED (library) | `packages/vault-client/src/*`; arc-anvil integration test `packages/vault-client/test/integration/anvil.test.ts:283`. No `encodeRecordManualReturn` |
| T-022 fork suite | GAP; blocked by SCR-101 (hardfork pin, Zaryab) | no `contracts/test/fork/`; `contracts/foundry.toml:22` |
| T-035 signer process | IMPLEMENTED as a process; UNWIRED as a service | `apps/signer/src/main.ts:33-87`, `ops/local/process-compose.yaml:76`; no client caller |
| T-036 signer policies | IMPLEMENTED (unit); DEFERRED-VALIDATION (local chain) | `apps/signer/test/local-chain.test.ts:45` is `skipIf(!CZAR_LOCAL_CHAIN)` |
| `sl-receipt` settled check | GAP (code defect vs CZ-27 `:402`) | `policy.ts:411-416` + `postgres-projection.ts:299-306` |
| Signer autonomy raise bound | GAP (code defect) | `postgres-projection.ts:148-151` uses `autoLimit`; contract uses `userMax` (`contracts/src/vault/logic/AutonomyLogic.sol:48`). After a freeze, limits can never grow back |
| T-037 pocket key lifecycle | UNWIRED + MISSING-PRODUCER | retire/destroy not on the socket (`socket.ts:130,187`); `pocketBalances` throws (`postgres-projection.ts:230-238`); `slowWithdrawAllowed` hard `false` (`:173-175`); `slowWithdrawalOpen` read as `true` because the indexer never writes it (`:226`) → every K3 write-off and K4 `pocket-return` is denied |
| Public key address lookup (K10, K7) | MISSING-PRODUCER | socket handles only `sign`, `createPocketKey`; `create-merchant-keys.ts:55` prints the K10 address once |
| T-105 keys | UNWIRED; output shape wrong | `apps/signer/scripts/create-keys.ts:118-124` writes `{addresses:{K3:{…}}}` with no `ref`, but `contracts/script/Deploy.s.sol:90-95` reads `.K3.address`; validator allows exactly 7 ids (`:63-66`) vs T-105 acceptance (`phase-1-tasks.md:491`). Running it needs Zaryab |
| T-040 local stack | UNWIRED (partial) | process-compose launches everything; the merchant and server entries are thin. `ops/local/deploy.sh:47-54` binds every vault role to `eth_accounts[0]`, so the signer's keystore K3/K7 are not the vault's agent/validator on the local chain |
| Indexer (no lane owner) | IMPLEMENTED for its listed projections | Gateway transfers poll only for `Funded`/`Draining`; no balances; no `planHash` query |

## Lane 2 — boundary, payer, receipts, pocket, pullback, jobs

| Item | Status | Evidence |
|---|---|---|
| T-046 boundary | UNWIRED; no production `ModelClient` (gated by G0-16/K18) | `apps/server/src/boundary/index.ts:143-230`; composed only in `main.ts:310-375` |
| T-048 vault-direct payer + reservation sizing (PR #61) | UNWIRED (tested) | `payer/vault-direct.ts:151-656`; `payer/viem-chain.ts` has no test |
| T-049 receipts | UNWIRED + MISSING-PRODUCER (`settlement.isSettled`, `receiptInput`) | `evidence/receipts.ts:40-50,195`; `main.ts:377-400` |
| T-052/T-053/T-054 pocket, pullback, job (PRs #52, #60) | UNWIRED (tested with injected fixtures) | all reachable only through `createServerMain` |
| Halt drain | MISSING-PRODUCER | `PocketHaltDependencies` (`payer/pocket.ts:45-48`) has only test producers; `PullbackInput.availableBalance` has no source |
| Late funds after pocket close | GAP | `pullback.ts:590-618` tries `writeOffPocket` on a `Closed` pocket, which the vault rejects; required test `payer_pocketClose_sweepsGasAndRecoversLateBalance` absent |
| Manual return producer | MISSING-PRODUCER | `manual-return-required` is reachable only through `createServerMain` and is signer-blocked |
| Deliverable purge | MISSING-PRODUCER (needs T-055 decision record) | `purgeUnmatchedJobDeliverables({jobKey, matchedContentHash, decisionAt})` `payer/job.ts:966-994` |
| Execution dispatcher, `opening → executing`, results, `objective.delivered/failed` | GAP, unowned | verification report A §6.1 |

## Lane 3 — acceptance and evidence

| Item | Status | Evidence |
|---|---|---|
| T-047 acceptance checker (PR #43) | UNWIRED; matches its acceptance list; `AcceptancePorts` has no production producer | `apps/server/src/acceptance/*`, `test/acceptance/checker.test.ts:86,124,133,236,276`; ports `acceptance/types.ts:31-38` |
| T-056 profiles | GAP (partial: the requirement check exists inside T-047) | no `acceptance/profiles/` |
| T-057 publisher, T-058 verifier, T-055 evaluator | GAP | no code; no evaluator-decision table in migrations 0001–0010 |

## Lane 4 — daemon and plugins (held for Track B)

| Item | Status | Evidence |
|---|---|---|
| T-060 skeleton, T-061 pairing (PR #30) | IMPLEMENTED | `apps/daemon/src/*`; `czar pair`; server `/v1/devices/pair` |
| T-065 model proxy (PR #31) | UNWIRED (503 without a model client) | `apps/server/src/models/proxy.ts`; `app.ts:510` |
| Hook intake | counter only | `apps/daemon/src/daemon.ts:84-86` |
| Redaction sidecar | built and tested, never started | `apps/daemon/src/sidecar.ts` not referenced by `daemon.ts`/`cli.ts` |
| T-109 partial; T-062, T-063, T-066, T-068, T-069, T-073 | GAP | daemon schema `user_version` 1 with 11 tables; `plugins/` and `apps/mcp/` hold `.gitkeep` only |

## Lane 5 — web app and app-facing routes

| Item | Status | Evidence |
|---|---|---|
| Auth, reads, approvals, freeze intent, onboarding, ledger wording (PRs #54/#55) | IMPLEMENTED (routes live in `createApp`) | `apps/server/src/app/*`, `apps/web/app/*` |
| App reads in the local stack | MISSING-PRODUCER (config) | `local-main.ts` passes no `appReadOptions`; `reads.ts:500-508` throws on missing env; process-compose sets none |
| Approval → `executing` | GAP (no `EnvelopeOpened` match; see SCR-132) | `approvals.ts:346-357` stops at `opening` |
| Freeze → `lowerAutoLimit` listener (T-085) | GAP | no caller in `apps/server` |
| Devices page | UNWIRED; app routes not in spec | `settings/devices/page.tsx:1-11` placeholder |
| Passkey transport | DECISION (CZ-22 §4 vs SCR-125) | SDK 1.0.16 exports `toPasskeyTransport`; code follows SCR-125 |
| Test defaults in production code | GAP (code) | `apps/web/packages/wallet.ts:11-13` |
| Approval-page JS budget | DEFERRED-VALIDATION (not measured) | only `/` is measured (`apps/web/e2e/app.spec.ts:25-35`) |
| Statement/shadow data | MISSING-PRODUCER (T-095, T-070 have no lane) | labelled sample previews allowed by SCR-125 §4 |

## Ownership gaps that block the payment path
- **`apps/server/src/main.ts`** is already Lane 2's under accepted SCR-126 §2, which also fixes its start order. But the lane table never recorded it, and the started entry does not call it.
- **Not owned by any lane:**
  - `apps/server/src/local-main.ts`, `local-app.ts`, `app.ts`, `index.ts`, `planner/`, `objectives/`, `router/`, `db/`, `models/`, `http/`, `devices/`, `object-store.ts`, `apps/server/migrations/`
  - `apps/indexer/`, `apps/merchants/`, `ops/`
- **Tasks with no lane:** T-043, T-045, T-071, T-090, T-091, T-115, T-070, T-095.
- **SCR-136** assigns:
  - all of the folders
  - T-043, T-045, T-090, T-091 and T-115
- **Left to the Track B replan:** T-071, T-072, T-070 and T-095.
