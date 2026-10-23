# Lane 2 — Server payments: Bundle B builder prompt

> **Tasks:** T-052, T-053, T-054 (one branch, one PR, one review)
> **Not in this bundle:** T-050 (live testnet slice, deferred per D92), T-059 (multi-path testnet run, later).
> **Dependency relaxation (architect ruling, 2026-10-22):** T-052 and T-054 formally depend on T-050. Since D92 defers all testnet work to T-121, these tasks build and test on `arc-anvil` only, using the Bundle A payer and the T-037 signer already in `build-v1`. T-053 formally depends on G0-05 (a testnet pullback experiment). Since G0-05 has not been run yet, mock the Gateway API responses in test fixtures; the real testnet run will happen when G0-05 is approved.

---

## Preamble

You are a Czar builder on LANE 2 (Server payments). Other builders work in parallel on other lanes.

- Work only in your worktree: `../czar-2`. Branch: `codex/lane2-bundle-b` from the latest `origin/build-v1`.
- You own: `apps/server/src/payer/pocket.ts`, `apps/server/src/payer/pullback.ts`, `apps/server/src/payer/job.ts`, and their tests. You also own new migration files under `apps/server/migrations/`.
- Do not touch `apps/server/src/payer/vault-direct.ts`, `apps/server/src/payer/executions.ts`, `apps/server/src/acceptance/`, `apps/server/src/evidence/`, or `apps/signer/`. Import their exported APIs.
- Edit shared packages (`schemas`, `hashing`, `config`, `vault-client`, `x402`) only where a task requires it, each change in its own small commit.
- Config registry: append keys only. Migrations: rebase on `origin/build-v1` before opening the PR and take the next free number (`0003` is taken by the acceptance tables, so start at `0004`).
- Your local `arc-anvil` port is **8546**. Postgres: `127.0.0.1:15432` (tests create their own database).
- **Tests first for all three parts.** Every one of these tasks moves USDC or signs. Write the failing tests before the code.
- No hosted model calls. No testnet, no funds, no accounts, no real keys. Never read, print or commit key material.
- Never edit `docs/specs`, `docs/product`, `docs/architecture`. Spec gap → stop that item, describe it as an SCR **in your task report only** (do not create files under `docs/`), continue with the rest.
- Finish = every acceptance test below passes locally + one PR into `build-v1` + task report. Do not merge. Do not start another task.

---

## Preconditions (check before starting)

