# Lane 2 Bundle A task report

## Status

- T-046 injection boundary: implemented and verified locally.
- T-048 vault-direct payer: executor, journal, lease and chain adapter are implemented;
  scripted recovery tests inject failures after `reserve.sent`, `reserve.mined`,
  `call.sent`, `call.result` and the finalize submission, and exercise
  `settlement_pending` polling. They assert that the authorization is signed once and
  the exact persisted payment header is reused. The full process-kill matrix and the
  server payer loop against the deployed vault on Arc Anvil remain unverified.
- T-049 receipts and evidence store: receipt builder, K3 signing and persistence are
  implemented. The stored-row replay avoids duplicate signatures. The app-generated
  receipt has not yet been checked against a deployed vault's `isValidSignature`.
- T-035 `@czar/signer` is used for K3 calls and receipt signing. T-036 was not used.
- Base: `origin/build-v1` at `d0e7d966950080e37f4d84419cdf1baea3eb1a12` (T-047).
- T-048/T-049 are submitted as a draft PR because the remaining acceptance gaps below
  prevent marking the bundle ready for review.

## Files changed

### Part 1 — T-046

- `apps/server/src/boundary/index.ts`, `apps/server/src/models/proxy.ts`,
  `apps/server/migrations/0004-boundary-model-budget.sql`.
- `apps/server/scripts/eval.mjs`, `apps/server/package.json`,
  `models/P-01.md`, `models/P-02.md`, `models/evals/P-01/cases.json`,
  `models/evals/P-02/cases.json`.
- `apps/server/test/boundary.test.ts`, `apps/server/test/model-proxy.test.ts`.

### Part 2 — T-048

- `apps/server/src/payer/executions.ts`: durable execution phases, per-envelope
  leases and unpaid-step handoff acknowledgement.
- `apps/server/src/payer/vault-direct.ts`: 402 re-probe, payee/price checks,
  T-035 K3 signing, persisted authorization payloads, retry/reconciliation,
  settled-mask check, delayed finalization and required boundary/receipt hooks.
- `apps/server/src/payer/viem-chain.ts`: viem adapter for reserve, authorization,
  settle, settled-mask and finalize reads/writes.
- `apps/server/migrations/0005-payer-executions.sql`.
- `apps/server/test/payer/executions.test.ts`,
  `apps/server/test/payer/vault-direct.test.ts`,
  `apps/server/test/payer/constants.test.ts`,
  `apps/server/test/payer/safe-fetch.test.ts`.

### Part 3 — T-049

- `apps/server/src/evidence/receipts.ts`: PaymentRef and Receipt validation,
  K3 `sl-receipt` signing, settlement gate and idempotent evidence storage.
- `apps/server/migrations/0006-evidence-receipts.sql`.
- `apps/server/test/evidence/receipts.test.ts`,
  `apps/server/test/payer/test-signer.ts`.
- `apps/server/test/migrate.test.ts`, `pnpm-lock.yaml`.

## Verification

- `pnpm --filter @czar/server test` — passed: 24 files, 139 tests.
- `pnpm --filter @czar/server eval P-01 P-02` — passed: P-01 10/10 and P-02 7/7
  offline cases.
- `pnpm --filter @czar/server eval P-01 --regex-only` — passed: 6/6 required cases.
- `pnpm --filter @czar/server eval P-01 --live` — expected refusal, exit 1:
  `Refusing live eval: G0-16 and K18 approval are not recorded.` No hosted call ran.
- `pnpm -r typecheck` — passed for all 14 workspace projects.
- `pnpm lint` — passed (`oxlint --deny-warnings`, `oxfmt --check`).
- `pnpm --filter @czar/server exec vitest run test/payer test/evidence/receipts.test.ts`
  — passed: 5 files, 10 tests.
- `FOUNDRY_PROFILE=arc arc-forge build --offline` — passed with Arc Foundry 1.7.1-dev.
- `FOUNDRY_PROFILE=arc pnpm --filter @czar/vault-client test` — passed: 5 files,
  80 tests, including its real local Arc deployment and USDC_3009 vault path. The first
  run lacked compiled contract artifacts; building contracts first fixed that setup
  issue. `contracts/broadcast/` and `contracts/foundry.lock` were removed afterward.
- `git diff --check` — passed.
- `rg` scan for test-owner/private-key helpers under `apps/server/src` — no matches.

## SCRs and open issues

- SCR text carried from T-046: the canonical derivation for the model-proxy
  `promptHash` is not pinned. T-046 accepts the hash as trusted constructor input;
  no spec file was edited.
- T-048 still needs a process-kill test specifically between `auth.signed` and
  `call.sent`, the remaining exact crash points from CZ-15 §5.1, and an app-level Arc
  Anvil run proving `Envelope.spent` equals the settled payment. Current payer tests
  use a fake chain; the separate vault-client Arc suite does not exercise this executor.
- The acceptance flow with a recorded mock Facilitator and a live local HTTP seller,
  including five distinct subject queries and URLs, has not been run through the app
  payer. The payer-level injection invariance cases have not been run.
- The five-subject distinct-query/URL case and the payer-level injection invariance
  case have not been run.
- The payer requires boundary and receipt callbacks, but this branch has no production
  composition that instantiates those callbacks with `runBoundary`, the T-047 checker
  and `createPaymentReceipt`.
- T-049 needs an Arc Anvil test that takes a receipt produced by this app code and
  confirms the deployed vault returns `0x1626ba7e` from `isValidSignature`. Existing
  app tests use T-035's signer and storage; the contract suite validates its receipt
  verifier separately.
- Model prices remain pending G0-16; live evaluation remains blocked pending G0-16
  and K18 approval. T-050 remains deferred under D92. No live model/provider or
  testnet call was made.
