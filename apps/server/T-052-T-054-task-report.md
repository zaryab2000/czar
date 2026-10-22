# Lane 2 Bundle B task report

**Tasks:** T-052 pocket loop, T-053 pullback, T-054 job loop  
**Branch:** `codex/lane2-bundle-b`  
**PR:** [#52](https://github.com/zaryab2000/czar/pull/52), draft  
**Status:** implementation slices and fake-backed recovery tests are present; Bundle B acceptance is incomplete. Keep this PR in draft.

## Files changed

### Pocket loop (T-052)

- `apps/server/src/payer/pocket.ts`: plan-to-pocket lookup, pocket proof validation, register/gas/delegate/fund phases, Gateway call rendering and retries, status polling, halt drain hook, and close/sweep/key retirement.
- `apps/server/test/payer/pocket.test.ts`: funding cap, plan key linkage, pause drain, retirement, preparation recovery at register/gas/delegate/fund, four Gateway calls, status fixtures, and same-authorization retry.
- `apps/server/migrations/0007-pocket-jobs.sql`: `plan_pocket_keys`, linked from planner plan inserts with a trigger.

### Pullback (T-053)

- `apps/server/src/payer/pullback.ts`: value/window calculation, hand-built burn intent, K3 signing, mocked Gateway transfer call, mint/confirm recovery, cancellation delay, fresh request after cancellation, and slow withdrawal/manual-return flow.
- `apps/server/test/payer/pullback.test.ts`: fee-headroom cases, TransferSpec construction, contract delay parse, transfer-to-mint recovery, cancel/re-request, API-down slow path.

### Job loop (T-054)

- `apps/server/src/payer/job.ts`: job description/brief, open/budget/fund/sync/refund flow, alternate-provider proofs, signed provider brief and deliverable upload, upload limits and retention cleanup.
- `apps/server/test/payer/job.test.ts`: brief hashes/schema, alternate proofs, budget timeout/alternate provider, open/budget/fund/submit/sync recovery, upload limits and purge, refund decision gate.
- `apps/server/migrations/0007-pocket-jobs.sql`: `payer_job_briefs` and append-only `payer_job_deliverables`.

### Shared files

- `packages/config/src/registry.ts` and `packages/config/test/__snapshots__/loader.test.ts.snap`: set `payer.jobBudgetWaitHours` to the required 2 hours.
- `apps/server/test/migrate.test.ts`: expects the three new tables.

## Verification

- `fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run test/payer/job.test.ts test/payer/pocket.test.ts test/payer/pullback.test.ts` — **3 files passed, 24 tests passed**.
- `fnm exec --using=22.22.0 pnpm --filter @czar/server typecheck` — **passed**.
- `fnm exec --using=22.22.0 pnpm --filter @czar/server test` — **29 files passed, 1 failed; 167 tests passed, 1 failed**. Existing `test/outage.test.ts > postgresUnavailable_returns503WithRateHeadersAndNoPartialWrite` expected HTTP 503 and received 401. No outage or auth code was changed in this task.
- `fnm exec --using=22.22.0 pnpm -r typecheck` — **all 14 workspace projects passed**.
- `fnm exec --using=22.22.0 pnpm lint` — **passed** (`oxlint --deny-warnings`, `oxfmt --check`).
- `fnm exec --using=22.22.0 pnpm --filter @czar/config test` — **23 tests passed, 1 failed**. Existing spec-coverage test reports missing `app.challengeTtlSeconds` and `app.bundlerEndpoints` in `app/app-and-notifications.md`; this bundle does not change those parameters.
- `git diff --check` — **passed**.

The existing server suite runs the repository's Arc-Anvil receipt acceptance test. That test passed, but it does not exercise the new pocket, pullback, or job code on Arc-Anvil.

## Recovery matrix exercised with injected chain fixtures

| Path | Simulated stop point | Resume evidence |
|---|---|---|
| Pocket | after register, gas grant, delegate, and fund | Each fixture updates chain state before throwing. Re-entry reads state and calls each action once. |
| Pocket | after authorization signing / during the merchant request | Retry reuses the same payment signature; signer is called once for the authorization. |
| Pullback | after `/v1/transfer` returns, before `gatewayMint` | Resume uses the stored attestation and transaction; it does not request a second transfer or sign another burn intent. |
| Pullback | cancel boundary | At `maxBlockHeight + 2999` cancellation is rejected; at `+3000` it proceeds. A cancelled request is followed by a new pullback record with a new id/salt. |
| Job | after open, budget wait, fund, submit, and sync | Resume reads the chain fixture state; open and fund are not repeated after their state is observed. |

These are fixture-backed recovery checks, not Arc-Anvil crash tests.

## SCR candidates and open issues

- **SCR candidate — pocket gas config:** the prompt refers to `signer.gas.pocket.minAtomic`, `maxAtomic`, and `targetAtomic`, but those keys are not in the accepted config registry. CZ-15 currently defines `payer.pocketGasUnits` (20,000), bounded by the contract's 50,000-unit cap; the implementation uses that existing key. No docs were edited and no SCR file was created.
- **SCR candidate — Gateway `/v1/transfer` request body:** the project spec names the endpoint and `contractSigner: true` but does not define the exact JSON request schema. The implementation sends the encoded TransferSpec, signature, and flag; this request shape still needs confirmation before relying on a live API.
- **Arc-Anvil acceptance remains outstanding:** no Bundle B-specific local Arc-Anvil integration currently proves pocket funding/nanopayments, vault acceptance of the GATEWAY_BURN signature and mint, or the job loop against the Circle mock. No testnet or live Gateway API call was made.
- **Event/scheduler wiring remains outstanding:** `drainPocketsAfterHalt` and `executeSlowPullbackFallback` are exported helpers, but no event watcher or scheduler invokes them from `Frozen`/`GuardianPaused` or after the configured API-down period.
- **HTTP composition remains outstanding:** `getJobBrief` and `uploadJobDeliverable` are exported module APIs; the application route composition is outside this bundle's owned files and is not wired here.
- **Storage adapter requirement:** job upload dependencies now require `objectStore.delete` so over-limit blobs can be removed and unmatched versions purged. The current server composition does not provide this interface for the new job path.
- Full `@czar/server` tests remain blocked by the 401/503 outage test failure listed above. Full `@czar/config` tests remain blocked by the two unrelated app parameter coverage findings.

**Review state:** draft; do not mark ready until the Arc-Anvil acceptance and integration gaps above are resolved and the server suite is green.
