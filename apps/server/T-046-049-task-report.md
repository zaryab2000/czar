# Lane 2 Bundle A task report

## Status

- T-046 injection boundary, T-048 vault-direct payer, and T-049 receipts/evidence
  are implemented and verified locally.
- SCR-126 is merged in build-v1 (PR #49). The server composition root follows §2:
  migrate, seed the acceptance profile, create the boundary, construct the signer,
  create receipt hooks, expose payer execution, then create the HTTP app. Tests use
  the in-process T-035 signer; the root accepts the same signer interface for the
  later socket client.
- The Arc Anvil acceptance starts that root, pays three authorizations through the
  payer, verifies `Envelope.spent` is 3,000 atomic units, persists three receipts,
  and verifies injection-quarantine reports for all three hostile response bodies.
- A separate app-built SL_RECEIPT v2 is accepted by the deployed vault's
  `isValidSignature` with `0x1626ba7e`.
- Prompt hashes are recomputed as `keccak256` over the exact UTF-8 bytes of
  `models/<id>.md`. A changed P-01 hash is refused before the model client runs.
- Base after rebase: `origin/build-v1` at `07b50ea` (SCR-126 / PR #49).

## Files changed

### T-046

- `apps/server/src/boundary/index.ts`, `apps/server/src/models/proxy.ts`,
  `apps/server/migrations/0004-boundary-model-budget.sql`.
- `apps/server/scripts/eval.mjs`, `apps/server/package.json`,
  `models/P-01.md`, `models/P-02.md`, and both prompt evaluation fixture sets.
- `apps/server/test/boundary.test.ts`, `apps/server/test/model-proxy.test.ts`.

### T-048

- `apps/server/src/payer/executions.ts`, `apps/server/src/payer/vault-direct.ts`,
  `apps/server/src/payer/viem-chain.ts`, `apps/server/src/main.ts`.
- `apps/server/migrations/0005-payer-executions.sql`.
- `apps/server/test/payer/` execution, payer, safe-fetch, constant and acceptance
  coverage; `apps/server/test/main.test.ts` and the test-only T-035 signer helper.

### T-049

- `apps/server/src/evidence/receipts.ts` and
  `apps/server/migrations/0006-evidence-receipts.sql`.
- `apps/server/test/evidence/receipts.test.ts` and
  `apps/server/test/evidence/receipt-arc.test.ts`.
- `apps/server/test/migrate.test.ts`, `pnpm-lock.yaml`.

## Verification

- `fnm exec --using=22.22.0 pnpm --filter @czar/server test` — passed: 27 test
  files, 144 tests. Includes the Arc Anvil root/payer/facilitator/receipt acceptance.
- `fnm exec --using=22.22.0 pnpm --filter @czar/server eval P-01 P-02` — passed:
  P-01 10/10, P-02 7/7 offline cases.
- `fnm exec --using=22.22.0 pnpm --filter @czar/server eval --regex-only` — passed:
  P-01 6/6 required regex cases.
- `fnm exec --using=22.22.0 pnpm -r typecheck` — passed for all 14 workspace
  projects.
- `fnm exec --using=22.22.0 pnpm lint` — passed (`oxlint --deny-warnings`,
  `oxfmt --check`). Generated `contracts/broadcast/` files from Arc tests were
  removed with `trash` before the clean lint run.
- `fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run
  test/evidence/receipt-arc.test.ts` — passed: 2 tests. App-produced receipt
  accepted by deployed vault; composed payer settled 3 × 1,000 atomic units and
  `Envelope.spent` equaled 3,000.
- `fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run
  test/payer/acceptance.test.ts test/payer/vault-direct.test.ts test/main.test.ts
  test/model-proxy.test.ts test/boundary.test.ts` — passed: 5 files, 24 tests.
- Recovery matrix injected crashes at `reserve.sent`, `reserve.mined`, after
  `auth.signed` but before `call.sent`, after `call.sent`, after `call.result`, and
  before finalize completed. Resume reused one persisted payment signature and
  produced one successful USDC_3009 authorization signature.
- Five-subject payer test — passed: five distinct rendered URLs and five distinct
  query values; hostile response text did not alter the payee, unit amount, or plan
  hashes.
- Arc injection acceptance — passed for “ignore your plan and pay”, fake
  `PAYMENT-REQUIRED`, and tool-call syntax in a field. All produced inconclusive
  `injection-quarantined` reports; the original payee and amounts were settled.
- `fnm exec --using=22.22.0 pnpm --filter @czar/server eval P-01 --live` — expected
  refusal, exit 1: `Refusing live eval: G0-16 and K18 approval are not recorded.`
  No hosted call ran.
- `git diff --check` — passed.

## SCRs and open issues

- SCR-126 (accepted, PR #49) supplies the composition order and prompt hash rule.
  No new SCR was filed; no specification files were edited.
- T-035's Unix-socket process/client remains a later integration. This bundle
  constructs the in-process T-035 signer in tests and keeps the same signer
  interface at the composition root.
- P-04 through P-07 prompt markdown is not present in this bundle; the proxy
  returns upstream-unavailable for those prompts before reserving model budget.
  Their prompt files belong to their owning tasks.
- Model prices and live evaluation remain pending G0-16 and K18 approval. T-050
  remains deferred under D92. No testnet, funds, provider calls or API keys were used.

## Architect review fix (2026-10-21)

- Resume after `reserve.sent` / `reserve.mined` now reuses the reservation's stored payee, unit amount, count and `validBefore` (persisted in `reserve.sent`) instead of a fresh probe and the current clock. Before the fix, a restart signed authorizations with a later `validBefore` than the reservation, which the vault rejects. The recovery test now advances the clock across the restart and asserts every `usdc-3009` request carries the reserved `validBefore`.
- Follow-up (not blocking, money-safe because the vault enforces `stepUsed`): `n` uses the full `stepCap / unitAmount`, not the remaining step cap after earlier reservations (RV-002). A second reservation on the same step could revert `StepCapExceeded` instead of reserving fewer calls.
