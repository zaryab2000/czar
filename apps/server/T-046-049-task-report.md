# Lane 2 Bundle A task report

## Status

- T-046 injection boundary: implemented and locally verified.
- T-048 vault-direct payer: not started. Its required T-036 local-chain signer policy
  precondition is not complete on `origin/build-v1` (`docs/build-notes/tier-2-report.md`
  marks T-036 as outstanding). Per the builder prompt, work stops after Part 1; signer and
  acceptance-checker behavior was not stubbed.
- T-049 receipts and evidence store: not started because Part 2 is gated on T-048.
- Base checked: `origin/build-v1` at `d0e7d966950080e37f4d84419cdf1baea3eb1a12`.
- No PR was opened because the bundle is incomplete at the explicit T-036 gate.

## Files changed

### Part 1 — T-046

- `apps/server/src/boundary/index.ts`: P-01 whole-body regex and chunk screening,
  quarantine flow into the T-047 checker, P-02 expected-field derivation and
  post-validation, PII masking, code-only JSON fallback, and schema-validated StepResult.
- `apps/server/src/models/proxy.ts`: server-internal P-01/P-02 calls reuse T-065's
  reserve/call/settle path and owner budget. P-02 remains rejected by the public route.
- `apps/server/migrations/0004-boundary-model-budget.sql`: allow P-02 in the existing
  model usage and reservation prompt constraints.
- `apps/server/test/boundary.test.ts`, `apps/server/test/model-proxy.test.ts`: boundary,
  quarantine, chunk-coverage, fallback, masking, budget and public-route coverage.
- `apps/server/scripts/eval.mjs`, `apps/server/package.json`: offline P-01/P-02 evaluator;
  live mode refuses while G0-16/K18 approval is absent.
- `models/P-01.md`, `models/P-02.md`: system prompt text copied verbatim from
  `ai-prompts.md`.
- `models/evals/P-01/cases.json`, `models/evals/P-02/cases.json`: recorded offline cases,
  including adversarial replies.

### Parts 2–3

- No T-048 or T-049 files were changed.

## Verification

- `pnpm --filter @czar/server test` — passed; 19 test files, 127 tests.
- `pnpm --filter @czar/server eval P-01 P-02` — passed; P-01 10/10, P-02 7/7 offline
  cases. The eval also confirms the saved prompt files match `ai-prompts.md`; regex-only
  screening catches P-01 cases 2–6 and 9.
- `pnpm --filter @czar/server eval P-01 --regex-only` — passed; 6/6 required regex-only
  cases (P-01 cases 2–6 and 9).
- `pnpm --filter @czar/server eval P-01 --live` — expected refusal, exit 1:
  `Refusing live eval: G0-16 and K18 approval are not recorded.` No hosted call was made.
- `pnpm -r typecheck` — passed for all 14 workspace projects with typecheck scripts.
- `pnpm lint` — passed (`oxlint --deny-warnings` and `oxfmt --check`).
- `git diff --check` — passed.
- Arc-anvil/payment loop, kill-and-resume matrix, signer calls, receipt signatures,
  `isValidSignature`, and evidence storage were not run because T-048/T-049 were gated.

## SCRs and open items

- SCR text needed: define the canonical derivation for the `promptHash` logged by the
  model proxy. Current specs require a prompt hash but do not pin whether it hashes the
  exact prompt file bytes or a named canonical object. T-046 accepts prompt hashes as a
  trusted constructor input until that definition is approved; it does not invent a rule.
- Model/provider prices remain pending G0-16. Live eval remains pending G0-16 and K18
  account approval; no provider call was made.
- T-048 remains blocked by T-036 signer-policy local-chain evidence. T-049 waits for T-048.
- T-050's live testnet slice remains deferred per D92; no testnet, funds, account or keys
  were used.
- This is a partial bundle report, not a ready-for-review report. Rebase and open the one
  Bundle A PR only after T-036 is present and Parts 2–3 pass their acceptance tests.
