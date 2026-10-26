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

Production startup waits until the durable historical scan has caught up for
every discovered vault before starting planner and dispatcher workers. Each
source poll scans at most one successful log page globally, rotates across
vaults, persists its cursor, and continues on the next poll. Each poll also
advances a durable per-vault scan watermark to the observed chain head;
allowance and dispatch remain gated while a vault's cursor trails that
watermark, including before historical Frozen rows have been discovered.
Allowance and dispatch checks read the durable queue without initiating RPC
backfill. A pending auto-limit lowering gates planner allowance and execution
only until the lowering transaction is acknowledged; pocket-drain retry remains
separate.

Frozen event identities and scan cursors are persisted in PostgreSQL. Each
source scan reads Frozen logs from the last durable cursor and replays pending
events regardless of the vault's current frozen state. A crash after the
on-chain lowering but before the work row is marked complete is safe: replay
reads the zero limit and skips signing again.

## Review fixes

- Planner allowance and dispatcher checks only read the durable pending-lowering
  marker; the event-source worker performs bounded RPC scanning. The server
  awaits historical catch-up before starting planner/dispatcher work.
- `GuardianPaused` drain failures now propagate so the event source retries
  rather than marking the pause handled.
- Historical Frozen logs use `indexer.getLogsBlockRange`, halve the page after
  RPC `-32012`, and persist each page's events and cursor in one transaction.
  A single successful page is scanned per source poll, with a rotating vault
  cursor. A durable chain-head watermark gates allowance and dispatch while a
  vault's cursor lags, even before a missed Frozen event is indexed. Startup
  readiness remains pending until every discovered vault has caught up. Cursor
  updates are monotonic, and queued work is replayed even if a later historical
  page fails.
- The event row records `auto_limits_lowered_at` separately from
  `processed_at`. A successful lowering is acknowledged before pocket draining;
  a failed drain remains retryable without repeating the lowering or blocking
  normal execution after the limit action completed.

## Files changed

- `apps/server/src/main.ts` — compose K3 lower-limit calls and always attach the
  existing event source.
- `apps/server/src/payer/freeze-autolimit.ts` — per-category chain reads,
  lowering, safe failure logging, and retry propagation.
- `apps/server/src/payer/runtime.ts` — Frozen-only callback, in-flight event
  deduplication, retry propagation, and startup readiness.
- `apps/server/src/payer/freeze-events.ts` — durable event queue, cursor scan,
  pending-work replay, adaptive RPC paging, and pending-lowering lookup.
- `apps/server/src/payer/database-vault-event-source.ts` and
  `apps/server/src/payer/vault-event-source.ts` — event identity capture,
  historical Frozen-log scan, startup synchronization, and retry after unfreeze
  or downtime.
- `apps/server/src/payer/dispatcher.ts` — pause spending while Frozen lowering
  remains queued.
- `apps/server/migrations/0017-freeze-auto-limit-events.sql` — event work and
  per-vault scan cursor tables.
- `apps/server/migrations/0018-freeze-auto-limit-progress.sql` — durable
  lowering acknowledgement independent of drain completion.
- `apps/server/migrations/0019-freeze-scan-watermark.sql` — durable per-vault
  chain-head watermark used to gate while historical scanning lags.
- `apps/server/test/payer/freeze-autolimit.test.ts` — nonzero/zero behavior,
  replay, signer refusal, and equality with the onboarding category set.
- `apps/server/test/payer/freeze-events.test.ts` — durable retry after an
  unfreeze, recovery of historical Frozen events, scan catch-up, adaptive
  paging, and atomic cursor progression.
- `apps/server/test/payer/runtime.test.ts` — Frozen vs GuardianPaused behavior,
  retry propagation, and concurrent duplicate event handling.
- `apps/server/test/payer/dispatcher.test.ts` — queued Frozen lowering blocks
  step execution.
- `apps/server/test/main.test.ts` — startup composition retains the durable
  freeze gate in the planner and dispatcher paths.
- `apps/server/test/payer/database-vault-event-source.test.ts` and
  `apps/server/test/migrate.test.ts` — source replay and migration coverage.
- `apps/server/test/main-dispatch.test.ts` — complete the mocked public client
  interface used by the real startup event scanner.
- `apps/server/test/main.test.ts` and
  `apps/server/test/payer/vault-event-source.test.ts` — startup scan readiness
  and event subscription readiness.

## Checks

- `fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run test/payer/freeze-events.test.ts test/payer/database-vault-event-source.test.ts test/payer/runtime.test.ts test/payer/freeze-autolimit.test.ts test/migrate.test.ts`
  — passed before the latest review fixes: 5 files, 18 tests.
