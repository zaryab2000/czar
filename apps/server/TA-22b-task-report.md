# TA-22b — Owner manual-return persistence and reconciliation

## Development status

Lane 2 persistence, event reconciliation, scheduled recovery, and the
user-scoped query helper are implemented. SCR-145 is accepted in PR #97 and
defines the stale-Gateway behavior; its signer change remains a separate Lane 1
implementation. This is development evidence only; it does not claim an owner
UserOp or testnet acceptance.

## Behavior

- Migration `0016-manual-return-reconciliation.sql` persists the hold start and
  the indexed owner-credit event's amount, transaction, and timestamp. Existing
  open rows receive a hold start during migration.
- Slow-path completion persists the mined USDC return receipt position and
  starts the owner hold. Reconciliation reads the Lane 1
  `manualReturnsForVault(vault)` projection and matches the same pocket only
  when `(block, logIndex)` is after the return receipt position. If a pocket is
  closed while the indexer has not caught up, the server reads the vault's
  `ManualReturnRecorded` logs from the return block before expiring the row.
  The matching event's credited amount and transaction are stored.
- Legacy rows without receipt coordinates recover the return transaction from
  the persisted slow-return execution phase, verify its successful USDC
  `Transfer(pocket, vault)` receipt, and persist the position before matching.
  An unresolved row is logged and retried without aborting other rows; it is
  excluded from overdue write-off until its return position is known.
- The payer recovery timer runs reconciliation and retries eligible write-offs
  after `payer.manualReturnHoldHours`. The overdue path reads on-chain pocket
  state and pending pullback before attempting write-off under the executor
  lease. The signer still requires a fresh Gateway API balance observation, so
  an outage can block the attempt; this policy conflict is recorded below. The
  hold is also checked at the direct pullback and pocket-close write-off entry
  points.
- `listManualReturnsForUser` scopes pending, recorded, and expired rows through
  the owning objective's `user_id`, returning the fields required by the
  canonical `ManualReturn` response.
- Review fixes at `a91bd5e` isolated legacy-row recovery failures and used
  on-chain manual-return events before expiry. The latest code review also
  found that one overdue write-off failure could stop later candidates;
  failures are now reported per row and later candidates continue.

## Files changed

- `apps/server/migrations/0016-manual-return-reconciliation.sql`
- `apps/server/src/main.ts`
- `apps/server/src/payer/indexer-pocket.ts`
- `apps/server/src/payer/pocket.ts`
- `apps/server/src/payer/pullback-scheduler.ts`
- `apps/server/src/payer/pullback.ts`
- `apps/server/test/payer/indexer-pocket.test.ts`
- `apps/server/test/payer/manual-return.test.ts`
- `apps/server/test/payer/pocket.test.ts`
- `apps/server/test/payer/pullback.test.ts`
- `apps/server/TA-22b-task-report.md`

## Focused checks

- `docker compose -f apps/server/test/compose.yaml up -d` — started the pinned
  Postgres 16.15 test service on `127.0.0.1:15432`; container reported healthy.
- `fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run test/payer/manual-return.test.ts test/payer/pullback.test.ts test/payer/pocket.test.ts test/payer/indexer-pocket.test.ts test/payer/pullback-scheduler.test.ts test/main.test.ts` — 6 files passed, 63 tests passed.
- `fnm exec --using=22.22.0 pnpm -r typecheck` — passed for all 14 workspace projects selected by pnpm.
- `fnm exec --using=22.22.0 pnpm lint` — passed (`oxlint --deny-warnings`; formatting check passed for 442 files).
- `git diff --check` — passed.

## Cross-lane merge order and implementation split

- **T-125 stale-Gateway write-off:** SCR-145 is accepted in PR #97. It specifies
  that signer denial leaves the row `manual-return-required` and retries at
  `payer.gatewayRecoveryPollSeconds`; the row becomes `expired` only after a
  mined write-off, while an earlier owner credit becomes `recorded`. The
  Lane 1 signer exception and tests remain a separate implementation. PR #96
  may merge after #97, without waiting for that signer implementation.
- The two latest-head code-review findings were fixed: per-candidate write-off
  errors no longer abort the pass, and closure reconciliation checks chain
  logs before expiring against a lagging indexer projection. Both have focused
  test coverage. Code/security review run 3 completed on `88d5c96`, and Lane 4
  found no new blocker in that source delta. The current head `4a39917` adds the
  SCR-145 retry regression test and report update; it still needs Lane 4
  pre-review. The Codex review cap is reached, and no further Codex run should
  be requested.
- The SCR-145 Lane 2 regression test drives a signer denial through
  `writeOffOverdueManualReturn`, verifies the row stays pending, and verifies a
  second retry at the configured recovery interval.

## Cross-lane handoff and open items

- Lane 1's `GET /pockets/manual-returns?vault=...` indexer query is present on
  `build-v1` (PR #95) and supplies the block and log index used here.
- Lane 5 still owns the canonical `GET /v1/pockets/manual-returns`
  `listManualReturns` endpoint and the Envelope/Home presentation that lets the
  owner submit `recordManualReturn` as a UserOp. This PR does not add a public
  route or let server keys perform the owner action. Lane 5 can use
  `listManualReturnsForUser` for its user-scoped data source.
- No SCR file was added. SCR-145 is in PR #97; merge it before PR #96. The
  storage, state transitions, hold duration, and public contract are otherwise
  specified by SCR-133 and the canonical OpenAPI contract.

## Deferred validation

- NOT RUN: Arc Anvil or testnet owner UserOp acceptance for `recordManualReturn`;
  assigned to the later validation phase under D94/M8. No chain transaction was
  submitted.
- NOT RUN: full-system payment, crash/restart, hosted model, Gateway, or
  deployment validation; these are outside this assignment's validation
  boundary.
