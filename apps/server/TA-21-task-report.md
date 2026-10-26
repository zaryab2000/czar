# TA-21 — Pocket recovery and pullback runtime integration

## Status

Implemented the Lane 2 halt-drain and late-pocket recovery composition for the local server path, and connected API-down slow withdrawal to the indexer's persisted Gateway balance projection. This report records development checks only; it does not claim Arc Anvil or live Gateway acceptance.

## Behavior

- `createLocalServerMain` passes the local deployment's Gateway minter and domain into the server composition.
- When that deployment context is present, `createServerMain` composes funded-pocket halt draining and periodic closed-pocket recovery, and stops both timers and event subscriptions on shutdown.
- Halt draining discovers funded pockets through the indexer projection, runs the existing pullback flow, retries individual failures, and lets the event source retry a failed drain. The database-backed event source discovers user vaults at startup and polls for already halted and newly created vaults. The composition test supplies deployment metadata and verifies the vault event watcher is registered.
- Closed-pocket recovery reads the indexed Gateway balance. It uses the recovery pullback when balance exceeds fee and safety headroom, and the slow withdrawal plus pocket return for dust or an existing withdrawal. It does not use `writeOffPocket` for a closed pocket and does not retire a key while balances remain.
- The API-down scheduler now uses `pocket_balances.gatewayAvailableAtomic` from the indexer, including a stale but timestamped last-good observation as specified by SCR-141. With no observation or a failed read, it records `pullback.gateway-figure-missing`; an observed zero balance records `pullback.gateway-balance-empty`. Both cases wait without cancelling the pending pullback or signing. The signer remains authoritative for the API-down age, fresh-read, pending-withdrawal, and spend-after-observation checks; retryable denial codes are recorded and wait for a later poll.

## Files changed

- `apps/server/src/local-main.ts`
- `apps/server/src/main.ts`
- `apps/server/src/payer/indexer-pocket.ts`
- `apps/server/src/payer/pocket-recovery.ts`
- `apps/server/src/payer/pocket.ts`
- `apps/server/src/payer/pullback-scheduler.ts`
- `apps/server/src/payer/pullback.ts`
- `apps/server/src/payer/runtime.ts`
- `apps/server/test/payer/indexer-pocket.test.ts`
- `apps/server/test/main.test.ts`
- `apps/server/test/payer/pocket.test.ts`
- `apps/server/test/payer/pullback-scheduler.test.ts`
- `apps/server/test/payer/pullback.test.ts`
- `apps/server/test/payer/runtime.test.ts`

## Focused checks

- `fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run test/payer/pullback-scheduler.test.ts test/payer/pullback.test.ts test/payer/pocket.test.ts test/payer/runtime.test.ts test/payer/indexer-pocket.test.ts test/main.test.ts` — 6 files passed, 42 tests passed.
- `fnm exec --using=22.22.0 pnpm -r typecheck` — passed for all 14 of 15 workspace projects included by the command.
- `fnm exec --using=22.22.0 pnpm lint` — passed (`oxlint --deny-warnings` and `oxfmt --check`).
- `git diff --check` — passed.

## References and open dependencies

- SCR-127, SCR-133, and SCR-141; T-053 / TA-21; CZ-15 §5.3; CZ-19 §5.3, §5.4, and §5.6; CZ-27 `pocket-slow-withdraw` rules.
- The indexer projection is required at runtime for funded-pocket discovery and Gateway balances. If the indexer is unavailable, recovery waits and the runtime reports retry failures; it does not guess a balance.
- The local composition requires Gateway minter/domain deployment metadata. Without it, halt draining and closed-pocket recovery are disabled and the server logs that the halt monitor is disabled.

## Deferred validation

- NOT RUN: Arc Anvil pocket/pullback acceptance, crash/restart matrix, and transaction-level halt-drain scenarios. These were deferred by the assignment.
- NOT RUN: live Gateway or testnet validation; D92 remains in force.
- NOT RUN: full server test suite; only the focused payer/composition regression tests above were run.
