# TA-08 task report — composition root, planner loop, opening watcher

## Implemented

- `start:local` now starts `createServerMain` through the local composition helper. The
  entry reads only the six SCR-132 launcher pointers, loads `deployments/arc-local.json`,
  verifies the local Arc chain ID, and composes the signer client, RPC clients, safe fetch,
  object store, acceptance checker, boundary, registered selection, opening watcher, and
  HTTP server. The planner loop reclaims stale `planning` rows to `received` without
  inserting another outbox event, then processes one pending `objective.received` event per
  poll. Shutdown stops started runtime loops and closes the HTTP server and pool.
- The opening watcher polls `opening` objectives and approved plans waiting in
  `awaiting-approval`; it matches only an `Open` envelope for the user's vault and plan
  hash, leaves timed-out plans approved for late matching, and expires both records at
  the plan expiry. Its initial poll now runs, and shutdown awaits an in-flight match.
- Model clients are optional. With no model, P-01 reports `screen-unavailable` and the
  boundary quarantines the result without delivering it.
- Registered GET query and POST JSON `probeInput` is sent only to the unpaid safe probe.
  Paid calls continue to use `Step.callInputs`.
- Planner ports use the registered selection source, signer pocket-key creation, the
  required false agent-host answer, and the contract allowance rule. A failed allowance
  read returns zero.

## SCR-141 implementation

SCR-141 §3 is accepted and merged in build-v1. The planner no longer accepts an external
`gatewayVolumeAtomic(objectiveId)` value. It first probes and prices selected candidates,
then computes `V` as the sum of `expectedCalls * GatewayWalletBatched amount` for each
selected paid, non-job step whose live 402 includes a usable Gateway offer. Job-path,
unpaid, and unprobed fallback candidates are excluded. The router receives this computed
value for each step.

`routing.gatewayEnabled` is read from `@czar/config` and defaults to `false`. With it off,
the router does not treat Gateway offers as usable; a Gateway-only offer is skipped as
`unsupported-offer`. With it enabled, the existing CZ-14 routing table is available and
uses the computed `V`. Enabling Gateway in production remains gated on the SCR-141
prerequisites: TA-20/T-124 and TA-21/T-053 pocket safety implementation and review.

TA-09 owns the dispatcher, receipt settlement/trace ports, and completion. These are not
implemented or claimed by this report. The process-level local Arc run is deferred under
SCR-136/D94.

## Validation

- `docker compose -f apps/server/test/compose.yaml up -d` — test Postgres started.
- `fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run test/main.test.ts test/local-main.test.ts test/planner/planner.test.ts test/planner/service.test.ts test/planner/loop.test.ts test/objectives/opening-watcher.test.ts test/boundary.test.ts` — 7 files passed, 40 tests passed after the missing-volume and watcher-start regressions were added. The watcher test failed before the sentinel fix because the indexer lookup was never called; after the fix it verifies the lookup and that `stop()` waits for the opening match to commit.
- `fnm exec --using=22.22.0 pnpm --filter @czar/server typecheck` — passed.
- `fnm exec --using=22.22.0 pnpm lint` — passed; oxlint reported no warnings and oxfmt found all 417 files formatted.
- `git diff --check` — passed.
- `fnm exec --using=22.22.0 pnpm --filter @czar/server test` — **failed at the time of that run**: 45 files passed; 4 files failed; 265 tests passed and 2 were skipped. Failures: `test/app-reads.test.ts` needs a responding Arc RPC at `127.0.0.1:8549`; `test/job-routes.test.ts` starts the local entry, which refuses startup without pinned `arc-anvil` (`anvil_nodeInfo`); `test/migrate.test.ts` had a stale 29-table expectation; `test/evidence/receipt-arc.test.ts` fails in its deployment setup (`script/deploy.sh`). The migration test mismatch has since been fixed and passed in isolation; the full suite has not been rerun.
- SCR-141 focused follow-up — `fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run test/router.test.ts test/planner/planner.test.ts test/planner/service.test.ts test/main.test.ts`: 4 files passed, 55 tests passed. Coverage includes numeric `V` summation and job/unpaid exclusion, summing across four paid steps, Gateway-only `unsupported-offer/no-usable-offer` while disabled, and enabled routing by config.
- Focused regressions were red before fixes: `V` produced exact routing instead of the expected Gateway route, and disabled Gateway returned `fee-exceeds-payment` instead of `no-usable-offer`. Both pass with the implemented behavior.
- `fnm exec --using=22.22.0 pnpm --filter @czar/config test` — 5 files passed, 46 tests passed.
- PR #80 baseline migration-test follow-up: added the merged `merchant_payment_identifiers` table to `apps/server/test/migrate.test.ts`'s expected table list. The test was reproduced failing with 30 actual vs. 29 expected tables, then passed: `fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run test/migrate.test.ts` — 1 file, 3 tests passed.
- `fnm exec --using=22.22.0 pnpm --filter @czar/server typecheck` — passed after the migration-test follow-up.
- `fnm exec --using=22.22.0 pnpm lint` — passed after the migration-test follow-up; no warnings, 417 files formatted.
- `fnm exec --using=22.22.0 pnpm --filter @czar/server typecheck` — passed after the SCR-141 follow-up.
- `fnm exec --using=22.22.0 pnpm lint` — passed; oxlint reported no warnings and oxfmt found all 417 files formatted.
- `git diff --check` — passed after the SCR-141 follow-up.
- Local Arc process-level startup / T-050a, crash/restart matrix, testnet, live model calls, and deployment — **NOT RUN / DEFERRED** under TA-08 scope and D94. The package-suite attempts above did not constitute Arc acceptance evidence.

## Coordination

Reviewed the TA-09 receipt-producer commit `286d7e8f1926b255886e950d182db1c63895c6b4`
on PR #75. The scoped producer sends the full `PaymentRef`; its regression asserts the
payload and exercises the real signer parser. No defect was found in that commit, and a
confirmation was posted on PR #75.

## PR #80 follow-up

- Added the merged `merchant_payment_identifiers` table to the migration test's expected
  public tables. The baseline test reproduced the 30-versus-29 mismatch before the fix.
- Production planner profile wiring now maps `data-json.search` and `data-json.extract` to
  the seeded `data-json` acceptance profile. Pocket-key creation now uses signer caller
  `cz-15`, which owns K4 under the existing signer policy.
- **Open cross-lane dependency:** local steps require the `local-template-v1` profile ID
  (02 §4.6 and D82), but no local-profile identity producer exists in the current server,
  daemon, or package code. A `table-build` planner test now confirms that planning fails
  with the named `LocalTemplateProfileUnavailableError`; no placeholder ID is generated.
  Lane 3 will add `localTemplateProfile()` in `acceptance/profile.ts`; Lane 2 must wire it
  after that PR merges.
- Regression evidence: adapter and planner tests were red before the helpers/named error
  were implemented. `test/planner/planner.test.ts` and `test/main.test.ts` passed together
  (2 files, 23 tests), including the paid web-search profile mapping; migration test passed
  (1 file, 3 tests).
- `fnm exec --using=22.22.0 pnpm --filter @czar/server typecheck` and
  `fnm exec --using=22.22.0 pnpm lint` passed after the follow-up changes. Full server suite
  was not rerun; Arc-backed failures remain as listed above.
- PR #80 bot run 2 reviewed `754d7c4`. No third bot review was requested. A manual final
  review is needed for the new head; the local-profile dependency remains unresolved.
