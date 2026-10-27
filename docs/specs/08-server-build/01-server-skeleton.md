# S1 — CZ-12 server skeleton and objective store

**Task:** T-041 · **Milestone:** M3-a · **Status:** implementation PRD, reviewed 2026-10-21 against merged T-006 (#25), T-009 (#27) and SCR-113/115 (#24). Ready to build in one pass · **Updated:** 2026-10-21.

## 1. Scope and authority

This PRD builds the first usable slice of `@czar/server`: PostgreSQL 16 migrations, the HTTP process, device-token authentication, app-session verification middleware, idempotency, rate limits, RFC 9457 errors, objective persistence and the four T-041 daemon routes. It includes the CZ-12 table foundations needed by later server PRDs. It makes **no** smart-contract call, creates no wallet, and runs no fork or funded test.

The binding sources, in order, are:

1. [`T-041`](../05-build-plan/phase-1-tasks.md) and the [builder rules](../05-build-plan/builder-agent-rules.md).
2. [`openapi.yaml`](../02-data-and-protocol/api/openapi.yaml), [`objective-submission.schema.json`](../02-data-and-protocol/schemas/objective-submission.schema.json), and [`data-and-protocol.md` §5.2 and §9.1–§9.5](../02-data-and-protocol/data-and-protocol.md).
3. [`CZ-12` §4–§14](../04-components/server/server-planning-and-payment.md) and [cross-cutting rules](../04-components/shared/cross-cutting.md).
4. This PRD. If the sources above disagree, stop the affected work and file an SCR. Do not edit the canonical specs as part of T-041.

**T-041 ends after `pairDevice`, `submitObjective`, `listObjectives`, and `getObjective` meet their contract and behavior tests.** The broader CZ-12 statement that every OpenAPI operation is implemented is the *eventual component exit*, across T-041, T-081 and later server tasks. S1 provides a route-registration seam for later PRDs but does not return fake success for unbuilt operations.

Out of S1: planner decisions (CZ-13), router (CZ-14), paying agent (CZ-15), result bodies/acknowledgment, approval intents, provider routes, app read handlers, WebAuthn session creation (T-081), app onboarding (T-082), model calls, cloud deployment, and push. An HTTP 404 for an unregistered future route is honest; no placeholder writes or payments.

Also out of S1, because T-040 owns them and no config key for them exists yet: the process launcher (listen port, origin, DB connection settings), the health endpoint, launchd/compose for the product database, and scheduling of the retention purge. S1 exports the pieces T-040 wires up (`createApp`, `migrate`, `purgeExpiredGoals`); it does not ship a `main.ts` that would have to invent those settings. CZ-12 §11 metrics also wait: `@czar/logging` has no metrics API yet, and S1 must not add a second telemetry package.

## 2. Start gate and gaps

### 2.1 Start gate (all must be true before the builder starts)

Status on 2026-10-21: every dependency is merged and both SCRs are applied, so the gate is expected to be green. The builder still runs the §12 step 0 check to confirm it.

| Order | Task | State on 2026-10-21 | Why S1 needs it |
|---|---|---|---|
| 1 | T-006 `@czar/schemas` | merged (PR #25) | `ObjectiveSubmission` validator, `assertNoLocalOnly`, generated types |
| 2 | T-009 `@czar/api-contract` | merged (PR #27) | per-`operationId` request and response validators and the route-test helper |
| 3 | T-041 (this PRD) | `apps/server/` holds only `.gitkeep` | — |

T-004 `@czar/config`, T-005 `@czar/logging` and T-007 `@czar/hashing` exist. The builder rules require a stop if a dependency is missing; this PRD does not waive that. Import the *actual* exports of T-006 and T-009 once merged; never write a second schema loader or OpenAPI parser in the server.

Two spec changes must be **accepted by Zaryab and applied to the canonical files** before step 3 starts. Applying them is an architect/owner action, not a builder action:

| SCR | What it fixes | Exact change |
|---|---|---|
| [SCR-113](../06-review/change-requests/SCR-113-pairing-token-replay-and-lifetime.md) | Pair replay would re-reveal the bearer; `PairResponse.expiresAt` has no meaning | Appendix A items 1–2 |
| [SCR-115](../06-review/change-requests/SCR-115-s1-routes-responses-and-parameters.md) | The four routes do not declare the error codes S1 must return; two time limits have no config key | Appendix A items 3–4 |

SCR-113 and SCR-115 were accepted and applied in PR #24, before T-009 was built.

### 2.3 What the two packages actually provide (read before coding)

**`@czar/schemas`** (T-006):
- `assertNoLocalOnly(value, "objective-submission")` validates the schema **and** rejects any `local-only` field. It throws `SchemaValidationError` or `LocalOnlyFieldError`; map both to `400 validation`.
- `validateObjectiveSubmission(value)` is a type guard if only a boolean is needed.
- Types: `ObjectiveSubmission`, `TaskSpec`, `ObjectiveStatusValue` and the rest, from `@czar/schemas`.

**`@czar/api-contract`** (T-009):
- `validateRecordedExchange(operationId, {requestBody, responseStatus, responseBody})` returns `{valid, errors}`. It checks:
  - the request body, for operations that have one; **always pass `requestBody` for POSTs**, or the check fails;
  - that the status is declared for the operation;
  - the response body against that status's schema.
- `apiContracts.get(operationId)` gives `{request, responses, responseStatuses}` for direct use.
- `resolveReference(pointer)` resolves any JSON pointer into `openapi.yaml`, for example `"#/components/parameters/Limit"`.
- **It does not check:** path parameters, query parameters, headers (`Idempotency-Key`, `RateLimit-*`, `Authorization`) or `Content-Type`. The server checks these itself (§6), and the tests assert them directly.

### 2.2 Gaps found and how they are resolved

| ID | Evidence | Resolution |
|---|---|---|
| S1-P1 | `packages/hashing/src/named.ts` `objectiveHash` omits `taskSpecHash`; spec 02 §5.2 requires it (D84). There is no `taskSpecHash` export. | **In S1 scope, build step 0 (§12).** The spec is unambiguous, so this is a code fix, not a spec change. Add `taskSpecHash(taskSpec)` = `H({hashRule:"czar-hash-v1", kind:"task-spec", ...TaskSpec})` and a required `taskSpecHash` field on `ObjectiveInput` included in the preimage. Test first: a vector where only one `TaskSpec.subjects[].label` changes must change `objectiveHash`. The server imports this; it never re-implements the rule. |
| S1-P2 | `pairDevice` requires `Idempotency-Key`, and 02 §9.3 replays stored responses, but the token is "shown once" (AM-18). | SCR-113, Appendix A item 1. |
| S1-P3 | No route issues the 8-digit code or a WebAuthn `challengeId`. | S1 ships an internal `issuePairingCode` service used only by tests. Public issuance belongs to T-081/T-082 and needs its own spec. Does not block S1. |
| S1-P4 | `PairResponse.expiresAt` is required but undefined; K15 defines revocation, not expiry. | SCR-113, Appendix A item 2. |
| S1-P5 | OpenAPI declares no `401` on `submitObjective`/`listObjectives`/`getObjective`, no `400` on the two GETs, no `429` on `getObjective`, and no `503` on any of the four. CZ-12 §10 requires `503 upstream-unavailable`; 02 §9.5 requires `429` on every surface. T-009's response validator would reject the server's own errors. | SCR-115, Appendix A item 3. |
| S1-P6 | Cursor expiry (1 h, 02 §9.5) and goal retention (1 year, CZ-12 §8) have no `@czar/config` key. Builder rules forbid magic numbers and invented keys. | SCR-115, Appendix A item 4: `api.cursorTtlMinutes` 60 and `api.goalRetentionDays` 365. |
| S1-P7 | `planHash` in `@czar/hashing` also omits `taskSpecHash` and per-step `callInputsHash` (02 §5.2, D84). | Not S1. Recorded for the T-045 planner preflight; S1 does not compute plan hashes. |

No input or credential from Zaryab is needed for S1 beyond accepting the two SCRs. Tests use generated fixture users and devices and an isolated PostgreSQL 16 database. Never use a live device token or the product database in tests.

## 3. Deliberate implementation choices

These choices select an implementation within the existing specs; they do not add an API shape:

| Area | Choice and reason |
|---|---|
| HTTP | Hono on Node 22 ESM. The lockfile already pins `hono` 4.13.13 (via Ponder). S1 needs no Node listener: route tests call `app.request()`, and T-040 adds `@hono/node-server` when it writes the launcher. |
| SQL | `pg` with parameterized SQL and checked-in numbered `.sql` migrations. No ORM or migration framework. The caller injects one `Pool`; every transaction uses one checked-out client. |
| PostgreSQL | `postgres:16.15` for tests, pinned by image digest (§13). Product Postgres is T-040's Docker container bound to `127.0.0.1` (D70). Never a credential in Git, argv, logs or environment. |
| Versions | Exact pins, no ranges: `hono` 4.13.13 (already in the lockfile), `pg` 8.23.1, dev-only `@types/pg` 8.23.1. Both `pg` versions were older than the workspace's `minimumReleaseAge: 1440` rule on 2026-10-21. Run `pnpm audit --audit-level=moderate` after install and paste the result in the task report. |
| Runtime dependencies | `@czar/config`, `@czar/logging`, `@czar/schemas`, `@czar/api-contract`, `@czar/hashing` as `workspace:*`. No ABI, vault client, model provider, `@hono/node-server`, `tsx`, ORM, OpenAPI router generator or second logging package. |
| DB connection | `createApp`, `migrate` and `purgeExpiredGoals` take a `Pool` argument. S1 never reads a connection string from config or environment. Tests build their pool from the fixed test constant in §13. |
| Names | API objects use the schema's camelCase. SQL columns use snake_case. Conversion lives in repository functions, not handlers. IDs, state names, hashes and amounts keep their exact spec wire forms. |
| Logging | `createLogger({service:"server", component:"CZ-12"})`. Use only allowlisted field names (cross-cutting §4, `packages/logging/src/allowlist.ts`): `traceId` (16–32 lowercase hex), `method`, `route` (set to the `operationId`), `httpStatus`, `durationMs`, `czarCode`, `retryable`, `deviceId`, `objectiveId`, `state`. Any other name is silently dropped, so do not invent `operationId` or `ip` fields. |

The only tables beyond CZ-12's list are `schema_migrations`, `pairing_codes`, `outbox_events`, `rate_limit_buckets` and `objective_cursors`. They are internal persistence for migrations, single-use pairing, the persisted event bus CZ-12 §4 names, rate limits and the 1-hour cursor rule. None exposes a new public shape.

`apps/server/package.json` (replacing the `.gitkeep`):

```json
{
  "name": "@czar/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "imports": {
    "#src/*": "./src/*.ts"
  },
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  }
}
```

Add the dependencies with `pnpm --filter @czar/server add -E ...`. Copy `tsconfig.json` and `vitest.config.ts` from `apps/signer` and adjust only paths. Imports inside the package use an `imports` map, `"imports": {"#src/*": "./src/*.ts"}`, the same as `@czar/schemas` and `@czar/api-contract`. **Never `#/*`**: Node 22 rejects it with `ERR_INVALID_MODULE_SPECIFIER`. Vitest accepts it, so the bug hides in tests; it was fixed in both packages in PR #27. Never `../`. Node 22.18+ runs `.ts` directly, so no build step.

## 4. File map

Create only these S1-owned files (split a file if a function exceeds the repository limits):

| File | Purpose |
|---|---|
| `packages/hashing/src/named.ts`, `packages/hashing/test/named.test.ts` | Build step 0 (S1-P1): `taskSpecHash` and its inclusion in `objectiveHash`. |
| `apps/server/package.json`, `tsconfig.json`, `vitest.config.ts` | Workspace package `@czar/server` as in §3. |
| `apps/server/src/index.ts` | Public exports for T-040: `createApp`, `migrate`, `purgeExpiredGoals`, `issuePairingCode`. |
| `apps/server/src/app.ts` | `createApp({pool, config, logger, clock, random})`; middleware order; the four route registrations. |
| `apps/server/src/db/migrate.ts`, `repositories.ts` | Transactional migration runner; parameterized SQL repositories. |
| `apps/server/migrations/0001-cz12.sql` | Tables, constraints and indexes in §5. |
| `apps/server/src/http/auth.ts`, `idempotency.ts`, `rate-limit.ts`, `problem.ts`, `validate.ts`, `ids.ts` | HTTP policies in §§6–8; `ids.ts` mints ULID-based IDs and tokens from the injected random source. |
| `apps/server/src/objectives/state.ts`, `service.ts`, `retention.ts` | Transition guard; submission transaction and queries; `purgeExpiredGoals(pool, now)`. |
| `apps/server/src/devices/pair.ts` | Internal code issuance and consumption, and the pair handler. |
| `apps/server/src/routes/daemon.ts` | The four S1 handlers only. Keep them thin. |
| `apps/server/test/compose.yaml`, `test/db.ts`, `test/fixtures.ts`, `test/*.test.ts` | Local PostgreSQL 16 for tests; per-test-file database setup; fixtures; tests in §11. |

`packages/api-contract` owns the OpenAPI validators; `packages/schemas` owns `ObjectiveSubmission`, generated types and the sender guard. The server may define private row types but never hand-copies a wire interface.

## 5. Database migration, exact shape

Use a checked-in SQL migration. `migrate.ts` creates `schema_migrations` under an advisory lock, applies each numbered file once in filename order in a transaction and records its SHA-256; `migrate` throws if an already-applied file's hash changed. Never auto-drop or rewrite data. All timestamps are `timestamptz` UTC; the SQL names below map to the CZ-12 §5 fields. `bytea` holds digests, never raw bearer tokens.

Before applying `0001`, create the migration ledger in the same locked transaction:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename text PRIMARY KEY,
  sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
  applied_at timestamptz NOT NULL DEFAULT now()
);
```

```sql
CREATE TABLE users (
  user_id text PRIMARY KEY CHECK (user_id ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
  msca text,
  vault text,
  network text NOT NULL DEFAULT 'eip155:5042002',
  user_secret bytea,
  demand_salt bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (user_secret IS NULL OR octet_length(user_secret) = 32),
  CHECK (demand_salt IS NULL OR octet_length(demand_salt) = 32)
);
CREATE TABLE devices (
  device_id text PRIMARY KEY CHECK (device_id ~ '^dev_[0-9A-HJKMNP-TV-Z]{26}$'),
  user_id text NOT NULL REFERENCES users(user_id),
  device_name text NOT NULL CHECK (char_length(device_name) <= 64),
  platform text NOT NULL CHECK (platform IN ('macos','linux','windows')),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pairing_codes (
  code_digest bytea PRIMARY KEY CHECK (octet_length(code_digest) = 32),
  user_id text NOT NULL REFERENCES users(user_id),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pairing_codes_expiry ON pairing_codes(expires_at);
CREATE TABLE objectives (
  objective_id text PRIMARY KEY CHECK (objective_id ~ '^obj_[0-9A-HJKMNP-TV-Z]{26}$'),
  user_id text NOT NULL REFERENCES users(user_id),
  device_id text NOT NULL REFERENCES devices(device_id),
  submission jsonb NOT NULL,
  objective_hash text NOT NULL CHECK (objective_hash ~ '^0x[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN (
    'received','planning','no-supplier','awaiting-approval','opening',
    'executing','replanning','delivered','failed','expired','dismissed')),
  plan_id text,
  envelope_ref text,
  result_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX objectives_device_page ON objectives(device_id, created_at DESC, objective_id DESC);
CREATE INDEX objectives_device_state_page ON objectives(device_id, state, created_at DESC, objective_id DESC);
CREATE TABLE plans (
  plan_id text PRIMARY KEY CHECK (plan_id ~ '^pln_[0-9A-HJKMNP-TV-Z]{26}$'),
  objective_id text NOT NULL REFERENCES objectives(objective_id),
  plan jsonb NOT NULL,
  plan_hash text NOT NULL CHECK (plan_hash ~ '^0x[0-9a-f]{64}$'),
  payee_root text NOT NULL CHECK (payee_root ~ '^0x[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('draft','offered','approved','superseded','expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plans_objective ON plans(objective_id);
CREATE TABLE steps (
  plan_id text NOT NULL REFERENCES plans(plan_id),
  step_index integer NOT NULL CHECK (step_index BETWEEN 0 AND 63),
  step jsonb NOT NULL,
  state text NOT NULL,
  calls_used integer NOT NULL DEFAULT 0 CHECK (calls_used >= 0),
  reservation_id text,
  job_key text,
  pocket text,
  PRIMARY KEY (plan_id, step_index)
);
CREATE TABLE step_executions (
  execution_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_id text NOT NULL,
  step_index integer NOT NULL,
  attempt integer NOT NULL CHECK (attempt >= 0),
  phase text NOT NULL,
  payload jsonb NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (plan_id, step_index) REFERENCES steps(plan_id, step_index)
);
CREATE INDEX step_executions_step ON step_executions(plan_id, step_index, execution_id);
CREATE TABLE results (
  result_id text PRIMARY KEY CHECK (result_id ~ '^res_[0-9A-HJKMNP-TV-Z]{26}$'),
  objective_id text NOT NULL UNIQUE REFERENCES objectives(objective_id),
  rendered_body text NOT NULL,
  provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pay_requests (
  pay_request_id text PRIMARY KEY CHECK (pay_request_id ~ '^prq_[0-9a-f]{32}$'),
  device_id text NOT NULL REFERENCES devices(device_id),
  plan_id text NOT NULL REFERENCES plans(plan_id),
  step_index integer NOT NULL,
  fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
  status text NOT NULL,
  payment_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  user_id text NOT NULL REFERENCES users(user_id),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE idempotency (
  scope text NOT NULL,
  key uuid NOT NULL,
  fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
  status smallint,
  response_body jsonb,
  response_hash bytea,
  replay_stored boolean NOT NULL DEFAULT true,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key),
  CHECK (status IS NULL OR status BETWEEN 100 AND 599)
);
CREATE INDEX idempotency_expiry ON idempotency(expires_at);
CREATE TABLE outbox_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  objective_id text REFERENCES objectives(objective_id),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE INDEX outbox_pending ON outbox_events(event_id) WHERE delivered_at IS NULL;
CREATE TABLE rate_limit_buckets (
  surface text NOT NULL,
  principal_hash bytea NOT NULL CHECK (octet_length(principal_hash) = 32),
  window_start timestamptz NOT NULL,
  count integer NOT NULL CHECK (count >= 0),
  PRIMARY KEY (surface, principal_hash, window_start)
);
CREATE TABLE audit (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_key_id text,
  action text NOT NULL,
  object_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  amount_atomic text,
  tx_hash text,
  outcome text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
```

The `users` secret columns are unpopulated by S1 fixtures except generated test values; the later registration flow must decide key handling from the canonical key inventory. Never put them in API responses, logs or the task report. `step_executions` is a table reservation for S6; S1 has no code that writes a payment phase. Later PRDs may add indexes/columns by **new** migrations, never by editing `0001` after deployment.

Add an internal `objective_cursors` table to the same migration for 02 §9.5's opaque, expiring cursor rule:

```sql
CREATE TABLE objective_cursors (
  cursor_hash bytea PRIMARY KEY CHECK (octet_length(cursor_hash) = 32),
  device_id text NOT NULL REFERENCES devices(device_id),
  state_filter text,
  last_created_at timestamptz NOT NULL,
  last_objective_id text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX objective_cursors_expiry ON objective_cursors(expires_at);
```

The cursor given to a client is 32 random bytes encoded base64url; only its SHA-256 is stored. This avoids a new signing secret and keeps sort keys and device identity out of the URL. A cursor is bound to the same device and status filter and expires after `api.cursorTtlMinutes` (60, SCR-115). Opportunistically delete expired cursor, idempotency, rate-limit and pairing rows; do not let their cleanup change active rows.

## 6. Process and middleware pipeline

`createApp({pool, config, logger, clock, random})` returns a Hono app with the four `/v1/...` routes. Nothing in S1 binds a port; T-040's launcher serves the app on `http://localhost` (D70) and calls `migrate(pool)` before it does. All database access goes through `db/repositories.ts` with parameterized queries. Do not interpolate IDs, tokens or user text into SQL. A transaction starts at the repository/service boundary, never in a route handler.

Run middleware in this order on the four S1 routes:

1. Generate a 32-hex-character `traceId` from the injected random source and start a monotonic timer. Log one `http_request` line with `traceId`, `method`, `route` (= `operationId`), `httpStatus`, `durationMs` and, on error, `czarCode` and `retryable` (§3 Logging). Never log the request body, URL query, token, pairing code, goal, device name or address.
2. Validate the request in `http/validate.ts`:
   - POST: require `Content-Type: application/json`, parse JSON, then run `apiContracts.get(operationId).request`. For `submitObjective`, also call `assertNoLocalOnly` (§9.2). Unknown fields are rejected by the schemas.
   - Parameters, which T-009 does not check: `Idempotency-Key` is a UUID v4; path `objectiveId` matches `^obj_[0-9A-HJKMNP-TV-Z]{26}$`; `status` is one of the `ObjectiveStatusValue` enum; `limit` is an integer from 1 to 200, default 50; `cursor` is at most 512 characters.
   - Keep these rules as named constants. Test `params_matchOpenApi` reads the same values with `resolveReference` (for example `"#/components/parameters/Limit"`, `"#/components/schemas/ObjectiveStatusValue"` and the inline `getObjective` path parameter) and fails if the two drift.
3. Authenticate `DeviceToken` on objective routes (§8). Pairing is unauthenticated because the code is the credential. Keep `AppSession` verifier available to later route modules, but do not register an app route in S1.
4. Apply the appropriate rate limit (§7): a paired device uses its device ID; pairing uses one global `pair` bucket (§7.3); an invalid bearer uses the presented token's digest as a provisional principal so repeated failures count. Emit the three specified `RateLimit-*` headers on success and failure, including 401 and 429.
5. On creating POSTs, validate `Idempotency-Key` as UUID v4 and enter the atomic replay guard (§7). `pairDevice` stores no replayable response (§7.1). Treat malformed or missing keys as `400 validation`.
6. Run the handler. Before committing an idempotent response, check it with `validateRecordedExchange(operationId, {requestBody, responseStatus, responseBody})`; if it is invalid, roll back and return `503 upstream-unavailable` (a server bug must never be stored as a replayable answer). Success bodies use `application/json`; problems use `application/problem+json`.
7. Map failures to a fixed RFC 9457 `application/problem+json` response (§10). Never expose raw SQL errors, stack traces, schema payloads or user input in `detail`.

No health endpoint in S1 (T-040 adds it). `migrate(pool)` throws on an edited or failed migration, so a launcher that calls it cannot start on a bad schema; there is no in-memory fallback. Graceful shutdown belongs to T-040's launcher; S1's only obligation is that every transaction is short and never awaits network I/O. Reserve outbox names for later event owners; S1 emits only `objective.received` and does not predefine an unapproved event vocabulary.

## 7. Idempotency, pagination and rate limits

### 7.1 Idempotent POST transaction

For `submitObjective`, compute `fingerprint = SHA-256(raw request-body bytes)` after JSON parsing and schema validation. The scope is `operationId + authenticated deviceId`; pairing uses a separate unauthenticated scope keyed by the pairing code's digest. The fingerprint stores no text. A byte-identical body is the same request; a body with changed bytes is different. Test both reordered JSON keys and exactly repeated bytes so the behavior is explicit. The idempotency key remains valid for `api.idempotencyTtlHours = 24` hours.

Within one PostgreSQL transaction:

1. Insert `(scope,key,fingerprint,status=NULL,expires_at)` with `ON CONFLICT DO NOTHING`.
2. `SELECT ... FOR UPDATE` the row. A concurrent request waits for the first transaction. If the existing fingerprint differs, return `409 idempotency-conflict`. If it matches a complete row, return the original status and stored body without running the handler again.
3. If it is new, run the domain insert and outbox insert in that transaction; validate the response; store the status, body and SHA-256 body hash; commit. If the handler fails, roll back the row and domain effects together, then return the mapped problem. A retry may safely start over.

For a 204, store `response_body=NULL`; replay the original 204. For future `completeModelCall`, use the spec's `replay-not-stored` exception in its own PRD; do **not** implement a generic proxy now. `pairDevice` rows set `replay_stored = false` and keep `response_body` and `response_hash` NULL. A same-key, same-fingerprint request against such a completed row returns `409 replay-not-stored` (SCR-113); a different fingerprint still returns `409 idempotency-conflict`. The raw device token is never written to this table. A lost first response means the daemon asks the person for a fresh code; that is the intended Phase 1 recovery. The handler must not perform network calls while holding this transaction.

### 7.2 Objective list cursor

Sort by `(created_at DESC, objective_id DESC)`, with a deterministic ID tie-breaker. `limit` defaults to 50 and is 1–200. The optional `status` filter must be one of the eleven `ObjectiveStatusValue` strings. Fetch `limit + 1` rows under `WHERE device_id = authenticated device`. If there is another page, save the last returned pair in `objective_cursors` and return a random opaque `nextCursor`; otherwise return `null`. For the next page use the strict tuple predicate `(created_at,objective_id) < ($last_created_at,$last_id)`. An invalid, expired, wrong-device or wrong-filter cursor is `400 validation` with no row data. A changed `status` query with an existing cursor is rejected rather than silently ignored.

`getObjective` looks up by both `objective_id` and authenticated `device_id`; a foreign or unknown ID is the same 404 response. Neither list nor get returns the stored `submission` or goal. Construct only `ObjectiveStatus` (`objectiveId`, canonical `status`, optional plan summary/envelope/result pointer, `updatedAt`) and validate it through T-009. Do not return a null optional field the schema omits.

### 7.3 Rate limit

Use one-minute UTC buckets in `rate_limit_buckets`, updated with one atomic `INSERT ... ON CONFLICT DO UPDATE` statement. The device surface uses `api.rateLimitDaemonPerMin = 600` per device. App-session middleware, used by later T-081 handlers, uses `api.rateLimitAppPerMin = 120` per session. The unauthenticated pairing route uses one global bucket: surface `pair`, principal `SHA-256("pair")`, limit `api.rateLimitAppPerMin`. A per-address bucket would be meaningless in Phase 1: every caller reaches the Mac over loopback (D70), and `app.request()` in tests has no address at all. A global bucket also caps code guessing at 600 attempts per 5-minute code against 10^8 possible codes. Stage 2 cloud hosting revisits this. For an invalid bearer, apply the daemon limit to its digest before returning 401; do not treat it as an authenticated device. No new configurable threshold is added. Count every attempt associated with a rate principal, including failed authentication and idempotent replay. The headers report the configured limit, remaining count clamped to zero, and seconds to the next bucket. A request beyond the limit returns `429 rate-limited`, `retryable: true`.

DB-backed buckets are intentional: a restart or two local server processes must not reset the rate limit. Test the exact boundary (600th succeeds, 601st fails on the daemon surface; 120th succeeds, 121st fails on the pair bucket and on a seeded app session), reset at the next minute and header values with a fake clock.

## 8. Authentication and pairing

### 8.1 Device-token middleware

A newly issued bearer token is 32 cryptographically random bytes encoded base64url. Store only its SHA-256 digest in `devices.token_hash` and return the raw token only in the first `201 PairResponse` (SCR-113). Compare digests using a constant-time operation once a candidate row is found. The daemon stores the token in its OS keychain (T-061); S1 never writes it to disk, env, log or task report. A missing/malformed/unknown token gets a generic 401 problem; a known revoked token gets `401 device-revoked`. Put `{deviceId,userId}` in the request context only after a successful lookup. Every objective query uses the device ID even when two devices belong to one user, because OpenAPI says `listObjectives` lists *this device's* objectives.

The internal `issuePairingCode(userId)` service draws a uniform integer in [0, 10^8) from the injected random source (rejection sampling, no modulo bias) and left-pads it to 8 digits, stores only its SHA-256 digest and a five-minute expiry from `app.pairingCodeTtlMinutes`, and returns the code once to its caller. If the digest already names an unexpired code, retry generation. It has no HTTP route in S1. `pairDevice` validates the code's shape and request schema, locks the matching row, checks not expired/used, creates a new `dev_` ID and token, inserts the device, marks the code used and commits together. Generate `dev_` IDs as 26-character Crockford ULIDs: 48-bit millisecond timestamp followed by 80 CSPRNG bits, encoded in `0123456789ABCDEFGHJKMNPQRSTVWXYZ`; reject clock values outside the 48-bit range and rely on the database primary key to reject a vanishingly unlikely collision. Test prefix, alphabet, fixed length, timestamp boundary and uniqueness under an injected clock/random source. Code reuse, invalid code and expired code return the same safe problem body; do not reveal which condition occurred. The successful body is exactly `{deviceId, deviceToken}`; after SCR-113 `PairResponse` has no `expiresAt`, and the token is valid until revoked.

### 8.2 App-session verifier foundation

T-081 owns `createSession` and challenge verification. S1 creates the `sessions` table and a verifier middleware that accepts a hashed bearer token, checks the user and 24-hour expiry (`app.sessionHours`), and refreshes expiry on use as spec 02 §9.1 requires. S1 tests it with **seeded test sessions**. Do not accept a client-supplied user ID, do not create sessions from a device token, and do not add a production challenge or session route in S1. The browser stores the eventual session token in session storage, not a cookie by default.

## 9. Objective lifecycle and route algorithms

### 9.1 State guard and outbox

Implement the one enum from OpenAPI: `received`, `planning`, `no-supplier`, `awaiting-approval`, `opening`, `executing`, `replanning`, `delivered`, `failed`, `expired`, `dismissed`. The SQL CHECK in §5 and a test comparing the application enum with OpenAPI must fail if either drifts. Define only the transitions shown in CZ-12 §5:

| From | Allowed to | Trigger owner |
|---|---|---|
| new | `received` | `submitObjective` |
| `received` | `planning` | future planner queue consumer |
| `planning` | `no-supplier`, `awaiting-approval`, `opening` | future CZ-13 result |
| `awaiting-approval` | `opening`, `expired`, `dismissed` | later approval/expiry/dismissal |
| `opening` | `executing`, `awaiting-approval` | later CZ-19 event or timeout |
| `executing` | `delivered`, `replanning`, `failed` | later step/result owners |
| `replanning` | `awaiting-approval`, `executing` | later revised plan |

Terminal states have no outgoing transition in S1. The transition repository uses `UPDATE ... WHERE objective_id=$1 AND state=$expected RETURNING ...` to avoid lost updates; zero rows is a conflict or missing-object result, never a silent success. It writes the status and relevant outbox row in one transaction. The outbox payload contains IDs/hashes/state only; no goal, plan body or token. S1 inserts `objective.received`; no worker consumes it until S3. Do not mark an objective `planning` before a planner actually accepts it.

### 9.2 `POST /v1/objectives` (`submitObjective`)

1. Require DeviceToken, UUID v4 idempotency key and JSON body. Validate against T-009's operation schema, then call `assertNoLocalOnly(body, "objective-submission")` from `@czar/schemas` (merged in PR #25). It validates the schema and rejects any `local-only` field in one call; map its `SchemaValidationError` and `LocalOnlyFieldError` to `400 validation`. Types come from `@czar/schemas` (`ObjectiveSubmission`, `TaskSpec`). Ensure `body.deviceId === authenticated.deviceId`; a mismatch is `400 validation` and does not reveal another device.
2. Use the corrected `@czar/hashing` functions to recompute `taskSpecHash` and `objectiveHash` exactly as spec 02 §5.2: observation hashes sorted ascending, capabilities in supplied order, absent `deadline` omitted, `goal` as redacted text, and `taskSpecHash` included. A mismatch is `422 hash-mismatch`; no row or event is inserted. Do not trust a submitted hash for storage without recomputation.
3. Inside the idempotency transaction, check global uniqueness of `objectiveId`. The same ID from a different device is rejected without disclosing the other record. Never overwrite an objective on conflict. Insert `objectives` with `state='received'`, full validated submission JSONB, authenticated user/device IDs and recomputed hash. Insert `objective.received` in `outbox_events` with `objectiveId` and hash only.
4. Return `202 ObjectiveStatus` with `status='received'` and UTC `updatedAt`. A byte-identical retry returns the same body and original `updatedAt`, with no second outbox row.

### 9.3 `GET /v1/objectives` (`listObjectives`)

Authenticate, validate `status`, `cursor` and `limit`, run the keyset query in §7.2 and return `{items,nextCursor}`. Filter by the token's **device**, not merely its user. Never include `submission` JSON, other devices' rows, plan JSON, or result body. Validate both the page and every `ObjectiveStatus` with T-009.

### 9.4 `GET /v1/objectives/{objectiveId}` (`getObjective`)

Authenticate and validate the path ID. Query by `(objective_id,device_id)`. Return a schema-valid `ObjectiveStatus` or a uniform 404 problem. `planSummary`, `envelopeRef` and `resultId` are present only when the corresponding later task has stored them; S1 does not invent empty placeholders.

### 9.5 Retention and data handling

Goal text is stored only in the validated `submission` and must be deleted after `api.goalRetentionDays` (365, SCR-115) as CZ-12 §8 and spec 01 §11.1 require. `purgeExpiredGoals(pool, now)` removes the `goal` key from historical submission JSONB after that period while preserving `objective_id`, `objective_hash`, state and audit/event references. It does not revalidate a redacted historical row as a fresh `ObjectiveSubmission`. Tests advance a fake clock and show the goal is removed while `getObjective` still works. Merchant bodies are not stored by S1; their 30-day policy belongs to S7. Never log `submission`, `goal`, pairing codes, bearer tokens, plan bodies or future result text.

## 10. Error and failure matrix

Every problem is `application/problem+json` with `type = https://czar.dev/problems/<czarCode>`, short fixed `title`, numeric `status`, a fixed safe `detail` (or omit), `czarCode`, `retryable`, and optional safe `instance` path without query. Use only codes in spec 02 §9.4. Validate every body against OpenAPI `Problem`.

| Condition | HTTP / `czarCode` | Retryable | State effect |
|---|---|---|---|
| malformed JSON, wrong content type, schema/param/UUID error, `local-only` extra field | 400 `validation` | false | none |
| absent, malformed or unknown bearer | 401 `validation` | false | none |
| valid but revoked bearer | 401 `device-revoked` | false | none |
| foreign or missing objective | 404 `validation` | false | none |
| same key, different request body | 409 `idempotency-conflict` | false | none |
| duplicate objective ID from another device | 409 `validation` | false | none |
| objective hash differs | 422 `hash-mismatch` | false | none |
| rate bucket exceeded | 429 `rate-limited` | true | none |
| PostgreSQL unavailable | 503 `upstream-unavailable` | true | transaction rolls back; daemon may queue |
| pair retry after token returned (same key, same body) | 409 `replay-not-stored` | false | no new token, nothing re-revealed |

For unexpected errors, log only allowlisted metadata (`route`, `traceId`, `httpStatus`, `czarCode`) and return `503 upstream-unavailable` without raw exception text. A database outage must not leave an objective without its outbox row or an idempotency row falsely claiming success. `migrate` throws if Postgres is unreachable or a migration fails; there is no in-memory fallback.

## 11. Tests to write before the route implementation

Rules for the whole suite:

- **Time.** Every timestamp that drives logic (`expires_at`, `updated_at`, buckets, cursor and retention cutoffs) is written from the injected `clock`, never from SQL `now()`. Column `DEFAULT now()` is a backstop only. This is what makes fake-clock tests valid against a real database.
- **Randomness.** IDs, tokens, codes, cursors and trace IDs come from the injected `random` source so tests are deterministic.
- **Database.** `test/db.ts` connects to the fixed test URL `postgres://postgres@127.0.0.1:15432/postgres`, creates a fresh database per test file (`czar_t_<random hex>`), runs `migrate`, and drops it in `afterAll`. Vitest runs files in parallel, so files never share a database. If the server is unreachable, fail with one clear message naming `apps/server/test/compose.yaml`; never skip.
- **Fixtures.** Start from `docs/specs/02-data-and-protocol/examples/objective-submission.example.json`, set `objectiveId`/`deviceId` from the fixture device, and **recompute `objectiveHash`** with the corrected `@czar/hashing`; the example's stored hash was not computed with `taskSpecHash`.
- **Contracts.** Route tests call the in-process app with `app.request()` and assert `validateRecordedExchange(...).valid === true` for every request and response, including errors. They also assert `Content-Type` and the three `RateLimit-*` headers directly, because T-009 does not check headers.
- No chain, RPC, wallet, Circle or model service appears in this suite.

### 11.1 Migration and repository tests

| Test | Exact behavior to prove |
|---|---|
| `migration_appliesOnce_andRejectsEditedFile` | First run creates every table and records a hash; second run is a no-op; changing an applied file makes `migrate` throw. |
| `migration_atomicOnFailure` | A failing SQL migration leaves no half-created table or success marker. |
| `deviceToken_onlyDigestStored` | Search DB rows and the logger sink; neither contains the raw bearer. Revocation blocks the token immediately. |
| `pairCode_singleUseAndFiveMinuteExpiry` | Valid code pairs once; a second attempt or one after five minutes cannot issue a second device. Check leading-zero code and concurrent requests. |
| `objectiveInsert_atomicWithOutbox` | One successful submission creates one objective and one `objective.received`; injected failure before commit creates neither. |
| `objectiveId_globalUniqueAcrossDevices` | A second device cannot take over or overwrite an ID, even under concurrency. |
| `objectiveStatus_onlyCanonicalValuesStored` | Every stored state equals one of OpenAPI's eleven values; underscore and former API-only values fail both service and SQL checks. |
| `state_rejectsIllegalTransitionAndRace` | Each allowed transition succeeds once; stale expected state and terminal-state transitions fail without an outbox duplicate. |
| `retention_removesGoalAfterOneYear` | Old goal is removed without deleting hash/status/audit; a recent goal remains. |

### 11.2 Idempotency, auth, rate and pagination tests

| Test | Exact behavior to prove |
|---|---|
| `idempotency_sameKeySameBytes_replaysOriginal202` | Body and timestamp match the first response; one objective and one outbox event. |
| `idempotency_sameKeyDifferentBody_409` | No second objective; safe problem response. Include reordered JSON property bytes to document the chosen byte-fingerprint rule. |
| `idempotency_concurrentSameKey_oneCommit` | Two simultaneous requests cannot produce two rows/events; the second sees the committed result. |
| `idempotency_expiredKey_canBeReused` | After 24 h, a new request may use the key; normal `objectiveId` uniqueness still prevents duplicate IDs. |
| `pairReplay_neverReturnsBearer` | Same key and body after success → `409 replay-not-stored`; different body → `409 idempotency-conflict`; the raw token is in no table and no second response. |
| `auth_unknownRevokedAndForeignDevice` | Unknown/revoked tokens fail safely; a valid token cannot list/get another device's objective. |
| `appSession_seededExpiryAndRefresh` | A seeded 24 h session authenticates, refreshes on use and is rejected after expiry; no session creation route exists in S1. |
| `rateLimit_daemon600_app120_andReset` | Exact boundary, 429 problem, retryable flag and all three headers; restart preserves the bucket. |
| `cursor_stableOrderAndDeviceBinding` | Two same-time rows use ID tie-breaker; no duplicates across pages; foreign/expired/filter-mismatched cursors fail safely; default/max limits. |
| `postgresUnavailable_503NoPartialWrite` | Closing the pool before a POST returns 503; after recovery, retry inserts once. |

### 11.3 Route contract and privacy tests

| Test | Exact behavior to prove |
|---|---|
| `pairDevice_openapiRequestAnd201Response` | Request/response pass T-009; invalid platform/name/code and missing UUID fail. The `201` body has exactly `deviceId` and `deviceToken`. |
| `submitObjective_openapi202` | Valid full submission including `TaskSpec` returns only `ObjectiveStatus`. |
| `submitObjective_tamperedGoalOrSubject_422` | Change either without recomputing hash; both fail with no DB/outbox write. This test must fail against the inspected old `@czar/hashing` implementation until S1-P1 is fixed. |
| `submitObjective_localOnlyOrDeviceMismatch_400` | Extra `evidence`, path/email/hook fields or another `deviceId` are rejected, not stripped and persisted. |
| `listObjectives_openapiPage` | Status filter, limit and cursor response validate; `nextCursor` is null on the last page. |
| `getObjective_openapi200Or404` | Own row validates; foreign/missing IDs both return the same 404 shape. |
| `problem_allS1ErrorsMatchOpenAPI` | Required fields, `application/problem+json`, safe fixed detail and stable code for each error class. |
| `privacy_logsNeverContainSensitiveCorpus` | Inject goal text, fake secret, pairing code, device token, email and a file path; none appears in stdout/stderr, log sink or error `detail`. |

Follow the repository's testing rule: verify that the tampered-goal and tampered-subject tests fail against a deliberately broken hash check, then restore the correct code. The idempotency race and transaction failure tests must use real PostgreSQL transactions rather than mocked repository logic.

## 12. Build sequence for the assigned builder

Do the steps in order. Each step writes its failing tests first.

0. **Gate and hashing fix.** Confirm every row of §2.1: `packages/schemas` and `packages/api-contract` exist with passing tests, and `openapi.yaml` already carries the SCR-113 and SCR-115 changes (no `expiresAt` in `PairResponse`; `401`/`503` on the four routes; `api.cursorTtlMinutes` and `api.goalRetentionDays` in `@czar/config`). If any row is false, stop and report which. Then fix S1-P1 in `@czar/hashing`: write the subject-label vector test, watch it fail, add `taskSpecHash` and include it in `objectiveHash`, update the existing `named.test.ts` expectations, run `pnpm --filter @czar/hashing test`. Run `pnpm lint` and `pnpm -r typecheck` to record any pre-existing failures.
1. **Package and SQL.** Create the package (§3), add pinned dependencies, run `pnpm audit --audit-level=moderate`. Write `0001-cz12.sql`, `test/db.ts` and the migration tests; implement `migrate` and the repository layer.
2. **HTTP boundary.** Write contract tests for the four `operationId`s with `validateRecordedExchange`, plus `params_matchOpenApi`. Implement `createApp`, the middleware pipeline (§6), RFC 9457 mapping, rate headers and allowlisted logging. Register only the four routes.
3. **Authentication and pairing.** Write the single-use, expiry, replay and concurrency tests; implement token hashing, `issuePairingCode`, pair consumption, device auth and seeded app-session verification.
4. **Objectives.** Write status, replay, hash, device-isolation, cursor and retention tests; implement the state guard, atomic submission plus outbox insert, keyset pagination, the get route and `purgeExpiredGoals`.
5. **Full local run.** Run every command in §13 on Zaryab's Mac (OrbStack provides Docker) and paste the output. GitHub CI is not used for this project; do not edit `.github/workflows/` or wait for CI.
6. **Adversarial pass.** Run the malformed-body, foreign-device, same-key race, DB outage and privacy-corpus tests. Search the log sink and every table for a raw token, code or goal. Re-read each changed file for unused code and undocumented behaviour.
7. **Task report** (format in `CLAUDE.md`): files, exact commands and pass/fail counts, dependency versions and audit output, the Postgres image digest used, SCRs filed, limitations. Do not mark T-041 done while any §13 box is unchecked.

## 13. Commands and definition of done

**Test database.** `apps/server/test/compose.yaml` runs one service: image `postgres:16.15@sha256:<digest>`, port `127.0.0.1:15432:5432`, `POSTGRES_HOST_AUTH_METHOD: trust`, `tmpfs: /var/lib/postgresql/data`, healthcheck `pg_isready -U postgres`, no named volume. Resolve the digest once with `docker buildx imagetools inspect postgres:16.15` (multi-arch index digest) and pin it in `compose.yaml`. Trust auth is allowed **only** for this loopback, tmpfs, throwaway test server: it holds no credential and no product data. T-040's product database uses its own authentication.

**CI.** Not used. All verification is the local command run below.

**Local machine.** Docker must be running on Zaryab's Mac; OrbStack is installed and provides `docker compose` and `docker buildx`. If `docker info` fails, stop and ask.

Commands from the repo root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @czar/hashing test
pnpm --filter @czar/config test
pnpm --filter @czar/logging test
pnpm --filter @czar/schemas test
pnpm --filter @czar/api-contract test
docker compose -f apps/server/test/compose.yaml up -d --wait
pnpm --filter @czar/server typecheck
pnpm --filter @czar/server test
(cd apps/server && node -e "import('@czar/server').then(() => console.log('server package loads under node'))")
pnpm lint
pnpm -r typecheck
docker compose -f apps/server/test/compose.yaml down
```

No pass count is prewritten; the task report records the actual counts. T-041 is done only when:

- [ ] §2.1 gate held at start; S1-P1 fixed in `@czar/hashing` with the subject-label vector; S1-P3 and S1-P7 recorded as open for their owners.
- [ ] The migration is replay-safe, rejects an edited applied file, is atomic on failure, and creates exactly the tables in §5.
- [ ] The four routes pass their T-009 contracts and T-041's three named checks: pair/submit/list/get; same-key replay and different-body `409 idempotency-conflict`; tampered goal `422 hash-mismatch`.
- [ ] Pair replay returns `409 replay-not-stored` and never a second token; `PairResponse` has no `expiresAt`.
- [ ] `ObjectiveSubmission` rejects local-only extras; one outbox event accompanies one stored objective; `objectiveStatus_onlyCanonicalValuesStored` passes.
- [ ] Device isolation, single-use pairing, token hashing, 24-hour idempotency, cursor expiry, retention and rate-limit boundaries pass, all read from `@czar/config`.
- [ ] Database-outage and concurrent-retry tests prove no partial write or duplicate event; no bearer, code or user text appears in logs or problem bodies.
- [ ] `@czar/server` imports under plain `node` (the load check above), not only under Vitest.
- [ ] `pnpm lint`, `pnpm -r typecheck` and the full §13 command list pass locally with zero warnings. The task report contains the outputs.

## 14. Handoff to later server PRDs

- **T-040** wires the launcher: serves `createApp` on `http://localhost`, calls `migrate(pool)` first, adds the health endpoint, schedules `purgeExpiredGoals`, and owns graceful shutdown and the product Postgres container.
- **S2/S3 (planner)** consume objective rows and `objective.received` from the outbox; they own the planner worker and `plan.ready`. T-045's preflight must fix S1-P7 (`planHash` missing `taskSpecHash` and `callInputsHash`).
- **S6** owns execution state and writes `step_executions`. **S7** owns result storage and the 30-day body retention.
- **T-081** adds `createSession` and the app read routes to the same app factory once the challenge contract exists; **T-061** uses the finished `pairDevice`; **T-082** needs the S1-P3 pairing-code issuance contract.
- Later work adds new migrations and route modules and keeps S1's auth, validation, error, idempotency and transaction rules. None may bypass the transaction boundary or re-implement schema validation.

**Stop conditions:** any §2.1 row is false; a T-006/T-009 export differs from what this PRD assumes; a new route, field, status or config key would be needed; or a sensitive value appears in a log. File an SCR for a spec gap, continue only unaffected work, and never loosen an acceptance test.

## Appendix A. Spec changes to apply before the build (SCR-113, SCR-115)

These are the exact edits. Zaryab accepts the SCRs; the architect (or Zaryab) applies them to the canonical files and to `@czar/config`. The T-041 builder does not make them.

**1. Pair replay (SCR-113, S1-P2).**
- `data-and-protocol.md` §9.3, after the RV-043 bullet, add: "**Exception (SCR-113):** `POST /v1/devices/pair` never stores or replays its response, because the device token is shown once (AM-18). The server stores the key and fingerprint only. The same key and same body after a successful pair returns `409 replay-not-stored`; a different body returns `409 idempotency-conflict`. A daemon that lost the first response asks the person for a new pairing code."
- `openapi.yaml` `pairDevice` `description`: append "Retrying with the same `Idempotency-Key` after success returns 409 `replay-not-stored`; the token is never sent twice (SCR-113)."
- `IdempotencyKey` parameter `description`: append "Exceptions: `pairDevice` and `completeModelCall` return 409 `replay-not-stored` instead of replaying (02 §9.3)."

**2. Device-token lifetime (SCR-113, S1-P4).**
- `openapi.yaml` `PairResponse`: `required: [deviceId, deviceToken]`; delete the `expiresAt` property.
- `data-and-protocol.md` §9.1 daemon row, after "returns `deviceId` and the token once": add "; in Phase 1 the token has no expiry and is valid until the person revokes the device in the app".

**3. Declared responses (SCR-115, S1-P5).** In `openapi.yaml`:
- `submitObjective`: add `"401": { $ref: "#/components/responses/Problem" }` and `"503": { $ref: "#/components/responses/Problem" }`.
- `listObjectives`: add `"400"`, `"401"`, `"503"` (each `#/components/responses/Problem`), and give the `status` query parameter `schema: { $ref: "#/components/schemas/ObjectiveStatusValue" }`.
- `getObjective`: add `"400"`, `"401"`, `"503"` (Problem) and `"429": { $ref: "#/components/responses/RateLimited" }`.
- `pairDevice`: add `"503"` (Problem).

**4. Config keys (SCR-115, S1-P6).** In `server-planning-and-payment.md` CZ-12 §5 "Parameters" and in `packages/config/src/registry.ts`:
- `api.cursorTtlMinutes` = 60 — "opaque list cursors expire after 1 h (02 §9.5)".
- `api.goalRetentionDays` = 365 — "objective goal text is deleted after 1 year (01 §11.1, CZ-12 §8)".

**5. Not changed now (S1-P3).** Public pairing-code issuance and the WebAuthn challenge route are specified before T-081/T-082, not here.
