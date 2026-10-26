# T-122 TA-09 — Dispatcher and completion

## Status

Lane 2 dispatcher, completion, receipt settlement lookup, and default receipt-input
composition are implemented in the started server path. The PR does not claim full
Lane 2 runtime completion: Gateway pocket closure/recovery, daemon acknowledgement,
and evaluator-driven cleanup still depend on missing cross-lane producers or routes.

The branch was synced by merging latest `origin/build-v1` (PR #85 included) without
rewriting commits. The current implementation is on `codex/t122-dispatcher-completion`.

## Implemented behavior

- `createServerMain` starts the executor-leased dispatcher after the planner and
  opening workers. It processes approved steps in dependency order, checks vault
  freeze and guardian-pause state before each step, resumes from execution records,
  and waits on `handed_off` local steps rather than handing them off repeatedly.
- Local and agent-assist planning uses Lane 3's merged `localTemplateProfile()`.
- The production x402 payer records request/response commitments and receipt metadata
  in durable execution phases without putting bodies in the trace. The default receipt
  builder joins those phases to the AcceptanceReport, checks settlement through the
  indexer's paginated `/receipts` API, and invokes the existing T-049 signer/storage
  path only after settlement is confirmed.
- The request/response commitment helpers use the Selection Layer `sl-req-v1` and
  response formulas. `localChecksCommit` is `keccak256(JCS(checks[]))`, distinct from
  the AcceptanceReport `reportHash`.
- Completion reads the envelope's open reservation/pocket/job counters, reuses a
  journaled `closeEnvelope` transaction, then atomically stores the result, updates
  the objective, and inserts the completion outbox event. Repeated completion does
  not duplicate the close or result.
- SCR-143 is implemented for Track A's job-route guard: when
  `routing.jobEnabled` is false, job steps persist a schema-valid
  `unsupported-offer` StepError and fail before reading the escrow or opening a job.
  Escrow `Completed` remains pending and emits `job-result-missing` until the
  later Lane 2 job-result builder exists.
- Paid x402 steps persist schema-validated `step.result` phases and set their state
  to `done` in one transaction. The dispatcher will not mark a paid step done
  unless its stored state is already done and all persisted results validate.
  Results are journaled as `step.result.prepared` while receipt storage is pending,
  allowing retries without exposing them to dependent steps prematurely.
- The local composition test starts `createLocalServerMain` with an executing plan
  and confirms the started dispatcher persists the unpaid step handoff.

## Files changed

- Runtime/composition: `apps/server/src/main.ts`,
  `apps/server/src/payer/dispatcher.ts`,
  `apps/server/src/objectives/completion.ts`.
- Payer trace and receipts: `apps/server/src/payer/executions.ts`,
  `apps/server/src/payer/vault-direct.ts`,
  `apps/server/src/evidence/receipts.ts`,
  `apps/server/src/evidence/indexer-settlement.ts`,
  `apps/server/src/evidence/receipt-input.ts`.
- Shared hash support: `packages/hashing/src/named.ts`.
- Focused tests: `apps/server/test/evidence/`,
  `apps/server/test/payer/dispatcher.test.ts`,
  `apps/server/test/payer/vault-direct.test.ts`,
  `apps/server/test/objectives/completion.test.ts`,
  `apps/server/test/main.test.ts`,
  `apps/server/test/main-dispatch.test.ts`,
  `apps/server/test/planner/planner.test.ts`,
  `packages/hashing/test/named.test.ts`.
- Status correction: `reports/m3-thin-slice.md`.

## Validation

- `fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run test/evidence/indexer-settlement.test.ts test/evidence/receipt-input.test.ts test/evidence/receipts.test.ts test/payer/vault-direct.test.ts test/payer/pocket.test.ts test/payer/dispatcher.test.ts test/objectives/completion.test.ts test/main.test.ts test/main-dispatch.test.ts test/planner/planner.test.ts` — **10 files passed, 61 tests passed**.
- `fnm exec --using=22.22.0 pnpm --filter @czar/hashing test` — **5 files passed, 43 tests passed**.
- `fnm exec --using=22.22.0 pnpm -r typecheck` — **passed for all 14 projects with typecheck scripts** (workspace scope: 14 of 15).
- `fnm exec --using=22.22.0 pnpm lint` — **passed**, oxlint had no warnings and oxfmt found all 430 files formatted.
- `git diff --check` — **passed**.
- GitHub Actions — **not run**: jobs were not started because GitHub reported an account billing/spending-limit issue; no hosted result is counted as passing.
- Regression-first evidence: dispatcher repeated-handoff test failed because the step ran twice, then passed after the persisted `handed_off` guard; local-profile test failed with the stale unavailable error, then passed using the merged profile producer; receipt-input tests cover JSONB key reordering and the checks-only commitment; settlement tests cover payee binding and distinguish the facilitator's transfer transaction from the vault's `Settled` transaction, with the USDC `Transfer` independently decoded from the payment transaction receipt. Review fixes reproduce the stale dispatch lease expiry and the receipt-indexer-lag completion bug; they now pass with per-acquisition clocks and retryable receipt recording that reuses the journaled StepResult. The identical-body receipt test failed when call 2 selected call 1's report, then passed after each call's report hash and observation id were recorded and matched by index.

## Cross-lane dependencies and decision proposals

1. **Lane 1 indexer — Gateway balances and late-pocket recovery.** CZ-15 §5.3 and
   §§5.5/5.6 require `pocketBalance(pocket)` with `gatewayAvailableAtomic`,
   `apiObservedAt`, freshness, and last-good observation semantics, plus discovery
   of closed pockets with balances. The current indexer API has ledger transfer facts
   but no `pocketBalance` or `closedPocketsWithBalance` producer. Recommended handoff:
   implement the already specified CZ-19 projection/query, including stale/missing
   state; Lane 2 can then compose pullback, close, and recovery without guessed values.
   Until then, Gateway steps may reach terminal transfer status, but envelope
   completion waits while the pocket remains open. Automatic pocket drain is not
   claimed complete.
2. **Lane 5 server / Lane 4 daemon — unpaid-step acknowledgement.** OpenAPI already
   defines `POST /v1/objectives/{objectiveId}/results/ack` (`ackResult`) and
   `ResultAck.assembly[]` in 02 §9.2. The server implementation has no matching route;
   the daemon caller is also not present in this runtime. Recommended handoff:
   Lane 5 implements the existing authenticated route and uses `markStepDone` only
   for matching `handed_off` steps; Lane 4 submits the specified assembly status.
   No new wire shape is needed. The dispatcher now leaves a handed-off step waiting.
3. **Lane 3 evaluator / future Lane 2 job-result builder.** SCR-143 was accepted
   and merged in PR #88. It assigns T-055 the durable acceptance decision and
   matched `deliverableHash`, and assigns Lane 2's later Track B job-result builder
   the work of loading matched bytes, applying §5.6, validating `StepResult`, and
   atomically persisting `step.result` with `done`. This PR follows the fail-closed
   behavior: completed jobs remain pending and alert `job-result-missing`, and
   `routing.jobEnabled` defaults false so dispatch rejects the path before opening
   a job. T-055 and the later result builder remain dependencies for enabling jobs.
   T-054 deliverable cleanup also remains blocked on T-055's durable decision time
   and matched-content identity; no separate evaluator store or guessed match was
   introduced.
4. **Receipt canonicalization decision.** The 02/SL schemas say
   `requirements_hash_seen` is the hash of the received 402 but do not bind whether
   the hash input is raw header/body bytes or the normalized parsed
   `PaymentRequired`. The current code hashes the parsed object with Czar's JCS `H`.
   The EIP-712 vectors show `delivered = 0`, while the remaining string-outcome to
   `uint8` values are not explicitly tabled; the current code follows the listed enum
   order. Recommended decision: bind the 402 hash input and numeric outcome table in
   a small SCR before treating every receipt value as interoperable evidence.
5. **Lane 1 signer/deployment — T-050 K10 payout.** The existing merchant route is
   implemented, but the current startup still lacks an approved public K10 address
   source. This is outside TA-09 and remains an explicit T-050 handoff; no key was
   read or exposed.

## Review round 1

At head `bc712e1`, the code review reported two receipt issues and the completed-job
result handoff above. Receipt recovery now compares canonical hashes, and settlement
checks match the authorization identity while verifying the facilitator transaction's
USDC `Transfer` separately from the vault settlement transaction. The completed-job
result issue remains open for the Lane 3 T-055 producer and an approved Lane 2
consumer contract.

## Review round 2

At head `f71bf5b`, the code review confirmed two additional issues: leases for
later work could be based on the dispatch batch's stale timestamp, and a null
receipt caused by indexer lag was treated as successful recording. Both fixes
are implemented with regression tests in the current local fix batch. The
security review for `f71bf5b` was still running when this report was updated;
the fix batch itself has not yet received hosted review. The T-055 completed-job
result finding remains unresolved for the Lane 3 producer and approved Lane 2
consumer mapping described above.

## Review round 3

At head `6c09f30`, review confirmed a P1 receipt-selection issue when different
calls share identical content-addressed response bytes. The current fix journals
each call's AcceptanceReport hash and observation id, then retrieves that exact
report on receipt recovery. The regression failed before the fix and passes after
it. The automated review cap is exhausted, so this newest fix batch has not received
hosted review. The round 3 security review was still running on `6c09f30` at report
update time. It has since completed with no security findings on `6c09f30`. The
automated review cap is exhausted, and `7f327b9` has no hosted code or security
review. SCR-143 resolves the job-route behavior for this PR: job dispatch is off
by default and Completed remains pending until the future result builder lands.
The latest guard/invariant fix batch has local validation only and needs the
designated reviewer to inspect the current PR head; no fourth bot run is available.

## Deferred validation — D94

See [`reports/ta09-deferred-validation.md`](../../reports/ta09-deferred-validation.md).
No successful Arc Anvil acceptance, process-level paid-flow run, crash/restart
matrix, live Gateway, hosted model, testnet, funding, or deployment scenario was
completed in this development phase. The full server suite attempted the receipt
Arc fixture, but deployment setup failed before acceptance assertions; it is not
reported as passing.

## Revalidation after PR #87 merge

Merged fresh `origin/build-v1` at `ca972d9` into this branch without rewriting
history. The revalidation started from merge head `be664a3` and includes the
subsequent test-fixture update.
The server suite exposed three fixtures that returned non-schema `StepResult`
objects after the new paid-completion validation. Updated those fixtures to return
valid results; the focused rerun passes.

- `fnm exec --using=22.22.0 pnpm --filter @czar/server test` — **exit 1**;
  56 files: 53 passed, 3 failed; 303 tests passed, 2 skipped, 2 failed. The
  remaining failures are environment/setup-bound and did not implicate the guard
  or x402 completion changes:
  - `test/app-reads.test.ts`: `/v1/me` got 503 because its configured RPC is
    `127.0.0.1:8549` and no RPC listener is running.
  - `test/job-routes.test.ts`: its child startup exits before route assertions;
    the fixture supplies an unreachable RPC (`127.0.0.1:1`) and omits required
    `CZAR_INDEXER_URL`.
  - `test/evidence/receipt-arc.test.ts`: Arc deployment setup failed in
    `script/deploy.sh` before the two acceptance tests (both skipped) could run.
    The test suppresses the nested deploy output, so the underlying deploy error
    was not available. This remains deferred Arc acceptance, not a passing check.
- `fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run
  test/main-dispatch.test.ts test/payer/vault-direct.test.ts
  test/payer/dispatcher.test.ts test/payer/acceptance.test.ts` — **4 files,
  19 tests passed**.
- `fnm exec --using=22.22.0 pnpm -r typecheck` — **passed**, all 14 projects
  with typecheck scripts.
- `fnm exec --using=22.22.0 pnpm lint` — **passed**, no warnings; formatting
  clean across 432 files.
- `git diff --check` — **passed**.

No fourth automated review was requested. Zaryab is manually reviewing the
changed head.

## SCR-143 guard follow-up

PR #88 merged into `build-v1` at `6c53c3f`. This branch merged the updated
`origin/build-v1` before implementing the accepted decisions. Focused regression
checks: `test/main-dispatch.test.ts`, `test/payer/vault-direct.test.ts`, and
`test/payer/dispatcher.test.ts` — **3 files, 16 tests passed**. Tests cover disabled
job dispatch without an escrow read, Completed remaining pending with an alert,
dispatcher refusal to mark paid work done without a valid result, and transaction
rollback when the result/state write fails. `pnpm -r typecheck` passed for all 14
projects with typecheck scripts; `pnpm lint` passed with no warnings and formatting
clean across 432 files. No fourth automated review was requested because the PR's
three-run review budget is exhausted. The follow-up is awaiting designated manual
review at the latest PR head; hosted reviews for that head are not complete.
