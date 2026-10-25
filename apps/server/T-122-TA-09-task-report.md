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

- `fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run test/evidence/indexer-settlement.test.ts test/evidence/receipt-input.test.ts test/evidence/receipts.test.ts test/payer/vault-direct.test.ts test/payer/pocket.test.ts test/payer/dispatcher.test.ts test/objectives/completion.test.ts test/main.test.ts test/main-dispatch.test.ts test/planner/planner.test.ts` — **10 files passed, 60 tests passed**.
- `fnm exec --using=22.22.0 pnpm --filter @czar/hashing test` — **5 files passed, 43 tests passed**.
- `fnm exec --using=22.22.0 pnpm -r typecheck` — **passed for all 14 projects with typecheck scripts** (workspace scope: 14 of 15).
- `fnm exec --using=22.22.0 pnpm lint` — **passed**, oxlint had no warnings and oxfmt found all 430 files formatted.
- `git diff --check` — **passed**.
- GitHub Actions — **not run**: jobs were not started because GitHub reported an account billing/spending-limit issue; no hosted result is counted as passing.
- Regression-first evidence: dispatcher repeated-handoff test failed because the step ran twice, then passed after the persisted `handed_off` guard; local-profile test failed with the stale unavailable error, then passed using the merged profile producer; receipt-input tests cover JSONB key reordering and the checks-only commitment; settlement tests cover payee binding and distinguish the facilitator's transfer transaction from the vault's `Settled` transaction, with the USDC `Transfer` independently decoded from the payment transaction receipt. Review fixes reproduce the stale dispatch lease expiry and the receipt-indexer-lag completion bug; they now pass with per-acquisition clocks and retryable receipt recording that reuses the journaled StepResult.

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
3. **Lane 3 evaluator — completed job result and deliverable cleanup.** T-055 is
   still a Lane 3 task. The current tree has no durable evaluator decision producer
   for completed jobs. `job.ts` returns the on-chain `Completed` state, `main.ts`
   marks the step done, but only the vault-direct path persists `step.result`; the
   completion service therefore has no delivered result for a successful job-only
   objective and downstream steps cannot consume its fields. T-054's
   `purgeUnmatchedJobDeliverables` helper also has no authoritative matched
   `contentHash` and decision-time input. The T-055 producer must persist its
   AcceptanceReport/decision and matched upload identity/time; Lane 2 then needs an
   approved consumer mapping that result to a `StepResult` and persists it before
   the dispatcher marks the job step done. Do not add a parallel evaluator or infer
   a match from an upload. This is an unresolved P1 cross-lane handoff, not completed
   job-result integration.
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

## Deferred validation — D94

See [`reports/ta09-deferred-validation.md`](../../reports/ta09-deferred-validation.md).
No Arc Anvil acceptance, process-level paid-flow run, crash/restart matrix, live
Gateway, hosted model, testnet, funding, or deployment scenario was run in this
development phase. These are not reported as passing.