| Must be in `origin/build-v1` | If missing |
|---|---|
| T-037 signer with pocket keys (merged, PR #47) | Stop and report. |
| T-045 planner core (merged, PR #41) | Stop and report. |
| T-048/T-049 Bundle A — vault-direct payer, executions, receipts (merged, PR #48) | Stop and report. |
| T-018 job adapter contract (`contracts/src/libraries/JobEscrowAdapter.sol`, `contracts/src/vault/logic/JobLogic.sol`) | Stop and report. |
| T-035 signer (merged) | Stop and report. |
| SCR-126 accepted (pocket key link table, signer process, promptHash) | — |

**T-050 is not a prerequisite for this bundle (architect ruling, 2026-10-22, D92).** Build and test everything on `arc-anvil` with the T-035 signer client and the Bundle A payer already in `build-v1`.

---

## Spec files to read before writing code

1. `docs/specs/05-build-plan/phase-1-tasks.md`: T-052 (line 813), T-053 (line 828), T-054 (line 844), including every review-fix, D-number and SCR note under each.
2. `docs/specs/04-components/server/server-planning-and-payment.md`: CZ-15 in full:
   - §5.3 steps 1–8 (pocket loop: register, gas, delegate, fund, nanopayments, pullback)
   - §5.4 (job loop: open, wait for budget, fund, sync, refund)
   - §5.1 state machine and phase table (the executor model from Bundle A applies here too)
   - §10 failures, §12 wording
3. `docs/specs/03-smart-contracts/czar-vault.md`:
   - §5.4 (pockets: `registerPocket`, `addDelegate`, `fundPocket`, `PocketClosed`, the zero-balance retire rule)
   - §5.5 (jobs: `openJob`, `fundJob`, `syncJob`, `claimJobRefund`)
   - §6.2 (`isValidSignature` and the `GATEWAY_BURN` envelope layout)
4. `docs/specs/03-smart-contracts/job-escrow-adapter.md`: §3–§6 (the adapter ABI and mock).
5. `docs/specs/02-data-and-protocol/data-and-protocol.md`:
   - §6.3.2 `GATEWAY_BURN` envelope
   - §4.21 `JobBrief`, §4.22 `DeliverableUpload`
   - §7.2 nonces, §7.4 payment ids
   - §11.2 x402 buyer steps
6. `docs/specs/04-components/shared/cross-cutting.md`: §2.1 `safeFetch`, §3.1 mock Facilitator/Gateway, §4 logging allowlist.
7. `docs/specs/06-review/change-requests/SCR-126-signer-process-pocket-key-link-prompt-hash.md`: §3 (the `plan_pocket_keys` table and how it is written and read).

---

## Part 1 — T-052: Pocket loop

**Tests first.** This code funds pockets and signs nanopayments.

### Build

- **Migration.** Add `plan_pocket_keys (plan_id PK, pocket_address, created_at)` (SCR-126 §3) if T-045's plan store has not already created it. Check first.
- **`apps/server/src/payer/pocket.ts`.** Implement CZ-15 §5.3 steps 1–6:
  - **Register.** `registerPocket` with the pocket-leaf proof (D71). The pocket address comes from the `plan_pocket_keys` table (SCR-126 §3).
  - **Gas.** Send native gas to the pocket from the relayer. Keep within `signer.gas.pocket.minAtomic` / `maxAtomic` / `targetAtomic`.
  - **Delegate.** `addDelegate(USDC, gateway)` from the pocket key.
  - **Fund.** `fundPocket(envelopeId, pocketAddress, amount)`. Amount bounded by `stepCap` and `expectedCalls`.
  - **Nanopayments.** Send calls through the Gateway with `callInputs[i].input` and `{{dep.N.field}}` resolved per `subjectIndex`. A missing dependency value skips that call, records `dependency-missing` and releases the index (D84).
  - **Status.** Track `pending` → `completed` from Gateway fixtures.
- **Freeze handling (D72).** On `Frozen` or `GuardianPaused`, pull back every funded pocket immediately.
- **Close (RV-004).** Close with the gas sweep. A `PocketClosed` event alone does not retire the key; the zero-balance rule from CZ-27 §5.3 governs retirement.
- **Executor model.** Use the same `step_executions` and `executor_leases` from Bundle A's `executions.ts`. One executor per envelope, TTL `payer.leaseSeconds`. Every phase written before its external call and after its result.
- **Config.** Every `payer.pocket.*` key in `@czar/config` with its CZ-15 default and reason.

### Acceptance

- Fork integration on `arc-anvil`: register → gas → `addDelegate` → fund → four nanopayments to a local Gateway seller (mock); ledger shows `pending` then `completed` from a recorded Gateway fixture.
- Kill-and-resume after `pocket.registered`, gas sent, `fundPocket` sent, and a nanopayment sent: no double funding, no double charge.
- A `Frozen` event triggers pullback of every funded pocket (D72).
- Close with gas sweep succeeds; a key at zero balance is retired; a later sign request fails.

---

## Part 2 — T-053: Pullback

**Tests first.** This code builds burn intents and signs `GATEWAY_BURN` envelopes.

### Build

- **`apps/server/src/payer/pullback.ts`.** Implement CZ-15 §5.3 steps 7–8:
  - **Burn intent.** Build the intent by hand. Never use `GatewayClient.withdraw()`.
  - **`GATEWAY_BURN` envelope.** Sign with the pocket key via the signer. The vault's `isValidSignature` must accept it.
  - **`/v1/transfer`.** POST to the mocked Gateway API with `contractSigner: true`.
  - **Attestation.** Receive the (mocked) attestation.
  - **`gatewayMint`.** The KMS relayer calls `GatewayMinter.gatewayMint(attestation, signature)`. On `arc-anvil`, mock this call.
  - **`confirmPullback`.** Update state after mint.
- **Cancel and re-request.** `cancelPullback` after `PULLBACK_CANCEL_DELAY_BLOCKS`. A new request with a new salt succeeds.
- **API-down fallback.** When the Gateway API is unreachable, fall back to the slow path: `pocket-return` transfer and an app prompt for `recordManualReturn`.
- **Value formula (RV-012).** `value = min(outstanding − pending, availableBalance − maxFee − safety)`.
- **Window (RV-036).** `maxBlockHeight = head + payer.pullbackWindowBlocks`.
- **Recovery pullbacks (RV-004).** For `Closed` pockets, recover any late-arriving balance.
- **Full-balance drain.** `pullback_fullBalanceDrain_valuePlusFeeFitsBalance` (RV-012).

### Acceptance

- Fork test with mocked Gateway API on `arc-anvil`: `requestPullback` → signed envelope accepted by the vault's `isValidSignature` → mocked attestation → mocked `gatewayMint` → `confirmPullback`.
- Expired attestation path: `cancelPullback` after `PULLBACK_CANCEL_DELAY_BLOCKS`, new request with a new salt succeeds.
- Kill-and-resume between `/v1/transfer` and `gatewayMint`.
- `pullback_fullBalanceDrain_valuePlusFeeFitsBalance`: a drain of `availableBalance − maxFee` leaves the pocket at `≤ maxFee − fee`.
- `payer_pocketClose_sweepsGasAndRecoversLateBalance`: a closed pocket's gas is swept and any late USDC balance is recovered.
- Slow path: when the Gateway API is down, `pocket-return` transfer to the owning vault succeeds.

---

## Part 3 — T-054: Job loop

**Tests first.** This code opens jobs, funds them and claims refunds.

### Build

- **`apps/server/src/payer/job.ts`.** Implement CZ-15 §5.4 against the `JobEscrowAdapter` (already in `contracts/src/libraries/JobEscrowAdapter.sol`):
  - **Open.** `openJob` with `description = "czar:" + 64 hex` and `descriptionHash` from `inputCommit` (RV-025). The duration comes from `payer.jobDurationHoursByCapability` or the 24h default (D87).
  - **Wait for budget.** Poll `getJob` for `setBudget`. Timeout at 2h → `cancelJob` then alternate provider (job-path review).
  - **Fund.** `fundJob(jobKey, expectedBudget)` (M1-b). Gated by freeze, pause, envelope state and expiry (RV-006).
  - **Sync.** `syncJob` from the adapter. Duplicate jobs released by `syncJob` (RV-009). Unfunded `Submitted`/`Completed` jobs released (H1).
  - **Refund.** `claimJobRefund` of `budget − settledAmount`. Never while a decision is pending (D87). Refunds credit the envelope (bounded, RV-011) or free balance.
  - **Cancel.** `cancelJob` then alternate provider. `JobNotCancellable` → `syncJob` releases (job-path review).
  - **Front-run fallback (N7).** Handle a provider front-running `setBudget`.
- **`JobBrief`.** Build and serve at `getJobBrief` with `BriefRequest` auth. Fields: `taskSpec`, `targetBudget`, `submitBy`, `decisionCutoff`, `terms` (D86, D87). `JobBrief.inputs` come from the step's `callInputs` (D84).
- **`uploadJobDeliverable`.** Append-only by `contentHash`, with limits and purge (D87).
- **Config.** Every `payer.job.*` key in `@czar/config` with its CZ-15 default and reason.

### Acceptance

- Fork test on `arc-anvil` with Circle mock: open → provider `setBudget` → fund → submit → (evaluator fixture) complete → `syncJob`; and reject and expiry paths with `claimJobRefund`.
- Kill-and-resume at each step (open, budget wait, fund, submit, sync) re-reads `getJob` and ends in the right state.
- Budget wait timeout → cancel → alternate provider opens.
- `JobNotCancellable` → `syncJob` releases.
- `fundJob` while frozen or paused reverts (RV-006).
- `descriptionHash` matches `inputCommit` (RV-025).
- A provider front-running `setBudget` in the same block is handled (N7).
- Duplicate jobs released by `syncJob` (RV-009).
- `claimJobRefund` never fires while a decision is pending (D87).
- The `JobBrief` validates against the schema and `inputs` come from `callInputs` (D84).

---

## Code rules (binding, from CLAUDE.md)

- Use named parameters only, with no magic numbers. Amounts are `Amount6` strings in APIs and `uint256` on-chain, never floats.
- Shapes come only from `@czar/schemas`, hashes from `@czar/hashing`, and vault calls through `@czar/vault-client`.
- Use absolute imports (`#src/*`, `#test/*`) and pinned versions.
- Logging follows cross-cutting §4. Never log merchant bodies, objective text or full URLs.
- Merchant text is data. It reaches models only through P-01/P-02, JSON-encoded and labelled.
- Keys live behind the signer service. Use `createSignerClient` from `@czar/signer`. Never pass key material on a command line or in an environment variable (D70, D78).
- The signer signs pocket keys (K4) with allowed kinds only: `gateway-nano`, `pocket-delegate`, `pocket-return`, `pocket-slow-withdraw`. Any other USDC call is refused.

## Final checks (all must pass)

```bash
pnpm --filter @czar/server test
pnpm -r typecheck
pnpm lint
```

## Task report (one report covering all three tasks)

1. Task IDs: T-052, T-053, T-054, plus any precondition that blocked a part.
2. Files changed, grouped by part.
3. Every command above with its pasted result, plus the kill-and-resume matrix output for each part.
4. SCRs needed (text only, in the report).
5. Open issues, including: Gateway API mock vs real (G0-05 pending), testnet run deferred (T-050/D92).

## PR

- **Title:** `feat(server): Lane 2 Bundle B — pocket loop, pullback, job loop (T-052, T-053, T-054)`
- **Base:** `build-v1` · **Branch:** `codex/lane2-bundle-b`
