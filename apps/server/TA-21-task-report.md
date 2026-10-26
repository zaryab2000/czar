# TA-21 — Pocket recovery and pullback runtime integration

## Status

Implemented the Lane 2 halt-drain and late-pocket recovery composition for the local server path, and connected API-down slow withdrawal to the indexer's persisted Gateway balance projection. Confirmed in-scope review findings to date are fixed. One canonical query gap remains an architect decision blocker; the PR is not ready for merge until that ruling is resolved. This report records development checks only; it does not claim Arc Anvil or live Gateway acceptance.

## Behavior

- `createLocalServerMain` passes the local deployment's Gateway minter and domain into the server composition.
- When that deployment context is present, `createServerMain` composes funded-pocket halt draining and periodic closed-pocket recovery, and stops both timers and event subscriptions on shutdown.
- Halt draining discovers funded pockets through the indexer projection, runs the existing pullback flow, retries individual failures, and lets the event source retry a failed drain. The database-backed event source discovers user vaults at startup and polls for already halted and newly created vaults. The composition test supplies deployment metadata and verifies the vault event watcher is registered.
- Closed-pocket recovery reads the indexed Gateway balance. It uses the recovery pullback when balance exceeds fee and safety headroom, and the slow withdrawal plus pocket return for dust or an existing withdrawal. It does not use `writeOffPocket` for a closed pocket and does not retire a key while balances remain.
- The API-down scheduler uses `pocket_balances.gatewayAvailableAtomic` from the indexer, including a stale but timestamped last-good observation as specified by SCR-141. A missing observation or failed read records `pullback.gateway-figure-missing`; an observed zero balance records `pullback.gateway-balance-empty`. Both wait without cancelling or signing. Stale/failing balance observations are persisted with their first observed outage time, allowing the configured API-down fallback even when no pullback request exists yet. A healthy observation clears only an unlinked balance-outage row. The signer remains authoritative for age, observation, pending-withdrawal, and spend-after-observation checks.
- Slow-withdrawal continuation now bypasses the balance gate once its durable transaction trace shows initiation, withdrawal, or return in progress.
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
- `apps/server/src/payer/pullback.ts`
- `apps/server/src/payer/runtime.ts`
- `apps/server/migrations/0013-pullback-balance-outage.sql`
- `apps/server/migrations/0014-pullback-closed-recovery.sql`
- `apps/server/test/payer/indexer-pocket.test.ts`
- `apps/server/test/main.test.ts`
- `apps/server/test/payer/pocket-recovery.test.ts`
- `apps/server/test/payer/pocket.test.ts`
- `apps/server/test/payer/pullback-scheduler.test.ts`
- `apps/server/test/payer/pullback.test.ts`
- `apps/server/test/payer/runtime.test.ts`

## Focused checks

- `fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run test/payer/pullback-scheduler.test.ts test/payer/pullback.test.ts test/payer/pocket.test.ts test/payer/runtime.test.ts test/payer/indexer-pocket.test.ts test/payer/pocket-recovery.test.ts test/main.test.ts` — 7 files passed, 51 tests passed.
- `fnm exec --using=22.22.0 pnpm -r typecheck` — passed for all 14 of 15 workspace projects included by the command.
- `fnm exec --using=22.22.0 pnpm lint` — passed (`oxlint --deny-warnings` and `oxfmt --check`).
- `git diff --check` — passed.

## Draft SCR for architect ruling — closed-pocket EOA return discovery

**Decision needed:** amend CZ-19 §5.4 so a closed pocket remains discoverable after Gateway `withdraw` has moved USDC from Gateway into the pocket EOA. SCR-127 §1 includes EOA USDC in the closed-pocket polling scope, but its §2 `closedPocketsWithBalance()` predicate selects only positive Gateway available or withdrawing balances. Once both Gateway values are zero, the query omits the pocket even when EOA USDC is waiting for `pocket-return`. A restart or poll between withdrawal and return can therefore strand that amount.

**Recommended minimum:** Lane 1's indexer query includes closed pockets when EOA USDC is positive and returns that observed EOA balance with the existing Gateway fields; Lane 2 continues the already-recorded slow-return execution from that row. This aligns the query with SCR-127 §1 and avoids inventing a second server-owned discovery API. Lane 1 owns the producer (`apps/indexer/src/api/store.ts` / query response); Lane 2 owns the consumer (`apps/server/src/payer/pocket-recovery.ts`). Acceptance should cover a closed dust withdrawal that moves USDC to the pocket EOA, a server restart before return, and successful return without another slow-withdraw initiation. No code for this unapproved query change is included here.

## References and open dependencies

- SCR-127, SCR-133, and SCR-141; T-053 / TA-21; CZ-15 §5.3; CZ-19 §5.3, §5.4, and §5.6; CZ-27 `pocket-slow-withdraw` rules.
- The indexer projection is required at runtime for funded-pocket discovery and Gateway balances. If the indexer is unavailable, recovery waits and the runtime reports retry failures; it does not guess a balance.
- The local composition requires Gateway minter/domain deployment metadata. Without it, halt draining and closed-pocket recovery are disabled and the server logs that the halt monitor is disabled.

## Deferred validation

- NOT RUN: Arc Anvil pocket/pullback acceptance, crash/restart matrix, and transaction-level halt-drain scenarios. These were deferred by the assignment.
- NOT RUN: live Gateway or testnet validation; D92 remains in force.
- NOT RUN: full server test suite; only the focused payer/composition regression tests above were run.
