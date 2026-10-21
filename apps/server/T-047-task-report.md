# T-047: Acceptance checker minimal

## Delivered

- Added `profileId` and `shapeHash` to `@czar/hashing`, with canonical hash tests.
- Added the SCR-122 `data-json` profile, plain JavaScript check executor, worker and
  restricted `vm` context. The executor file is loaded and run unchanged; its UTF-8
  bytes determine `code_hash`.
- Implemented delivery, structural and requirement checks, including the five
  delivered-as-is format checks. Ajv 8.20.0 validates JSON schemas in the worker
  with no remote schema loader. Timeout and memory termination produce
  inconclusive checks with `sandbox-timeout`.
- Added quarantine handling, `AcceptanceReport` schema validation, `reportHash`,
  profile/report storage and idempotent data-json profile seeding when the checker
  is initialized. Exported the checker and its constructor types from the server
  package.
- Added migration `0003-acceptance.sql`; no `acceptance_decisions` table was added.

## Files changed

- `packages/hashing/src/named.ts`
- `packages/hashing/test/named.test.ts`
- `apps/server/migrations/0003-acceptance.sql`
- `apps/server/src/acceptance/context.ts`
- `apps/server/src/acceptance/executor/checks.js`
- `apps/server/src/acceptance/index.ts`
- `apps/server/src/acceptance/profile.ts`
- `apps/server/src/acceptance/sandbox.ts`
- `apps/server/src/acceptance/types.ts`
- `apps/server/src/acceptance/worker.js`
- `apps/server/src/index.ts`
- `apps/server/test/acceptance/checker.test.ts`
- `apps/server/test/acceptance/context.test.ts`
- `apps/server/test/acceptance/formats.test.ts`
- `apps/server/test/acceptance/sandbox.test.ts`
- `apps/server/test/migrate.test.ts`
- `apps/server/T-047-task-report.md`

## Verification

All commands ran locally on Node 22. Results:

| Command | Result |
|---|---|
| `fnm exec --using=22 pnpm --filter @czar/hashing test` | Passed: 5 files, 42 tests |
| `fnm exec --using=22 pnpm --filter @czar/server test` | Passed: 18 files, 118 tests |
| `fnm exec --using=22 pnpm -r typecheck` | Passed: 14 workspace projects |
| `fnm exec --using=22 pnpm lint` | Passed: oxlint and oxfmt |

Acceptance coverage includes schema-valid JSON pass, body-size, HTTP status, empty
body and timeout failures, no-response and no-schema/no-history inconclusive,
unavailable and injection quarantine, fetch/require/process/timer isolation,
remote `$ref` with zero requests, infinite loop termination, memory exhaustion
isolation, stored `reportHash` recomputation, profile ID recomputation, and
executor byte-hash recomputation.

## SCRs and open items

- Proposed SCR-124 (structural inconclusive blocks pass) was rejected in review. D55
  governs the structural check result, which stays `inconclusive` and never enters
  posteriors; the overall decision follows CZ-16 §5.3 (`delivery pass ∧ structural ∉
  {fail} ∧ requirement ∉ {fail}`). The stricter rule would have stopped every first call
  to a schemaless service and rejected every as-is markdown job. The builder's SCR file
  under `docs/specs/` was removed; builders do not edit that folder.
- No model calls or key access are used. The K7 validator identity, sanitized
  service schema and shape-history data remain constructor ports; their real
  providers belong to their owning tasks.
- The checker seeds the profile during `createAcceptanceChecker` initialization.
  The repository currently exposes an app factory rather than a server bootstrap,
  so automatic invocation by a production composition root was not verified.
- No T-046 migration was present in the local `build-v1` base when migration
  `0003` was added; migration numbering should be reconciled if that changes
  before merge.
