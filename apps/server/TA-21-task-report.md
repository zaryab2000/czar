# TA-21 — Pocket recovery and pullback runtime integration

## Status

Implemented the Lane 2 halt-drain and late-pocket recovery composition for the local server path, including the accepted SCR-144 slow-path restart behavior. PR #91 remains open. SCR-144 publication PR #94 must merge before the final rebase/review handoff. This report records development checks only; it does not claim Arc Anvil or live Gateway acceptance.

## Behavior

- `createLocalServerMain` passes the local deployment's Gateway minter and domain into the server composition.
- When that deployment context is present, `createServerMain` composes funded-pocket halt draining and periodic closed-pocket recovery, and stops both timers and event subscriptions on shutdown.
- Halt draining discovers funded pockets through the indexer projection, runs the existing pullback flow, retries individual failures, and lets the event source retry a failed drain. The database-backed event source discovers user vaults at startup and polls for already halted and newly created vaults. The composition test supplies deployment metadata and verifies the vault event watcher is registered.
- Closed-pocket recovery reads the indexed Gateway balance. It uses the recovery pullback when balance exceeds fee and safety headroom, and the slow withdrawal plus pocket return for dust or an existing withdrawal. It does not use `writeOffPocket` for a closed pocket and does not retire a key while balances remain.
- The API-down scheduler uses `pocket_balances.gatewayAvailableAtomic` from the indexer, including a stale but timestamped last-good observation as specified by SCR-141. A missing observation or failed read records `pullback.gateway-figure-missing`; an observed zero balance records `pullback.gateway-balance-empty`. Both wait without cancelling or signing. Stale/failing balance observations are persisted with their first observed outage time, allowing the configured API-down fallback even when no pullback request exists yet. A healthy observation clears only an unlinked balance-outage row. The signer remains authoritative for age, observation, pending-withdrawal, and spend-after-observation checks.
- Slow-withdrawal continuation re-derives each next action from fresh `withdrawingBalance`, `withdrawalBlock`, EOA USDC, and transaction receipt reads. Execution phases are retained as transaction history, not treated as authoritative chain state.
- The recovery pass scans open closed-pocket rows in `payer_pullback_gateway_failures` before the indexer closed-pocket query, so a restart can resume after the indexer no longer reports the pocket. New closed-pocket recovery writes its durable row before requesting a K4 signature.
- Slow-path transaction hashes are persisted before broadcast. Recovery reuses the exact stored signed transaction when its receipt is not yet available. A return becomes terminal only when the mined receipt contains exactly one USDC `Transfer(pocket, vault)` and fresh chain reads show zero EOA USDC and zero Gateway withdrawing balance; block, log index, and amount are stored with the transaction hash.
- Migration `0015-scr-144-slow-pullback-resume.sql` adds the slow-path transaction/receipt fields, the single-open-closed-row-per-pocket constraint, and SCR-144's final state set: `pending`, `manual-return-required`, `recorded`, `expired`, `returned-to-vault`.
- Closed-pocket pullbacks and slow-return cycles use a new durable attempt only after the prior cycle is confirmed/returned; retries resume the existing attempt.
- Gateway failures during closed-pocket recovery persist the selected attempt and closed-pocket status. The outage scheduler resumes that attempt through pocket-return, then records `returned-to-vault` instead of requesting owner manual-return.
- A new closed-pocket outage after a prior return reopens the durable failure row with the new attempt and outage time; the previous return transaction remains in `step_executions`.
- A healthy Gateway observation cannot delete a pending outage row while a slow withdrawal or return transaction is recorded; the scheduler retains the row until recovery completes.
- The funded-pocket parser accepts `Registered` and `DelegateReady`; halt draining selects only `Funded` and `Draining` pockets.

## Files changed

