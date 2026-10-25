# Lane 2 briefs (server payments and execution runtime)

Lane 2 owns the server composition root (SCR-126 §2) and, under SCR-136, `local-main.ts`, `local-app.ts`, `index.ts`, `planner/`, `objectives/`, `router/`, `db/`, `models/`, `object-store.ts` and `evidence/receipts.ts`.

## TA-08 Composition root, planner loop, opening watcher (T-122 part 1)
- **Gate:** SCR-132, SCR-136. **Deps:** TA-02, TA-06, TA-07, TA-10. **Branch:** `codex/t122-runtime-composition`.
- **Files:** `apps/server/src/local-main.ts`, `local-app.ts`, `main.ts`, `boundary/index.ts` (optional model), `planner/` (loop driver), `objectives/` (opening watcher, `planning → received` edge in `state.ts`).
- **Build:**
  - `local-main.ts` becomes the started composition root in the SCR-132 §6 order. It calls `createServerMain`, so SCR-126 §2's started-root test now covers the real entry. That test runs on `arc-anvil`, so in this phase it is reported `NOT RUN / DEFERRED` (SCR-136 §3).
  - Configuration comes only from:
    - `@czar/config`
    - the deployment manifest
    - the launcher pointers listed in SCR-132 §6
  - Make `modelClient` optional in `ServerMainOptions` and `BoundaryDependencies`. When it's absent, take the ai-prompts P-01 "model unavailable" branch. No classifier stand-in.
  - **Planner ports:**
    - `ranking`/`directory`: TA-06
    - `allowance`: the contract's own rule (03 `czar-vault.md` `:150`, `:217`): `remaining = sat(autoLimit, usedInPeriod)` when `periodId == now / PERIOD_LENGTH`, else `autoLimit` (a new period resets `usedInPeriod`); TA-10 reader; any read error → `"0"` (approval required)
    - `agentHosts`: `false`
    - `pocketKeys`: signer `createPocketKey`
  - **Planner loop:** `planner.pollMs`; reclaim `planning → received` after `planner.claimTimeoutSeconds`, with no new outbox row.
  - **Opening watcher:** the SCR-132 §2 scope, the match transaction (`objectives.envelope_ref`, `executing`, `plan.approved`), the timeout and `expiresAt` handling.
  - **Graceful stop:** stop the loops, release leases, close pools.
- **Tests first:**
  - The started root composes every component in order. Raw env reads are limited to the SCR-132 §6 list.
  - Planner loop:
    - claims one `objective.received`
    - reclaims a stuck claim after the timeout without a duplicate outbox row
  - Opening watcher:
    - scope: every `opening` objective, plus `awaiting-approval` objectives whose plan is `approved`
    - matches only an `Open` envelope of the user's own vault with the same `planHash`
    - ignores other vaults and `Closed` envelopes
    - after the timeout: the objective is `awaiting-approval`, the plan stays `approved`, and a late `EnvelopeOpened` still matches
    - at `expiresAt` with no match: plan and objective are `expired`
  - With no model, a step quarantines with `screen-unavailable`.
- **Acceptance:** tests, server tests for the touched suites, typecheck, lint.
- **Deferred:** the process-level run on `arc-anvil` (T-050a).

## TA-09 Dispatcher, receipt ports, completion (T-122 part 2)
- **Gate:** SCR-132, SCR-128. **Deps:** TA-08, TA-01. **Branch:** `codex/t122-dispatcher-completion`.
- **Files:**
  - `apps/server/src/payer/` (dispatcher module; `viem-chain.ts` tests)
  - `apps/server/src/evidence/receipts.ts`
  - `apps/server/src/objectives/` (completion)
- **Build:**
  - **Dispatcher:** `payer.dispatchPollMs`; lease through `executor_leases`; `dependsOn` order; frozen/paused check before each step; resume from `step_executions`.
  - **Receipts:**
    - change the internal port `settlement.isSettled(vault, paymentHash)` (`receipts.ts:31,50`) to take the step's `PaymentRef`; implement it against the indexer `authorizations` row `(vault, nonce, amount, settled)`
    - `receiptInput` from the step trace
    - every `sl-receipt` request carries the full `PaymentRef` (SCR-128)
  - **Completion** per SCR-132 §4:
    - K3 `closeEnvelope` once every reservation is `Final`, every pocket `Closed` and every job terminal (03 preconditions)
    - one `results` row
    - `delivered`/`failed`; `result-quarantined` for an all-quarantined objective
    - the matching objective event
