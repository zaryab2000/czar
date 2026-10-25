# T-124 Gateway balance projection task report

## Implemented

- Added the indexer `pocket_balances` projection and Gateway `/v1/balances` poll. Decimal balances
  are parsed exactly into six-decimal atomic units; malformed values never replace the last good
  observation. Chain reads for withdrawing balance, withdrawal block, and pocket USDC balance use
  the same observed block.
- Poll scope includes Registered, DelegateReady, Funded, Draining, and Closed pockets. Closed
  pockets remain polled until all tracked balances read zero for the configured quiet period.
- Added pocket balance, funded pockets for a vault, and Closed pockets with balance queries. The
  balance query returns API age, chain age, and derived `slowWithdrawalOpen`.
- Added `pocket-stale` and `gateway-poll-failing` alert rows without storing Gateway response
  bodies.
- The signer reads Gateway balance data from the indexer projection and reads USDC, native,
  withdrawing balance, and withdrawal block from RPC. Stale or failed API observations deny
  retirement, write-off, and slow withdrawal. Pocket return uses current EOA balances and remains
  available when the Gateway figure is stale. Write-off enforces no pending pullback, no active
  slow withdrawal, and a fresh balance at or below the configured fee plus safety amount. Slow
  withdrawal initiation uses the exact fresh Gateway available amount and cannot be repeated while
  a withdrawal is open. `nanoSpent` counts received, batched, confirmed, and completed transfers.

## Specification gaps recorded for architect review

The architect has resolved the K4-state question: follow SCR-127 §1 poll scope and §2 query
behavior (lines 50–65). The indexer polls Closed pockets until observed balances remain zero for
the quiet period; `closedPocketsWithBalance()` returns Closed pockets with positive Gateway
available or withdrawing balances. The indexer does not receive or infer a K4 destruction signal.
The implementation follows that ruling.

Two items remain proposals, not approved decisions:

1. **Stale data versus the API-down slow path.** SCR-127 §3 line 82 denies slow withdrawal when
   API data is stale; §4's long-outage trigger requires an API outage lasting
   `payer.pullbackApiDownHours`, so the last successful balance is necessarily stale. The current
   code follows the fail-closed rule at `apps/signer/src/postgres-projection.ts:308-328` and
   `apps/signer/src/policy.ts:663-678`; consequently the long-outage slow-withdraw path is
   unavailable. Minimal choices: (a) keep stale denial and revise the fallback expectation, or
   (b) explicitly permit the slow path after the outage threshold using the last successful
   balance for the one-time initiation. Neither choice is approved here.
2. **Closed quiet-period persistence.** SCR-127 §1 lines 50–56 requires stopping Closed-pocket
   polling after a continuous zero period, but the §1 row at lines 31–44 does not define a
   persistence field for the period start. The current code uses an internal `closedZeroSince`
   column in `apps/indexer/ponder.schema.ts:216-234`, excluded from API responses. Minimal choice:
   approve this internal column or specify a separate persistence mechanism. No public response
   shape changes either way.

## Verification

- `fnm exec --using=22.22.0 pnpm --filter @czar/indexer typecheck` — passed.
- `fnm exec --using=22.22.0 pnpm --filter @czar/signer typecheck` — passed.
- `fnm exec --using=22.22.0 pnpm --filter @czar/signer test` — 111 passed, 1 skipped.
- `fnm exec --using=22.22.0 pnpm exec vitest run --exclude test/replay-anvil.test.ts` from
  `apps/indexer/` — 77 passed. The excluded local Arc replay is reported below.
- `fnm exec --using=22.22.0 pnpm exec vitest run test/gateway-balances.test.ts test/query-api.test.ts`
  from `apps/indexer/` — 38 passed.
- `fnm exec --using=22.22.0 pnpm exec vitest run test/postgres-projection.test.ts test/policy.test.ts
  test/service.test.ts` from `apps/signer/` — 71 passed.
- `fnm exec --using=22.22.0 pnpm exec vitest run test/postgres-projection.test.ts` from
  `apps/signer/` — 11 passed after adding the slow-withdraw eligibility cases.
- `fnm exec --using=22.22.0 pnpm lint` — passed.
- GitHub Actions runs `40205563664` (push) and `40205579662` (pull request), plus `40205563676` and `40205579698` (gitleaks), failed before jobs started because recent account payments failed or the spending limit needs to be increased; no hosted job result is available.
- `git diff --check` — passed.
- `fnm exec --using=22.22.0 prek run` — unavailable; this repository has no `prek.toml` or `.pre-commit-config.yaml`.
- A previous full indexer-suite invocation failed in the existing `replay-anvil.test.ts` while
  invoking `contracts/script/deploy.sh` against its local Arc Anvil. The test suppresses the
  subprocess stdout and stderr, so it provides no further error detail. Per the current instruction,
  no Arc replay or live Gateway acceptance was rerun.

## Deferred

- D94 running-Arc stand-in round trip.
- Architect resolution of the two unresolved proposals above.
- No commits were pushed to `build-v1`; no merge performed.
