# TA-12 — Freeze auto-limit listener

## Implementation

On a `Frozen` event, the payer now reads `autoLimit` for every unique category
in `planner.categoryByCapability`. It skips categories already at zero and
signs `lowerAutoLimit(categoryId, "0")` through the existing K3 `cz-15`
vault-call path for the rest. Each transaction must mine successfully before
the handler completes. Signer, RPC, or transaction failures are logged without
category or transaction data and propagated so the existing database event
source retries on its next poll. `GuardianPaused` continues to drain pockets
without changing category limits.

The production composition subscribes to the database vault-event source even
when pocket-drain dependencies are unavailable, so the auto-limit action still
runs. Duplicate in-flight events for the same vault and event share one handler.
Pocket draining and auto-limit lowering are attempted independently; either
failure causes the event source to retry. Replayed events re-read on-chain
state and skip limits already at zero.

Frozen event identities and scan cursors are persisted in PostgreSQL. Each
source scan reads Frozen logs from the last durable cursor and replays pending
events regardless of the vault's current frozen state. A crash after the
on-chain lowering but before the work row is marked complete is safe: replay
reads the zero limit and skips signing again.

## Files changed

- `apps/server/src/main.ts` — compose K3 lower-limit calls and always attach the
  existing event source.
- `apps/server/src/payer/freeze-autolimit.ts` — per-category chain reads,
  lowering, safe failure logging, and retry propagation.
- `apps/server/src/payer/runtime.ts` — Frozen-only callback, in-flight event
  deduplication, and retry propagation.
- `apps/server/src/payer/freeze-events.ts` — durable event queue, cursor scan,
  and pending-work replay.
- `apps/server/src/payer/database-vault-event-source.ts` and
  `apps/server/src/payer/vault-event-source.ts` — event identity capture,
  historical Frozen-log scan, and retry after unfreeze or downtime.
- `apps/server/migrations/0017-freeze-auto-limit-events.sql` — event work and
  per-vault scan cursor tables.
- `apps/server/test/payer/freeze-autolimit.test.ts` — nonzero/zero behavior,
  replay, signer refusal, and equality with the onboarding category set.
- `apps/server/test/payer/freeze-events.test.ts` — durable retry after an
  unfreeze and recovery of historical Frozen events.
- `apps/server/test/payer/runtime.test.ts` — Frozen vs GuardianPaused behavior,
  retry propagation, and concurrent duplicate event handling.
- `apps/server/test/payer/database-vault-event-source.test.ts` and
  `apps/server/test/migrate.test.ts` — source replay and migration coverage.

## Checks

- `fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run test/payer/freeze-events.test.ts test/payer/database-vault-event-source.test.ts test/payer/runtime.test.ts test/payer/freeze-autolimit.test.ts test/migrate.test.ts`
  — passed: 5 files, 18 tests.
- `fnm exec --using=22.22.0 pnpm -r typecheck` — passed across all 14 workspace
  projects with typecheck scripts.
- `fnm exec --using=22.22.0 pnpm lint` — passed.
- `fnm exec --using=22.22.0 pnpm --filter @czar/server test` — run on the
  initial implementation commit `30579ff`; not green: 58 files passed, 3 failed;
  364 passed, 2 failed, 2 skipped. The two non-Arc
  failures were `test/app-reads.test.ts` requiring an RPC at `127.0.0.1:8549` and
  `test/job-routes.test.ts` starting the local server with RPC `127.0.0.1:1`;
  both need the local Arc fixture. `test/evidence/receipt-arc.test.ts` also
  failed while running its local deployment script against port 18546. The full
  server suite was not rerun after the review-fix batch; these local-chain
  checks remain unverified.

## Deferred and remaining

- T-085 M8 testnet acceptance remains deferred; no testnet or hosted calls were
  made.
- This change lowers category limits after Frozen. Pocket draining still needs
  the existing Gateway deployment context; when absent, startup logs
  `payer_pocket_drain_disabled`. This PR does not claim that independent halt
  draining is complete.
- No SCRs filed.