- `apps/server/src/local-main.ts`
- `apps/server/src/main.ts`
- `apps/server/src/payer/indexer-pocket.ts`
- `apps/server/src/payer/pocket-recovery.ts`
- `apps/server/src/payer/pocket.ts`
- `apps/server/src/payer/pullback-scheduler.ts`
- `apps/server/src/payer/pullback-chain-adapter.ts`
- `apps/server/src/payer/pullback.ts`
- `apps/server/src/payer/runtime.ts`
- `apps/server/migrations/0013-pullback-balance-outage.sql`
- `apps/server/migrations/0014-pullback-closed-recovery.sql`
- `apps/server/migrations/0015-scr-144-slow-pullback-resume.sql`
- `apps/server/test/payer/indexer-pocket.test.ts`
- `apps/server/test/main.test.ts`
- `apps/server/test/payer/pocket-recovery.test.ts`
- `apps/server/test/payer/pocket.test.ts`
- `apps/server/test/payer/pullback-scheduler.test.ts`
- `apps/server/test/payer/pullback-chain-adapter.test.ts`
- `apps/server/test/payer/pullback.test.ts`
- `apps/server/test/payer/runtime.test.ts`

## Focused checks

- `fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run test/payer/pullback-chain-adapter.test.ts test/payer/pullback-scheduler.test.ts test/payer/pullback.test.ts test/payer/pocket-recovery.test.ts` — 4 files passed, 39 tests passed, including the three SCR-144 restart/write-ahead regressions.
- TDD evidence: before the scheduler discovery fix, the first SCR-144 restart test failed because the recovery pass returned `0` rows instead of processing the pending closed-pocket row.
- `fnm exec --using=22.22.0 pnpm --filter @czar/server typecheck` — passed.
- `fnm exec --using=22.22.0 pnpm lint` — passed (`oxlint --deny-warnings` and `oxfmt --check`).
- `git diff --check` — passed.
- `fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run test/payer/pullback-scheduler.test.ts test/payer/pullback.test.ts test/payer/pocket.test.ts test/payer/runtime.test.ts test/payer/indexer-pocket.test.ts test/payer/pocket-recovery.test.ts test/main.test.ts` — 7 files passed, 51 tests passed.
- `fnm exec --using=22.22.0 pnpm -r typecheck` — passed for all 14 of 15 workspace projects included by the command.
- `fnm exec --using=22.22.0 pnpm lint` — passed (`oxlint --deny-warnings` and `oxfmt --check`).
- `git diff --check` — passed.

## Accepted SCR-144 and remaining integration dependencies

- SCR-144's Lane 2 slow-path ordering is implemented on PR #91. Its specification publication remains open as PR #94; merge that PR, then merge fresh `origin/build-v1` into this branch before final review.
- Lane 1 TA-22a still owns adding `logIndex` to the canonical `manualReturnsForVault` projection. Lane 2 now stores `(return_block, return_log_index, returned_amount)` from the mined USDC receipt; it does not change indexer code.
- Migration `0015` extends the final pullback state constraint. Coordinate its number and state-set with TA-22b before merging; no TA-22b PR is currently open.
- The existing run-2 code review is still reported running against older commit `a23f05c`; the paired security review completed on that old commit and its finding was fixed in earlier commits. No current-head hosted review is claimed.

## References and open dependencies

- SCR-127, SCR-133, and SCR-141; T-053 / TA-21; CZ-15 §5.3; CZ-19 §5.3, §5.4, and §5.6; CZ-27 `pocket-slow-withdraw` rules.
- The indexer projection is required at runtime for funded-pocket discovery and Gateway balances. If the indexer is unavailable, recovery waits and the runtime reports retry failures; it does not guess a balance.
- The local composition requires Gateway minter/domain deployment metadata. Without it, halt draining and closed-pocket recovery are disabled and the server logs that the halt monitor is disabled.

## Deferred validation

- NOT RUN: Arc Anvil pocket/pullback acceptance, crash/restart matrix, and transaction-level halt-drain scenarios. These were deferred by the assignment.
- NOT RUN: live Gateway or testnet validation; D92 remains in force.
- NOT RUN: full server test suite; only the focused payer/composition regression tests above were run.