- **Tests first (money path):**
  - dispatcher: `dependsOn` order; a lease held elsewhere is not entered; an expired lease resumes without a second reserve; a frozen vault starts no step
  - receipts: the request's `PaymentRef` hashes to `paymentRefHash`; an unsettled authorization means no receipt is requested
  - completion: idempotent on retry; `closeEnvelope` is not sent before every reservation is `Final`, every pocket `Closed` and every job terminal; all-quarantined → `failed` with `result-quarantined` and no merchant content in `rendered_body`
  - `viem-chain.ts` unit tests on a mocked transport
- **Acceptance:** tests, server tests for the touched suites, typecheck, lint.
- **Deferred:** T-050a, crash/restart matrix, T-050b (M8).

## TA-12 Freeze → `lowerAutoLimit` listener (T-085 server part)
- **Gate:** SCR-136 §2 (T-085 split). **Deps:** TA-08.
- **Files:** `apps/server/src/payer/runtime.ts` (the existing `Frozen` subscriber), a small autonomy module in `payer/`.
- **Build:**
  - On `Frozen`, lower to 0 every category in `planner.categoryByCapability`, skipping those already at 0 (CZ-24 "`0` for every category"; T-085 split in SCR-136 §2). It equals the set the app's limits screen writes (`apps/web/app/onboarding/limits/page.tsx:12`); assert that equality in a test.
  - Skip categories whose `getLimits(...).autoLimit` is already 0.
  - Sign `vault-call lowerAutoLimit(categoryId, 0)` with K3 as `cz-15`. The contract accepts the agent while frozen (`AutonomyLogic.sol:57-67`).
  - Idempotent per `Frozen` event.
- **Tests first:** only non-zero categories are lowered; a replayed `Frozen` sends nothing new; a signer refusal is logged and retried with the existing backoff; the category-set equality.
- **Acceptance:** tests, lint, typecheck.
- **Deferred:** the T-085 testnet check (M8).

## TA-21 Halt drain inputs, late funds, write-off rule (T-053)
- **Gate:** SCR-127. **Deps:** TA-20, TA-08.
- **Files:** `apps/server/src/payer/pocket.ts`, `pullback.ts`, `pullback-scheduler.ts`; `main.ts` composition of `pocketHalt` and `gatewayStatus`.
- **Build:**
  - Inputs:
    - `PocketHaltDependencies` from `fundedPocketsForVault`, with `planId` from `plan_pocket_keys`
    - `availableBalance` from `pocketBalance` under the max-age rule (stale → wait, record `gateway-balance-stale`)
    - `gatewayStatus` from `gateway_transfers`
  - Rules:
    - write-off at or below the fee (SCR-127 §4)
    - one slow withdrawal per pocket, for the whole available balance
    - the recovery pass every `payer.gatewayRecoveryPollSeconds`, with recovery `value = gatewayAvailableAtomic − payer.pullbackMaxFeeAtomic − payer.pullbackSafetyAtomic` (no `outstanding` bound)
    - never `writeOffPocket` on a `Closed` pocket
- **Tests first:**
  - `payer_pocketClose_sweepsGasAndRecoversLateBalance`
  - a stale balance never yields a pullback value
  - dust ≤ fee allows write-off, then recovery after close
  - no second `initiateWithdrawal` while one is open
  - drain covers vaults already halted at startup
- **Acceptance:** tests, lint, typecheck.
- **Deferred:** G0-05; the local-chain freeze/pause scenario; the crash/restart matrix.

## TA-22b Manual return: persistence, reconciliation, hold (T-125)
- **Gate:** SCR-133. **Deps:** TA-21, TA-22a.
- **Files:** a new migration (the next free number after `0010`, rechecked at PR time); `payer/pullback.ts` and `pullback-scheduler.ts`; the reconciliation pass; the write-off hold.
- **Tests first:**
  - `recorded` on a matching event ordered after `return_tx` by `(block, logIndex)` (store `return_block`, `return_log_index`)
  - `expired` when the pocket closed first
  - the hold blocks write-off until `payer.manualReturnHoldHours`, then write-off proceeds and the row expires
  - rows are scoped to their user
- **Acceptance:** tests, lint, typecheck.
