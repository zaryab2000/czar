# TA-08 task report — composition root, planner loop, opening watcher

## Implemented

- `start:local` now starts `createServerMain` through the local composition helper. The
  entry reads only the six SCR-132 launcher pointers, loads `deployments/arc-local.json`,
  verifies the local Arc chain ID, and composes the signer client, RPC clients, safe fetch,
  object store, acceptance checker, boundary, registered selection, opening watcher, and
  HTTP server. It starts the planner loop only when the Gateway-volume provider is
  configured. Shutdown stops started runtime loops and closes the HTTP server and pool.
- When configured, the planner loop reclaims stale `planning` rows to `received` without
  inserting another outbox event, then processes one pending `objective.received` event per
  poll.
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

## Open dependency

CZ-14 §4 (server-planning-and-payment.md:234) requires `V`, the objective's total
Gateway-eligible volume. CZ-14 §5.3–§5.4 (lines 243–254) uses `V` in `pocketWorthIt`
before choosing between Gateway, batched exact, or skipping a step; D48 measures `V` per
objective (line 492). T-045 already exposes this as
`PlannerOperationsDependencies.gatewayVolumeAtomic(objectiveId)` (`planner/service.ts:20–25`),
loads it in `build()` (`:327–354`), and passes it to `route()` through the planner input
(`planner/index.ts:531–537`).

No merged producer or approved calculation supplies prospective `V`. The indexer's
`gateway_transfers` projection contains already-observed transfers; it cannot establish
the eligible volume of a not-yet-planned objective. Deriving `V` from candidate prices,
call counts, eligible offers, or a plan after routing would be an unapproved calculation
and could be circular because routing determines which steps use Gateway.

The local composition no longer substitutes `0n`. When the `V` provider is absent, it
starts the HTTP server and opening watcher, logs `planner_volume_source_missing`, and
does not start the objective planner loop. Gateway composition and objective planning
are therefore **partial and disabled** in that runtime until the decision below is made.

**Decision requested from the architect:** either (a) approve an interim exact-only policy
when prospective `V` is unavailable, explicitly requiring `cVd(n) <= unitAmount` and
skipping otherwise, or (b) define the authoritative pre-routing `V` calculation and its
source/owner, including which selected candidates, eligible offers, and expected calls
count. The smallest useful ruling is approval of option (a); it preserves safe exact
planning without treating unknown volume as measured zero. No option is implemented as
approved behavior here.

TA-09 owns the dispatcher, receipt settlement/trace ports, and completion. These are not
implemented or claimed by this report. The process-level local Arc run is deferred under
SCR-136/D94.

## Validation

- `docker compose -f apps/server/test/compose.yaml up -d` — test Postgres started.
- `fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run test/main.test.ts test/local-main.test.ts test/planner/planner.test.ts test/planner/service.test.ts test/planner/loop.test.ts test/objectives/opening-watcher.test.ts test/boundary.test.ts` — 7 files passed, 40 tests passed after the missing-volume and watcher-start regressions were added. The watcher test failed before the sentinel fix because the indexer lookup was never called; after the fix it verifies the lookup and that `stop()` waits for the opening match to commit.
- `fnm exec --using=22.22.0 pnpm --filter @czar/server typecheck` — passed.
- `fnm exec --using=22.22.0 pnpm lint` — passed; oxlint reported no warnings and oxfmt found all 417 files formatted.
- `git diff --check` — passed.
- `fnm exec --using=22.22.0 pnpm --filter @czar/server test` — **failed**: 45 files passed; 4 files failed; 265 tests passed and 2 were skipped. Failures: `test/app-reads.test.ts` needs a responding Arc RPC at `127.0.0.1:8549`; `test/job-routes.test.ts` starts the local entry, which refuses startup without pinned `arc-anvil` (`anvil_nodeInfo`); `test/migrate.test.ts` expects 29 tables while the current base creates 30, including `merchant_payment_identifiers`; `test/evidence/receipt-arc.test.ts` fails in its deployment setup (`script/deploy.sh`). These are recorded as current-suite failures, not passes.
- Local Arc process-level startup / T-050a, crash/restart matrix, testnet, live model calls, and deployment — **NOT RUN / DEFERRED** under TA-08 scope and D94. The package-suite attempts above did not constitute Arc acceptance evidence.

## Coordination

Reviewed the TA-09 receipt-producer commit `286d7e8f1926b255886e950d182db1c63895c6b4`
on PR #75. The scoped producer sends the full `PaymentRef`; its regression asserts the
payload and exercises the real signer parser. No defect was found in that commit, and a
confirmation was posted on PR #75.
