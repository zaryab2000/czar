# T-034 task report: indexer query API

## Status

Complete. Every CZ-19 §5.4 query T-034 owns is served, filtered and paged in SQL, and tested against a real Postgres (PGlite) and through the real Ponder API process on `arc-anvil`. `dependencyState` moved to T-033 under SCR-119. The builder started the task; Claude (architect) finished it on the same branch at Zaryab's request.

## Spec basis

- CZ-19 §5.4 (`server-acceptance-evidence-selection.md`), including the SCR-119 response contracts (PR #35) and the corrected `pullbacksToCancel` rule (`maxBlockHeight + PULLBACK_CANCEL_DELAY_BLOCKS`, PR #37, matching `cancelPullback`, RV-036).
- Pagination per 02 §9.5: opaque cursor, limit 1–200, default 50, cursors expire after `api.cursorTtlMinutes`.

## Changes

- **Projection layout** (`ponder.schema.ts`): queryable columns next to each jsonb mirror (`envelopes.envelopeRef`; `reservations.envelopeId/stepIndex/state/validBefore`; `pockets.pocket`; `jobs.jobEscrow/jobId/stepIndex/state/createdAt`), plus three tables:
  - `authorizations`: one row per reservation index with its derived nonce (`@czar/hashing`), set used by `AuthorizationUsed`, settled by `Settled`, released by `Released`.
  - `pullbacks`: one row per pullback, `attested` set by `AttestationUsed`.
  - `escrow_jobs`: latest ERC-8183 status per job in the `IJobEscrowAdapter.EscrowStatus` vocabulary. Kept apart from `jobs` because the escrow emits `JobCreated`/`JobFunded` before the vault's `JobOpened` in the same transaction.
- **Queries** (`src/api/store.ts`): every query uses `WHERE`/`ORDER BY`/`LIMIT` with keyset paging on the row id; receipts page each rail on `(createdAt, id)` and merge three bounded pages. `PULLBACK_CANCEL_DELAY_BLOCKS` is a code constant (a test parses `CzarConstants.sol`), not a config key.
  - `jobsToSync` follows `JobLogic.syncJob`: Opened with the escrow past Open; Funded with the escrow Submitted or final; Submitted with the escrow final.
  - `receiptsForLedger` returns SCR-119 settlement facts for `x402-exact`, `gateway-batched` and `erc8183-job`. A cancelled-before-funding job (vault `Released`) is `released`, not `refunded`, even though the escrow reports it Rejected.
- **Routes** (`src/api/router.ts`): `/envelopes/:envelopeRef`, `/reservations/needing-settle?vault=`, `/reservations/needing-finalize?now=`, `/pullbacks/to-confirm`, `/pullbacks/to-cancel?block=`, `/jobs/to-sync`, `/jobs/awaiting-evaluation`, `/receipts?vault=`, `/anchors/latest?publisher=&kind=`, `/anchors/by-batch/:root`. Mirrors are checked with `@czar/schemas`; `PocketRecord` is checked as a projection without `keyRef` (SCR-114).
- **Fixes to T-032 code found while building:**
  - ERC-8183 `BudgetSet`, `JobSubmitted`, `JobCompleted`, `JobRejected` and `JobExpired` name no Czar address, so the address filter dropped them; they are now followed by job id once `JobCreated` named a Czar vault. Without this, `jobsAwaitingEvaluation` could never return a job.
  - The USDC handlers loaded every vault and pocket for every transfer on the chain; membership now uses indexed lookups.
- `@czar/hashing` moved from dev to runtime dependency (handlers use `derivedNonce`); `@electric-sql/pglite` 0.2.13 (already in the lockfile through Ponder) added as a dev dependency for the SQL tests.

## Tests

| Command | Result |
|---|---|
| `pnpm --filter @czar/indexer exec vitest run test/query-api.test.ts` | Pass: 11 tests (SQL paging across pages, needs-settle per vault, pullback confirm/cancel boundary, sync and evaluation selection, receipts on three rails with equal-timestamp paging, anchors, contract constant, HTTP routes, cursor binding, bad input) |
| `PATH=<arc-foundry v0.8.0-2>:$PATH pnpm --filter @czar/indexer exec vitest run test/replay-anvil.test.ts` | Pass: deploy on `arc-anvil` (arc-forge 1.7.1-dev), Ponder indexes the replay, every query called over HTTP through the real API process |
| `pnpm --filter @czar/indexer test` | Pass: full indexer suite |
| `pnpm --filter @czar/config test` | Pass: 24 tests |
| `pnpm lint`, `pnpm -r typecheck` | Pass |

Two deliberate breaks (cancel boundary `<=` → `<`; needs-settle including `Final`) each made exactly one test fail.

## SCRs

- None filed. SCR-119 (accepted, PR #35) and the pullback rule fix (PR #37) were applied before this work.

## Open issues

- `gateway-batched` receipts carry `stepIndex: null`: a pocket serves the whole envelope, and the server maps a transfer to its step.
- The replay deploy writes `contracts/broadcast/Deploy.s.sol/5042002/` (pre-existing behaviour); `.gitignore` ignores only chain 31337. Not committed.
- Local only (D92): no testnet, no live Gateway calls, no GitHub CI.
