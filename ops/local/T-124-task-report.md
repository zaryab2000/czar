# T-124 Gateway balance projection task report

## Implemented

- Added the indexer `pocket_balances` projection and Gateway `/v1/balances` poll. Decimal balances
  are parsed exactly into six-decimal atomic units; malformed values never replace the last good
  observation. Chain reads for withdrawing balance, withdrawal block, and pocket USDC balance use
  the same observed block.
- Poll scope includes Registered, DelegateReady, Funded, Draining, and Closed pockets. Closed
  pockets remain polled until API balance, `pendingBatch`, on-chain withdrawing balance, and pocket
  USDC all read zero for the configured quiet period. Failed or malformed reads preserve the
  quiet-period start; stopping also requires a fresh API observation and successful current-cycle
  chain reads.
- Added pocket balance, funded pockets for a vault, and Closed pockets with balance queries. The
  balance query returns API age, chain age, and derived `slowWithdrawalOpen`.
- Added `pocket-stale` and `gateway-poll-failing` alert rows without storing Gateway response
  bodies. `pocket-stale` requires a Funded or Draining pocket with a Closed envelope older than
  `indexer.pocketStaleHours`; API age alone does not activate it. The poll-failing streak counts
  Gateway API failures only and resets on each successful API request; chain-read failures do not
  contribute.
- The signer reads Gateway balance data from the indexer projection and reads USDC, native,
  withdrawing balance, and withdrawal block from RPC. Stale or failed API observations deny
  retirement and write-off. Pocket return uses current EOA balances and remains available when the
  Gateway figure is stale. Write-off enforces no pending pullback, no active slow withdrawal, and a
  fresh balance at or below the configured fee plus safety amount. Slow-withdraw initiation uses the
  fresh figure normally and the last good observed figure after the configured API outage, subject
  to exact amount and K4 audit-spend checks. The `withdraw` step uses only current on-chain state.
  `nanoSpent` counts received, batched, confirmed, and completed transfers.

## Specification rulings applied

SCR-141 was accepted and merged in PR #81. Its §§1–2 resolve the two earlier implementation
questions: API-down initiation may use the last good `apiObservedAt` figure with the required K4
audit guard; `withdraw` relies only on on-chain state; and `closedZeroSince` is an internal durable
field whose zero check includes `pendingBatch` and preserves its start time after failed reads.
The final stop check requires a fresh API observation and successful current-cycle chain reads.
SCR-141's objective-volume and routing decisions belong to TA-08, not this task.

## Verification

- `fnm exec --using=22.22.0 pnpm --filter @czar/indexer typecheck` — passed.
- `fnm exec --using=22.22.0 pnpm --filter @czar/signer typecheck` — passed.
- `fnm exec --using=22.22.0 pnpm --filter @czar/signer test` — 115 passed, 1 skipped.
- `fnm exec --using=22.22.0 pnpm --filter @czar/indexer exec vitest run --exclude
  test/replay-anvil.test.ts` — 79 passed. The excluded local Arc replay is reported below.
- `fnm exec --using=22.22.0 pnpm exec vitest run test/gateway-balances.test.ts test/query-api.test.ts`
  from `apps/indexer/` — 40 passed.
- `fnm exec --using=22.22.0 pnpm exec vitest run test/gateway-balances.test.ts` from
  `apps/indexer/` — 22 passed, including the pocket-stale and API-failure streak rules.
- `fnm exec --using=22.22.0 pnpm exec vitest run test/postgres-projection.test.ts test/policy.test.ts
  test/service.test.ts` from `apps/signer/` — 71 passed.
- `fnm exec --using=22.22.0 pnpm exec vitest run test/postgres-projection.test.ts` from
  `apps/signer/` — 11 passed after adding the slow-withdraw eligibility cases.
- `fnm exec --using=22.22.0 pnpm lint` — passed.
- GitHub Actions runs `40205563664` (push) and `40205579662` (pull request), plus `40205563676`, `40205579698`, `40205634767`, and `40205634725`, failed before jobs started because recent account payments failed or the spending limit needs to be increased; no hosted job result is available.
- `git diff --check` — passed.
- `fnm exec --using=22.22.0 prek run` — unavailable; this repository has no `prek.toml` or `.pre-commit-config.yaml`.
- A previous full indexer-suite invocation failed in the existing `replay-anvil.test.ts` while
  invoking `contracts/script/deploy.sh` against its local Arc Anvil. The test suppresses the
  subprocess stdout and stderr, so it provides no further error detail. Per the current instruction,
  no Arc replay or live Gateway acceptance was rerun. The SCR-141 changes were covered by the
  passing indexer and signer suites above.

## Deferred

- D94 running-Arc stand-in round trip.
- G0-05 live `/v1/balances` behaviour and the T-050a running-Arc stand-in round trip.
- No commits were pushed to `build-v1`; no merge performed.