- `fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run test/payer/freeze-events.test.ts test/payer/database-vault-event-source.test.ts test/payer/runtime.test.ts test/payer/freeze-autolimit.test.ts test/payer/dispatcher.test.ts test/payer/vault-event-source.test.ts test/main.test.ts test/migrate.test.ts`
  — passed after the latest review fixes: 8 files, 37 tests (includes
  `test/payer/vault-event-source.test.ts`).
- After syncing `build-v1` through PR #98 merge `c9664b7`,
  `fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run test/payer/freeze-events.test.ts test/payer/database-vault-event-source.test.ts test/payer/runtime.test.ts test/payer/freeze-autolimit.test.ts test/payer/dispatcher.test.ts test/payer/vault-event-source.test.ts test/main.test.ts test/migrate.test.ts test/payer/manual-return.test.ts test/payer/pullback-scheduler.test.ts test/app-manual-returns.test.ts`
  passed: 11 files, 58 tests, including the manual-return and pullback
  scheduler regressions changed by that merge.
- `fnm exec --using=22.22.0 pnpm -r typecheck` — passed across all 14 workspace
  projects with typecheck scripts after the review fixes.
- `fnm exec --using=22.22.0 pnpm lint` — passed after the review fixes.
- `git diff --check` — passed after the review fixes.
- `fnm exec --using=22.22.0 pnpm -r typecheck` and `fnm exec --using=22.22.0 pnpm lint`
  — both passed again after merging PR #98.
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

## Manual review follow-up

The designated reviewer identified two defects at `dc4a8c2`: a drain failure
could keep an already-completed auto-limit action marked pending, and a cold
scan could perform unbounded page requests in one poll. The follow-up changes
above add the independent durable acknowledgement and a one-page-per-poll
rotating scanner. Startup remains closed until historical catch-up is complete.

A current-head review then found that one failed queued event stopped processing
later events in the same batch. Processing now catches errors per event, leaves
failed rows pending, continues through later rows, and propagates one error or
an `AggregateError` after the batch so the source retries.

Lane 4 review then identified that a missed Frozen event followed by Unfrozen
could leave no queued event and a false current frozen state while backfill
lagged. The source now persists the observed chain head as each vault's scan
watermark, and the planner/dispatcher gate checks remain active until the
durable cursor reaches it. Vaults without a scan cursor are gated as well.
On every poll, caught-up state is recomputed against the advanced watermark, so
a previously caught-up vault is gated again if a newer head passes its cursor.

Focused checks after these fixes:

- `fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run test/payer/freeze-events.test.ts test/payer/database-vault-event-source.test.ts test/payer/runtime.test.ts test/main.test.ts test/main-dispatch.test.ts test/migrate.test.ts`
  — passed: 6 files, 27 tests.
- `fnm exec --using=22.22.0 pnpm -r typecheck` — passed across 14 workspace
  projects with typecheck scripts.
- `fnm exec --using=22.22.0 pnpm lint` — passed.
- `git diff --check` — passed.

Validation after the per-event retry fix:

- `fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run test/payer/freeze-events.test.ts test/payer/database-vault-event-source.test.ts test/payer/runtime.test.ts`
  — passed: 3 files, 20 tests. The added regression confirms later rows are
  lowered and processed after earlier drain errors, and all failures are
  surfaced after iteration.
- `fnm exec --using=22.22.0 pnpm -r typecheck` — passed across 14 workspace
  projects with typecheck scripts.
- `fnm exec --using=22.22.0 pnpm lint` — passed after formatting the test.
- `git diff --check` — passed.

Validation after the scan-watermark fix:

- `fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run test/payer/freeze-events.test.ts test/payer/database-vault-event-source.test.ts test/payer/runtime.test.ts test/main.test.ts test/main-dispatch.test.ts test/migrate.test.ts`
  — passed: 6 files, 30 tests. The freeze/unfreeze regression confirms a
  behind-cursor vault stays gated while the current chain state is unfrozen,
  then processes the discovered historical event after catch-up.
- `fnm exec --using=22.22.0 pnpm -r typecheck` — passed across 14 workspace
  projects with typecheck scripts.
- `fnm exec --using=22.22.0 pnpm lint` — passed.
- `git diff --check` — passed.

An attempted command `fnm exec --using=22.22.0 pnpm --filter @czar/server test -- test/payer/freeze-events.test.ts`
was interpreted by Vitest as a full-suite run. It failed while the regression
tests were intentionally in their red state; it also reported local RPC/Arc
fixture failures and planner database fixture failures. This is not counted as
validation. The full server suite remains unverified; Arc deployment and
acceptance remain deferred.
