# Lane 2 Bundle B task report

**Tasks:** T-052 pocket loop, T-053 pullback, T-054 job loop  
**Branch:** `codex/lane2-bundle-b`  
**PR:** [#52](https://github.com/zaryab2000/czar/pull/52), draft  
**Status:** implementation slices and fake-backed recovery tests are present; Bundle B acceptance is incomplete. Keep this PR in draft.

## Files changed

### Pocket loop (T-052)

- `apps/server/src/payer/pocket.ts`: plan-to-pocket lookup, pocket proof validation, register/gas/delegate/fund phases, Gateway call rendering and retries, status polling, halt drain hook, and close/sweep/key retirement.
- `apps/server/test/payer/pocket.test.ts`: funding cap, plan key linkage, pause drain, retirement, preparation recovery at register/gas/delegate/fund, four Gateway calls, status fixtures, and same-authorization retry.
- `apps/server/migrations/0008-pocket-jobs.sql`: `plan_pocket_keys`, linked from planner plan inserts with a trigger.

### Pullback (T-053)

- `apps/server/src/payer/pullback.ts`: value/window calculation, hand-built burn intent, K3 signing, mocked Gateway transfer call, mint/confirm recovery, cancellation delay, fresh request after cancellation, and slow withdrawal/manual-return flow.
- `apps/server/test/payer/pullback.test.ts`: fee-headroom cases, TransferSpec construction, contract delay parse, transfer-to-mint recovery, cancel/re-request, API-down slow path.

### Job loop (T-054)

- `apps/server/src/payer/job.ts`: job description/brief, open/budget/fund/sync/refund flow, alternate-provider proofs, signed provider brief and deliverable upload, upload limits and retention cleanup.
- `apps/server/test/payer/job.test.ts`: brief hashes/schema, alternate proofs, budget timeout/alternate provider, open/budget/fund/submit/sync recovery, upload limits and purge, refund decision gate.
- `apps/server/migrations/0008-pocket-jobs.sql`: `payer_job_briefs` and append-only `payer_job_deliverables`.

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

## PR #52 fix round (2026-10-23)

**Base:** branch reset to architect head `c9e9a5b`; migrations remain `0008-pocket-jobs.sql` and `0009-payer-pullback-api-failures.sql`.
**Status:** local unit suite, config suite, typecheck, and lint pass. PR remains draft because the production halt-drain default and several scheduled/recovery paths below are still incomplete. No Arc-Anvil Bundle B acceptance was run; D92 keeps those fork scenarios deferred.

### B1–B7 changes and tests

- **B1 — signer payloads:** `pocket.ts`, `pullback.ts`, and `job.ts` use named ABI argument records and decimal strings for uint arguments; cancelPullback includes `vault`. Added `signer-payload-contract.test.ts`, which sends representative vault-call and relayer-tx payloads through the real `parseRequest` and `coerceArgs` APIs and the vault ABI.
- **B2 — Gateway transfer:** `pullback.ts` posts the required one-element JSON array with decimal-string burn-intent fields, rejects malformed attestation/signature hex, and checks configured max fee against the vault's `maxPullbackFee`. The pullback test asserts the serialized request shape.
- **B3 — pullback retries:** trace reads are filtered by pullback id for transfer result, mint, and confirmation; cancellation delay is imported from `@czar/vault-client`; re-request uses a new pullback id after cancellation. A stored `pullback.request.sent` transaction is re-broadcast after interruption, but only if it was recorded after the latest cancellation. Tests cover stale #9 transfer/mint rows and request-transaction replay.
- **B4 — production adapters:** added `pocket-chain.ts`, `pullback-execution-chain.ts`, and `job-chain-adapter.ts`; wired pocket preparation, pullback, cancellation, job execution, and the slow fallback adapter into `main.ts`. Added unit tests for the pocket and pullback adapters. **Open:** `createServerMain` still requires injected `pocketHalt` when a vault event source exists. A safe production default cannot yet construct the full pullback input from persisted state: the accepted config has no GatewayMinter/domain values and the payer does not persist a complete halt-drain context. The requested no-injection startup test is therefore not claimed as passing.
- **B5 — job state handling:** keeps vault and escrow states separate; avoids sync immediately after funding; handles evaluator rejection for escrow Submitted/Completed while the vault is Opened; uses the recorded budget-wait time; decodes custom errors through `czarVaultAbi`; reuses stored open/fund/cancel/sync/refund transactions. Tests cover front-run rejection/sync and refund at expiry. **Open:** duplicate-job enumeration/release and the full crash-after-cancel, complete, reject, and alternate-provider recovery matrix are not fully covered.
- **B6 — routes and storage:** uses only singular `/v1/jobs/:jobKey/deliverable`; checks signature age and ERC-1271 through viem `verifyHash`; rate-limits after verification; normalizes job keys; maps rejected auth/job lookup to 404 and upstream failures to 503; preserves shared content-addressed blobs. Added a same-content 11th upload assertion. **Open:** `purgeUnmatchedJobDeliverables` still has no scheduler call because no accepted decision source supplies its matched hash and decision timestamp.
- **B7 — recovery fixes:** halt drain now continues through all pockets and retries only failed pockets once; gateway pullback failure rows clear after confirmation; slow-path transaction phases are recorded only after the adapter sees a successful receipt; pocket key addresses have a case-insensitive unique index; payer workers use per-execution ids. Tests cover halt retry, pullback request replay, and the zero-value write-off path. **Open:** startup scanning for already Frozen/Paused vaults, watching vaults created after startup, late-balance recovery for Closed pockets, and an app-visible `recordManualReturn` prompt are not implemented.

### Files changed in this fix round

- Payer/composition/routes: `apps/server/src/main.ts`, `apps/server/src/app.ts`, `apps/server/src/payer/job.ts`, `pocket.ts`, `pullback.ts`, `pullback-chain-adapter.ts`, plus new `job-chain-adapter.ts`, `pocket-chain.ts`, and `pullback-execution-chain.ts`.
- Migration/client ABI exports: `apps/server/migrations/0008-pocket-jobs.sql`, `packages/vault-client/src/index.ts`, plus new `packages/vault-client/src/constants.ts` and `external-abis.ts`.
- Tests: `apps/server/test/job-routes.test.ts`, payer job/pocket/pullback and pullback-chain-adapter tests, plus new `test/payer/pocket-chain.test.ts`, `pullback-execution-chain.test.ts`, and `signer-payload-contract.test.ts`.
- This report: `apps/server/T-052-T-054-task-report.md`.

### Verification output

- `fnm exec --using=22.22.0 pnpm --filter @czar/server test`
  ```text
  Test Files  42 passed (42)
       Tests  219 passed (219)
  Duration  16.14s
  ```
- `fnm exec --using=22.22.0 pnpm --filter @czar/config test`
  ```text
  Test Files  3 passed (3)
       Tests  27 passed (27)
  Duration  361ms
  ```
- `fnm exec --using=22.22.0 pnpm -r typecheck`
  ```text
  Scope: 14 of 15 workspace projects
  All package and application typecheck scripts completed successfully, including @czar/server and @czar/daemon.
  ```
- `fnm exec --using=22.22.0 pnpm lint`
  ```text
  > oxlint --deny-warnings && oxfmt --check
  All matched files use the correct format.
  Finished in 23ms on 385 files using 10 threads.
  ```
- `git diff --check` — passed.

### SCRs and remaining items

- SCR text only: pocket gas registry discrepancy (`signer.gas.pocket.minAtomic` / `maxAtomic` / `targetAtomic` are absent; implementation uses `payer.pocketGasUnits`).
- SCR text only: production halt-drain needs the GatewayMinter/domain and persisted pullback context required to build a complete pullback request. No docs were edited and no SCR file was created.
- Gateway `/v1/transfer` body follows the explicit array shape required by this fix round; no schema discrepancy is reported for that request.
- Arc-Anvil fork acceptance remains deferred under D92. Gateway behavior remains fixture-backed and G0-05 is pending; no testnet call or key use occurred.
- Keep PR #52 in draft until the B4 startup/default, B5 recovery matrix, B6 purge scheduler, and B7 startup/closed-pocket/manual-return gaps are resolved.

## Follow-up run (2026-10-22)

**Task IDs:** T-052, T-053, T-054 follow-up. Branch remains `codex/lane2-bundle-b`; PR #52 remains draft.

### Files changed in this follow-up

- HTTP and composition: `apps/server/src/app.ts`, `apps/server/src/main.ts`.
- Payer: `apps/server/src/payer/job.ts`, `apps/server/src/payer/pullback.ts`, new `pullback-scheduler.ts` and `runtime.ts`.
- Storage and migration: new `apps/server/src/object-store.ts`, `apps/server/migrations/0009-payer-pullback-api-failures.sql`.
- Tests: new `apps/server/test/job-routes.test.ts`, `object-store.test.ts`, `payer/pullback-scheduler.test.ts`, and `payer/runtime.test.ts`; updated `test/outage.test.ts`, `test/payer/pullback.test.ts`, `test/migrate.test.ts`, `test/main.test.ts`, and `test/evidence/receipt-arc.test.ts`.
- Config: `packages/config/src/registry.ts`, `packages/config/test/loader.test.ts`, and its Vitest snapshot.

### Verification

- `fnm exec --using=22.22.0 pnpm --filter @czar/server test`
  ```text
  Test Files  34 passed (34)
       Tests  176 passed (176)
  Duration  11.30s
  ```
- `fnm exec --using=22.22.0 pnpm -r typecheck`
  ```text
  Scope: 14 of 15 workspace projects
  All listed package and application typecheck scripts completed successfully.
  ```
- `fnm exec --using=22.22.0 pnpm lint`
  ```text
  > oxlint --deny-warnings && oxfmt --check
  All matched files use the correct format.
  Finished in 15ms on 321 files using 10 threads.
  ```
- `fnm exec --using=22.22.0 pnpm --filter @czar/config test`
  ```text
  Test Files  1 failed | 1 passed (2)
       Tests  1 failed | 23 passed (24)
  Existing failure: app.challengeTtlSeconds and app.bundlerEndpoints are absent from
  app/app-and-notifications.md coverage. This follow-up did not change those entries.
  ```
- `fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run test/outage.test.ts`
  ```text
  Test Files  1 passed (1)
       Tests  1 passed (1)
  ```
- `fnm exec --using=22.22.0 pnpm --filter @czar/config exec vitest run test/loader.test.ts -u`
  ```text
  Test Files  1 passed (1)
       Tests  21 passed (21)
  ```
- `git diff --check` passed. Test-generated `contracts/broadcast/` files were removed after the run.

### Follow-up behavior and remaining acceptance gaps

- The outage test now uses a valid 43-character Base64URL bearer token. Its local pool endpoint is port 1 so the test deterministically exercises the unavailable-Postgres path in this environment.
- Job brief and deliverable HTTP routes now verify the provider signature, enforce upload type and size, and validate responses. The filesystem object store implements `put`, `get`, and `delete`.
- The payer runtime now dispatches injected `Frozen`/`GuardianPaused` events to pocket draining and polls an injected pullback fallback scheduler. Gateway failures persist their first-failure time. Production composition still has no concrete vault event source or pullback chain adapter; the runtime hooks are not active unless those are provided.
- `payer.job.minExpiryLeadSeconds` is configured as 360 seconds and cites the six-minute contract minimum. Pullback cancellation delay remains the parsed contract constant of 3,000 blocks; it is not a configurable threshold in the contract/spec.
- **Arc-Anvil Bundle B acceptance is still not implemented.** No new `pocket-anvil.test.ts`, `pullback-anvil.test.ts`, or `job-anvil.test.ts` was added. The passing server suite includes the existing Arc-Anvil receipt/vault test, but that does not exercise the new pocket, pullback, or job loops against deployed contracts. Consequently none of the requested Bundle B Arc recovery matrices or end-to-end contract scenarios is claimed as passed.
- Routes retain the canonical singular `/v1/jobs/:jobKey/deliverable` and also accept the follow-up's plural `/deliverables`; the API contract currently describes the singular form.

### SCR candidates and open issues

- **SCR candidate — pocket gas config:** the prompt names `signer.gas.pocket.minAtomic`, `maxAtomic`, and `targetAtomic`, absent from the accepted registry. The implementation uses existing `payer.pocketGasUnits` per CZ-15.
- **SCR candidate — Gateway `/v1/transfer` body:** the exact request schema remains unspecified; current payload is `{ transferSpec, signature, contractSigner: true }`.
- **Storage adapter:** a filesystem-backed object store with deletion was added for job deliverables.
- Gateway API behavior remains fixture-backed; G0-05 is pending. Testnet execution remains deferred under T-050/D92.
- PR #52 remains draft because the required deployed-contract Arc-Anvil scenarios and concrete production event/fallback adapters remain open.
