# T-065 task report

## Result

Implemented `POST /v1/models/complete` in the T-041 server app factory. It accepts
only prompts P-01, P-04, P-05, P-06, and P-07, validates the request and completion
against the API and caller-provided JSON Schema contracts, and calls only an
injected `ModelClient`. No real provider call or API key was used. K18 remains
owned by T-040.

The route reuses server authentication, rate limiting, request logging, problem
responses, request validation, and the shared idempotency helper. Each key is
consumed once; any second request with the same key receives `409 replay-not-stored`.
The database stores the key, request fingerprint, status, and input/output token
counts. Monthly usage stores token counts only. Request and response bodies are
not persisted or logged. P-07 usage counts against both the user and source
extractor monthly limits.

## Changed files

- `apps/server/src/models/proxy.ts` — injected model-client interface, validation,
  prompt timeouts, budget checks, token accounting, and `completeModelCall`.
- `apps/server/src/app.ts` — route registration and shared app-factory wiring.
- `apps/server/src/http/idempotency.ts` — shared idempotency and fingerprint code;
  existing pairing and objective submission now use it.
- `apps/server/migrations/0002-model-usage.sql` — count-only usage storage and
  per-call token-count columns.
- `apps/server/test/model-proxy.test.ts` — route, replay, allowlist, output schema,
  malformed-client, timeout, budget, and DB/log privacy tests.
- `apps/server/test/fixtures.ts` — injected client and config support.
- `apps/server/test/migrate.test.ts` — expected table list includes `model_usage`.
- `apps/server/package.json`, `pnpm-lock.yaml` — direct pinned Ajv 8.20.0 runtime
  dependency for Draft 2020-12 validation.
- `docs/specs/06-review/change-requests/SCR-117-model-proxy-client-contract.md` —
  records the open provider interface and prompt-asset specification gap.

## Local verification

Postgres was run locally through `apps/server/test/compose.yaml` using image
`postgres:16.15@sha256:ca0bd484cb98bf4b24eb1010e73fb3fcbd6714d240fbc1a10eea5b7dbecb641d`.
No GitHub CI was used.

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | passed |
| Initial `fnm exec --using=22.22.0 pnpm exec vitest run test/model-proxy.test.ts` before route implementation | failed as expected: route returned 404 |
| `fnm exec --using=22.22.0 pnpm --filter @czar/server test` | passed: 11 files, 45 passed, 0 failed |
| `fnm exec --using=22.22.0 pnpm --filter @czar/server typecheck` | passed |
| `fnm exec --using=22.22.0 pnpm --filter @czar/api-contract test` | passed: 1 file, 10 passed, 0 failed |
| `fnm exec --using=22.22.0 pnpm lint` | passed: oxlint with zero warnings; oxfmt check clean |
| `fnm exec --using=22.22.0 pnpm typecheck` | passed: all 14 workspace projects |
| `git diff --check` | passed |

The seven model-proxy tests include a DB scan across every public base table and
log scans for unique request and response markers. The route also checks each
completion's returned token counts against configured monthly limits before
returning output.

## Dependency audit

`pnpm audit --audit-level=moderate` exits 1 with 10 findings: 5 moderate and 5
high. They are already present in unrelated workspace dependency paths:

- `@hono/node-server`: 3, from `apps__indexer > ponder`.
- `drizzle-orm`: 1, from `apps__indexer > ponder`.
- `@graphql-tools/utils`: 2, from `apps__indexer > ponder > graphql-yoga`.
- `vite`: 3, from `apps__indexer > ponder`.
- `ajv`: 1, from the pre-existing `packages__x402` dependency path.

None of the findings come from dependencies added by T-065. The new direct Ajv
8.20.0 dependency has no reported finding.

## SCR and open issue

SCR-117 is open. The API contract defines the wire format but does not specify the
injected provider-client interface, prompt asset location/content, or how each
provider must enforce a passed token budget and timeout. The implementation uses
an internal injected-client interface and passes configured timeouts and remaining
token budgets to it; provider integration and prompt asset loading remain outside
this task until the SCR is resolved. No K18 behavior was added.
