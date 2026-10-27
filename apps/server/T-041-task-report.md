# T-041 task report — CZ-12 server skeleton

**Branch:** `codex/t041-server-skeleton`

**Base:** `build-v1` at `b8a7e2c` (SCR-116 merge, PR #28)

**Worktree:** `/private/tmp/czar-t041-server`

## Result

Implemented the CZ-12 server package and its four S1 routes, pairing and device authentication, seeded app-session verification, objective submission with hash validation/idempotency/outbox, cursor pagination, status guard, goal retention, migrations, rate limiting, safe errors and allowlisted request logging. Fixed S1-P1 in `@czar/hashing` using the accepted SCR-116 nested TaskSpec preimage and bound its hash into `objectiveHash`.

The test-first subject-label vector uses fixed expected hashes. It confirms both the task-spec digest and the objective digest change when only the subject label changes. The initial test run was red because `taskSpecHash` was not exported; the implementation then made the hashing suite green.

## Files changed

- `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/vitest.config.ts`
- `apps/server/migrations/0001-cz12.sql`
- `apps/server/src/app.ts`
- `apps/server/src/db/migrate.ts`
- `apps/server/src/devices/pair.ts`
- `apps/server/src/http/auth.ts`, `ids.ts`, `problem.ts`, `validate.ts`
- `apps/server/src/objectives/retention.ts`, `service.ts`, `state.ts`
- `apps/server/src/index.ts`
- `apps/server/test/compose.yaml`, `db.ts`, `fixtures.ts`, `app.test.ts`, `auth.test.ts`, `ids.test.ts`, `migrate.test.ts`, `objectives.test.ts`, `outage.test.ts`, `pairing.test.ts`, `rate.test.ts`, `submission.test.ts`, `validate.test.ts`
- `packages/hashing/package.json`, `packages/hashing/src/named.ts`, `packages/hashing/test/named.test.ts`
- `packages/logging/src/allowlist.ts`, `packages/logging/test/logger.test.ts`
- `packages/api-contract/package.json` (`@types/js-yaml@4.0.9` fixes the package's missing declaration type and allows recursive typecheck)
- `pnpm-lock.yaml`

No `docs/specs/`, `docs/product/`, `docs/architecture/` or `.github/workflows/` files were changed. The local SCR-116 copy was removed after the accepted change landed in PR #28.

## Verification

Runtime used: Node `22.22.0`, pnpm `10.28.0`; Docker Compose used the local OrbStack daemon.

| Command | Result |
|---|---|
| `fnm exec --using=22.22.0 pnpm install --frozen-lockfile` | PASS |
| `fnm exec --using=22.22.0 pnpm --filter @czar/hashing test` | PASS, 5 files / 39 tests |
| `fnm exec --using=22.22.0 pnpm --filter @czar/config test` | PASS, 2 files / 24 tests |
| `fnm exec --using=22.22.0 pnpm --filter @czar/logging test` | PASS, 1 file / 12 tests |
| `fnm exec --using=22.22.0 pnpm --filter @czar/schemas test` | PASS, 1 file / 32 tests |
| `fnm exec --using=22.22.0 pnpm --filter @czar/api-contract test` | PASS, 1 file / 10 tests |
| `docker compose -f apps/server/test/compose.yaml up -d --wait` | PASS, PostgreSQL healthy |
| `fnm exec --using=22.22.0 pnpm --filter @czar/server typecheck` | PASS |
| `fnm exec --using=22.22.0 pnpm --filter @czar/server test` | PASS, 10 files / 38 tests |
| `fnm exec --using=22.22.0 sh -c 'cd apps/server && node -e "import(\"@czar/server\").then(() => console.log(\"server package loads under node\"))"'` | PASS under Node 22; printed the expected message |
| `fnm exec --using=22.22.0 pnpm lint` | PASS, oxlint and oxfmt, zero warnings |
| `fnm exec --using=22.22.0 pnpm -r typecheck` | PASS, all 14 included workspace projects |
| `(cd docs/specs/02-data-and-protocol/schemas && python3 -I check-schemas.py)` | PASS, checked 28 files / 0 problems |
| `docker compose -f apps/server/test/compose.yaml down` | PASS, test container and network removed |

The Postgres multi-platform image digest resolved with `docker buildx imagetools inspect postgres:16.15` and pinned in the test Compose file is:

`sha256:ca0bd484cb98bf4b24eb1010e73fb3fcbd6714d240fbc1a10eea5b7dbecb641d`

## Dependency audit

`fnm exec --using=22.22.0 pnpm audit --audit-level=moderate` reports **10 findings (5 moderate, 5 high)** and exits 1 at the requested threshold. They come from these existing dependency paths/packages:

- `@hono/node-server` — `apps__indexer > ponder` (3 findings)
- `drizzle-orm` — `apps__indexer > ponder` (1 finding)
- `@graphql-tools/utils` — `apps__indexer > ponder > graphql-yoga` (2 paths for one advisory)
- `vite` — `apps__indexer > ponder` (3 findings)
- `ajv` — `packages__x402` (1 finding)

The nine distinct advisory IDs are `GHSA-wc8c-qw6v-h7f6`, `GHSA-gpj5-g38j-94v9`, `GHSA-7mx3-vvmw-hjmv`, `GHSA-587h-7wmj-h5pm`, `GHSA-2g4f-4pwh-qvx6`, `GHSA-92pp-h63x-v22m`, `GHSA-frvp-7c67-39w9`, `GHSA-698v-4r3x-3vcv` and `GHSA-r825-w8mm-5pxw`. `pnpm audit --json` confirms none of the 10 findings come from dependencies added by T-041 (`hono`, `pg`, `@types/pg`, or its workspace dependencies); the `ajv` finding is on the pre-existing `packages__x402` path.

## §13 completion record

- [x] §2.1 gate confirmed: T-006/T-009 tests pass and the SCR-113/SCR-115 OpenAPI/config updates are present.
- [x] S1-P1 fixed with the accepted nested TaskSpec form and subject-label hash vector; S1-P3 and S1-P7 remain recorded for T-081/T-082 and T-045 owners.
- [x] Migration replay/checksum/failure behavior and exact table set tested.
- [x] Pair, submit, list and get route contracts and named behaviors tested, including same-key replay/conflict and tamper rejection.
- [x] Pair replay returns `replay-not-stored` without re-exposing a bearer; `PairResponse` has no `expiresAt`.
- [x] Local-only fields rejected; submission/outbox writes are atomic; only canonical objective states are stored.
- [x] Device isolation, pairing single use, token hashing, configured TTLs, cursor expiry, retention and rate-limit boundaries tested.
- [x] Concurrent retries, transaction rollback, database outage and sensitive-data logging/error checks tested.
- [x] Plain Node package import, lint and recursive typecheck pass locally with zero warnings.

## SCRs and open issues

No SCRs were filed. SCR-116 was accepted and merged as PR #28 before this implementation was rebased. The dependency audit findings listed above are existing Ponder dependency paths; no T-041-added dependency is implicated. No implementation issue remains for T-041. S1-P3 and S1-P7 are explicitly outside this task and remain with their later owners.
