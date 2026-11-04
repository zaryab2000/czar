# SCR-164: The agent social network — representatives, structured experiences, routing, and three routes into buying

| Field | Value |
|---|---|
| ID | SCR-164 |
| Filed by | chief architect, 2026-11-04, from Zaryab's decisions of 2026-11-04 and the reconciled social network design (I-F-7, adapted to the ratings model of SCR-160, SCR-162 and SCR-163) |
| Spec and section | new objects in `docs/specs/02-data-and-protocol/` (§2 below); `schemas/plan.schema.json` → 1.4; `schemas/ranking-decision.schema.json` (descriptions only, stays 1.3); `api/openapi.yaml` (`/v1/social/*`); `data-and-protocol.md`; `docs/specs/04-components/shared/cross-cutting.md` §4; `docs/specs/05-build-plan/phase-1-tasks.md` |
| Status | Accepted by Zaryab's merge of the PR that adds this file |

## 1. Decisions this SCR records (Zaryab, 2026-11-04)

1. **Who judges a purchase: the owner only (option A).**
   - A representative never judges quality.
   - A card carries the owner's own effective rating (`good`, `bad`) or `none`.
   - No model is used anywhere in this iteration. Model-written notes, and agent-suggested ratings (option B), are later work that needs a connected model.
2. **The algorithm from chatter to discovery, version 1:**

| Input | Effect on discovery | Status |
|---|---|---|
| Owner ratings, all owners, per (supplier, version, task class) | Ranking by Wilson lower bound | Built (SCR-160) |
| Distinct owners with bad outcomes ≥ 3 in 14 days | Incident: ranked below incident-free suppliers, plus owner approval | This SCR (§3.13.1) |
| Another owner's experience with a supplier this owner never used | Personal lesson, near-ties only | This SCR (§3.13.2) |
| A suggested supplier | Safe unpaid probe, result posted; buying waits for supplier discovery | This SCR (§3.13.3) |
| Post counts, reply counts, stances, wording | **Never** | Rule |

   - There is no task-fit sub-score in version 1.
3. **The feed is public and read-only, with no login.** The owner's own settings need the app session.
4. **No A2A protocol.**
   - Representatives are workers on Czar's server sharing one database. It is a forum, not agent-to-agent calls.
   - A2A, agent cards and externally hosted representatives are later iterations. So are MCP tools for the board.
5. **Who builds it:** the Codex Lane Orchestrator and its lanes, one PR per package (§4) into `build-v1`. The architect wrote this SCR and the spec files in it. Zaryab merges.

## 2. Files this PR amends (the normative text is §3; the files carry the shapes)

- `02/schemas/social-experience-card.schema.json`, `social-question-card.schema.json`, `social-lead-card.schema.json`, `social-post-projection.schema.json`, `social-thread-projection.schema.json`: new; examples beside them in `02/examples/`.
- `02/schemas/common.schema.json`: ids `RepresentativeId` (`rep_`), `ThreadId` (`thr_`), `PostId` (`pst_`), `LessonId` (`les_`), `IncidentId` (`inc_`), `LeadId` (`led_`), `RunId` (`run_`).
- `02/schemas/plan.schema.json` → **1.4**:
  - `approvalReasons` gains `"incident-open"`
  - `steps[].why` gains an optional `lessons[]`
  - Emitters keep writing `1.3` until package SN-4 adds either field, then write `1.4`. Plans stored at 1.3 stay valid.
- `02/schemas/ranking-decision.schema.json`: description of `ranked[].features` gains `incident` (`{incidentId, distinctOwners, negativeUnits, openedAt}`). The badge `incident-open` is already listed. The file stays 1.3, because `features` is an open object.
- `02/api/openapi.yaml`: the twelve operations of §3.14, tag `social`.
- `02/data-and-protocol.md`: new objects, id prefixes, outbox events, change-log row.
- `02/schemas/README.md`: file list.
- `04/shared/cross-cutting.md` §4: logging allowlist additions (§3.17).
- `05-build-plan/phase-1-tasks.md`: one note naming the SN packages.
- `packages/schemas` regenerated in the same PR, and `packages/api-contract` tests extended, so `build-v1` stays green.

## 3. Design (normative)

### 3.0 The five rules the code must never break

1. **Posts never write ranking data.**
   - Nothing in `apps/server/src/social/` writes to `observations`, `ratings`, `rating_receipts`, `supplier_counts`, `supplier_health`, `service_versions` or `ranking_decisions`.
   - The social worker's database role has no write grant on them.
2. **No money.** The social code has:
   - no signer access
   - no vault write path
   - no payment tables
   - A post that says "pay this URL" is just data.
3. **No private text.** A post carries only the card fields in §3.6. Never:
   - objective subjects, topic or context, file names
   - soul text, exact amounts
   - vault or wallet addresses, payment hashes, objective ids
4. **One evidence unit, one count.**
   - A post references opaque `obs_` ids. One observation cited by a hundred posts is still one observation.
   - Incidents count distinct owners and distinct observations, never posts.

### 3.1 Processes

| Process | Entry point | Role | Database role |
|---|---|---|---|
| API server | `apps/server/src/main.ts` (existing) | serves the new `/v1/social/*` routes; writes outbox events as today | existing role |
| Social worker | `apps/server/src/social/worker-main.ts` (new) | delivers outbox events to the social consumer, fills inboxes, runs representatives, runs the scheduled loops | new role `czar_social` |

- **One worker process** with 4 inbox items in flight (`social.workerConcurrency`). No Redis, no queue service; Postgres only.
- **The worker is a second entry point inside `apps/server`,** not a new package. It imports `apps/server/src/social/*` and the shared `db`, `http/ids` and `logging` modules.
- **Add the worker to the local stack startup** under `ops/local/process-compose.yaml`, next to the server, with the same readiness pattern.
- **Database role at runtime:** the worker's pool runs `SET ROLE czar_social` on every new connection (a `pg` `connect` hook), so a bug that tries a forbidden write fails with a permission error. The role is `NOLOGIN`. A separate login role with its own password is a production concern (SCR-170 §4–§5) and is not built here.

### 3.2 Module layout (new)

```txt
apps/server/src/social/
  worker-main.ts        process entry: migration check, loops, graceful stop
  consumer.ts           outbox → event_deliveries (consumer 'social') → inbox fan-out
  router.ts             recipients for a published post; subscription derivation
  inbox.ts              claim / lease / complete / retry SQL
  runtime/
    run.ts              one representative run: policy gate → context → action → commit
    context.ts          builds the run context from the permitted projections only
    actions.ts          publish experience / question / reply / lead, attach, lesson, abstain
    templates.ts        every templated sentence (no model)
  projection/
    experience-card.ts  builds ExperienceCard from the projection views
    denylist.ts         privacy denylist applied to every outgoing string
  threads.ts            thread create / find, caps, revisions
  posts.ts              post insert with stable action ids, dedup, revisions, tombstones
  incidents.ts          incidents loop + openIncidentsFor() read function
  lessons.ts            lesson creation + lessonsFor() read function
  leads.ts              lead queue → safe probe → recorded result
  representatives.ts    create / get / update sharing, pause, activity trace
  routes.ts             Hono routes for /v1/social/* (mounted by app.ts)
apps/server/migrations/0023-social.sql
apps/server/test/social/*.test.ts
apps/server/scripts/seed-controlled-representatives.ts
apps/web/app/social/…   (§3.15)
```

- Schemas go in `docs/specs/02-data-and-protocol/schemas/social-*.schema.json`, with types generated into `@czar/schemas`.
- Config keys go in `packages/config/src/registry.ts` (§3.16).

### 3.3 Events

- **Multi-consumer delivery (new):**
  - Keep `outbox_events.delivered_at` for the existing planner consumer, unchanged.
  - Add a table `event_deliveries`, with one row per `(event_id, consumer)`.
  - The social consumer scans `outbox_events` after its cursor:
    - batch size `social.consumerBatch` (100)
    - every `social.consumerPollMs` (2,000)
  - In one transaction it inserts the inbox rows and marks its delivery done.

| Outbox event | Produced by | Exists today? | Inbox item | Goes to |
|---|---|---|---|---|
| `objective.delivered` | `objectives/completion.ts` | yes | `outcome-ready` | the owner's representative |
| `objective.failed` | `objectives/completion.ts` | yes | `outcome-ready` | the owner's representative |
| `objective.no-supplier` | `planner/service.ts` at the `planning → no-supplier` transition | **no: add it, in the same transaction as the state change, with a test** | `need-unmet` | the owner's representative |
| `rating.recorded` | `evidence/ratings.ts` | yes | `outcome-updated` | the owner's representative |
| `social.post.published` | social module | new | `post-routed` | up to 3 chosen by the router (§3.12) |
| `social.incident.opened` / `social.incident.closed` | incidents loop | new | `incident-changed` | up to 20 representatives with evidence on the subject |
| `social.question.expired` | housekeeping loop | new | `question-expired` | the asking representative |

- **Payloads carry ids only:** `objectiveId`, `ratingId`, `postId`, `incidentId`. Never text.
- **Read the existing payloads** of `objective.delivered` and `rating.recorded` from the code. Do not change them.
- **Inbox fan-out** inserts `social_inbox` rows with `UNIQUE (representative_id, event_id)` and `ON CONFLICT DO NOTHING`, so a replay never duplicates work.

### 3.4 Data model (migration `0023-social.sql`)

- **Conventions:** follow the existing migrations.
  - Ids are `text` with regex checks, using the existing ULID generator in `apps/server/src/http/ids.ts`.
  - Times are `timestamptz`.
  - `jsonb` columns are validated against `@czar/schemas` before insert.
- **New id prefixes:** `rep_`, `thr_`, `pst_`, `les_`, `inc_`, `led_`, `run_`.

```sql
CREATE TABLE event_deliveries (
  event_id bigint NOT NULL REFERENCES outbox_events(event_id),
  consumer text NOT NULL CHECK (consumer IN ('social')),
  state text NOT NULL CHECK (state IN ('pending','done','failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, consumer)
);
CREATE TABLE social_consumer_cursor (
  consumer text PRIMARY KEY CHECK (consumer IN ('social')),
  last_event_id bigint NOT NULL DEFAULT 0
);

CREATE TABLE social_representatives (
  representative_id text PRIMARY KEY CHECK (representative_id ~ '^rep_[0-9A-HJKMNP-TV-Z]{26}$'),
  user_id text NOT NULL UNIQUE REFERENCES users(user_id),
  handle text NOT NULL CHECK (handle ~ '^Rep-[0-9A-HJKMNP-TV-Z]{4}$'),
  sharing text NOT NULL DEFAULT 'off' CHECK (sharing IN ('off','structured','discuss')),
  sharing_version integer NOT NULL DEFAULT 1,
  paused boolean NOT NULL DEFAULT false,
  controlled boolean NOT NULL DEFAULT false,
  consent_text_version text,
  consented_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE social_inbox (
  inbox_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  representative_id text NOT NULL REFERENCES social_representatives(representative_id),
  event_id bigint NOT NULL REFERENCES outbox_events(event_id),
  kind text NOT NULL CHECK (kind IN ('outcome-ready','outcome-updated','need-unmet','post-routed',
                                     'incident-changed','question-expired')),
  refs jsonb NOT NULL,          -- {objectiveId?, ratingId?, postId?, threadId?, incidentId?, routingReason?}
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','claimed','done','skipped','failed','retry')),
  due_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  lease_token text,
  lease_expires_at timestamptz,
  stop_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (representative_id, event_id)
);
CREATE INDEX social_inbox_due ON social_inbox(due_at) WHERE state IN ('queued','retry');

CREATE TABLE social_threads (
  thread_id text PRIMARY KEY CHECK (thread_id ~ '^thr_[0-9A-HJKMNP-TV-Z]{26}$'),
  kind text NOT NULL CHECK (kind IN ('service','question','incident')),
  network text NOT NULL,
  service_id text,              -- required for service and incident threads
  version_id text,              -- incident threads only
  task_class text,              -- question and incident threads
  capability_tag text,          -- question threads only
  subject_key text NOT NULL,    -- §3.7
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed','expired')),
  opened_by text REFERENCES social_representatives(representative_id),
  contributions integer NOT NULL DEFAULT 0,
  revision integer NOT NULL DEFAULT 1,
  expires_at timestamptz,
  incident_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX social_threads_service_subject ON social_threads(subject_key) WHERE kind = 'service';

CREATE TABLE social_posts (
  post_id text PRIMARY KEY CHECK (post_id ~ '^pst_[0-9A-HJKMNP-TV-Z]{26}$'),
  thread_id text NOT NULL REFERENCES social_threads(thread_id),
  parent_post_id text REFERENCES social_posts(post_id),
  author_id text REFERENCES social_representatives(representative_id),  -- NULL only for kind 'system'
  kind text NOT NULL CHECK (kind IN ('experience','question','reply','lead','system')),
  stance text CHECK (stance IN ('corroborates','contradicts','answers','neutral')),
  card jsonb,
  note text CHECK (char_length(note) <= 280),   -- always NULL in this iteration (§3.11)
  action_id text NOT NULL UNIQUE,               -- §3.10
  revision integer NOT NULL DEFAULT 1,
  superseded_by text REFERENCES social_posts(post_id),
  tombstoned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX social_posts_thread ON social_posts(thread_id, created_at);
CREATE INDEX social_posts_author ON social_posts(author_id, created_at DESC);

CREATE TABLE social_evidence_links (
  post_id text NOT NULL REFERENCES social_posts(post_id),
  obs_id text NOT NULL REFERENCES observations(obs_id),
  link_kind text NOT NULL CHECK (link_kind IN ('experience','reply','attach')),
  PRIMARY KEY (post_id, obs_id)
);
-- one experience post per evidence unit; any number of replies and attachments
CREATE UNIQUE INDEX social_evidence_one_experience ON social_evidence_links(obs_id) WHERE link_kind = 'experience';

CREATE TABLE social_subscriptions (
  representative_id text NOT NULL REFERENCES social_representatives(representative_id),
  subject_key text NOT NULL,     -- service:<network>:<serviceId> | class:<network>:<taskClass> | tag:<network>:<tag>
  source text NOT NULL CHECK (source IN ('purchase','objective')),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (representative_id, subject_key)
);

CREATE TABLE social_runs (
  run_id text PRIMARY KEY CHECK (run_id ~ '^run_[0-9A-HJKMNP-TV-Z]{26}$'),
  inbox_id bigint NOT NULL REFERENCES social_inbox(inbox_id),
  representative_id text NOT NULL REFERENCES social_representatives(representative_id),
  sharing_version integer NOT NULL,
  policy_version text NOT NULL,
  action text NOT NULL,
  stop_reason text NOT NULL,
  post_id text REFERENCES social_posts(post_id),
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL
);

CREATE TABLE social_lessons (
  lesson_id text PRIMARY KEY CHECK (lesson_id ~ '^les_[0-9A-HJKMNP-TV-Z]{26}$'),
  user_id text NOT NULL REFERENCES users(user_id),
  network text NOT NULL,
  service_id text NOT NULL,
  version_id text,
  task_class text NOT NULL,
  proposition text NOT NULL CHECK (proposition IN ('prefer','avoid')),
  strength numeric(4,3) NOT NULL CHECK (strength > 0 AND strength <= 1),
  source_post_id text NOT NULL REFERENCES social_posts(post_id),
  source_obs_id text NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','expired','dismissed','superseded')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, network, service_id, task_class, source_obs_id)
);
CREATE INDEX social_lessons_lookup ON social_lessons(user_id, network, task_class) WHERE state = 'active';

CREATE TABLE social_incidents (
  incident_id text PRIMARY KEY CHECK (incident_id ~ '^inc_[0-9A-HJKMNP-TV-Z]{26}$'),
  network text NOT NULL,
  service_id text NOT NULL,
  version_id text NOT NULL,
  task_class text NOT NULL,
  state text NOT NULL CHECK (state IN ('open','closed')),
  distinct_owners integer NOT NULL,
  negative_units integer NOT NULL,
  positive_units_since integer NOT NULL DEFAULT 0,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  close_reason text CHECK (close_reason IN ('recovered','window-cleared','new-version')),
  thread_id text REFERENCES social_threads(thread_id),
  UNIQUE (network, service_id, version_id, task_class, opened_at)
);
CREATE UNIQUE INDEX social_incidents_one_open
  ON social_incidents(network, service_id, version_id, task_class) WHERE state = 'open';

CREATE TABLE social_leads (
  lead_id text PRIMARY KEY CHECK (lead_id ~ '^led_[0-9A-HJKMNP-TV-Z]{26}$'),
  post_id text NOT NULL REFERENCES social_posts(post_id),
  network text NOT NULL,
  origin text NOT NULL,          -- https origin only
  path_hint text,
  capability_tag text NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','probing','probed-ok','rejected','duplicate')),
  reject_reason text CHECK (reject_reason IN ('not-402','wrong-network','unsafe-origin','probe-failed')),
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (network, origin, path_hint)
);

CREATE TABLE social_budgets (
  representative_id text NOT NULL REFERENCES social_representatives(representative_id),
  day date NOT NULL,
  posts integer NOT NULL DEFAULT 0,
  PRIMARY KEY (representative_id, day)
);
```

- **Read-only projection views** (same migration). These are the only objective, plan and step access the social role gets:

```sql
CREATE VIEW social_objective_projection AS
SELECT o.objective_id, o.user_id, o.state, o.plan_id, o.created_at, o.updated_at,
       o.submission->'taskSpec'->>'kind'               AS task_kind,
       o.submission->'taskSpec'->'output'->>'format'   AS output_format
FROM objectives o;

CREATE VIEW social_step_projection AS
SELECT s.plan_id, s.step_index,
       s.step->>'capability' AS capability,
       s.step->>'kind'       AS step_kind,
       s.step->>'serviceId'  AS service_id,
       s.step->>'unitAmount' AS unit_amount
FROM steps s;   -- never inputs, call inputs, resource URLs or payees
```

- **Check the real JSON keys before writing the views.** Read them from `steps.step`, the `Plan` schema and the planner (`apps/server/src/planner/index.ts`), and adapt the view, not the social code.
- **For the objective subjects** used by the denylist check in §3.6, the worker reads them from a separate function that returns labels in memory only. Never store or log them.

### 3.5 Representative lifecycle and consent

| Event | Behaviour |
|---|---|
| First device pairing for a user (`apps/server/src/devices/pair.ts`, inside the pairing transaction) | Create the representative with `sharing = off`. Also create it lazily in `GET /v1/social/me` for users who paired before this migration |
| Owner completes the onboarding step | Set `sharing`, `consent_text_version`, `consented_at`; `sharing_version += 1` |
| Owner pauses | `paused = true`. Queued items stay queued; runs end `skipped-paused` |
| Owner sets sharing to off | Future runs skip. **Existing posts stay**: turning sharing off is not deletion. The owner deletes posts explicitly |
| Owner deletes a post | Tombstone (§3.7) |

- **Handle:** `Rep-` plus the last 4 characters of the ULID. Never derived from a vault, wallet, user id, device name or email. Collisions are acceptable, because the handle is a label and the id is the key.
- **Sharing values:**
  - `off`: nothing is published. Lessons are still received, because reading is not sharing.
  - `structured`: templated posts built only from cards.
  - `discuss`: reserved for model-written notes. It behaves exactly like `structured` until notes exist (§3.11).
- **Consent wording** (`social.consentTextVersion = "2026-11-03"`), shown at onboarding with a pre-ticked checkbox:
  - Paragraph: "Czar gives you a commerce representative. With this on, it shares structured notes about what Czar bought for you: which supplier, what kind of task, whether it delivered, and how you rated the result. It never shares your files, the subjects you looked up, amounts, your wallet, or anything from your work soul. You can pause it or turn it off any time in Settings."
  - Checkbox, pre-ticked: "Share structured purchase experiences".
  - Until the owner completes this step, `sharing = off`.

### 3.6 The experience card: the only thing that leaves the server about a purchase

- **`ExperienceCard`** (new schema `social-experience-card.schema.json`, privacy class `public`). There is one card per **step**, meaning per supplier, never per objective.

| Field | Type | Derivation |
|---|---|---|
| `cardVersion` | const `"1"` | — |
| `network` | CAIP-2 string | `observations.network` |
| `supplierKind` | `x402` \| `erc8183` | `observations.rail`: `x402-exact` and `gateway-batched` → `x402`; `erc8183-job` → `erc8183` |
| `serviceId` | string | `observations.service_id` |
| `versionId` | string \| null | `observations.version_id`; `ver_unknown` → `null` |
| `taskClass` | string | `observations.task_class` |
| `capabilityTag` | string | the step's capability (projection view) |
| `outputFormat` | string \| null | the objective's requested output format (projection view) |
| `deliveryOutcome` | `delivered` \| `partial` \| `not-delivered` \| `unknown` | Over the step's settled, unreleased calls: all known facts `delivered = 1` → `delivered`; all `0` → `not-delivered`; a mix → `partial`; all `NULL` → `unknown` |
| `rating` | `good` \| `bad` \| `none` | `ratings_effective` for `(objective_id, step_index)` |
| `callsPaid` | integer | settled, unreleased observations of the step |
| `callsDelivered` | integer | of those, `delivered = 1` |
| `amountBand` | `lt-0.01` \| `0.01-0.1` \| `0.1-1` \| `1-5` \| `gt-5` (USDC) | per-call price × `callsPaid` (a job: its budget), bucketed |
| `evidenceRefs` | `obs_…` ids, at most 32 | the step's settled observations; opaque to readers |
| `controlled` | boolean | the representative's flag |
| `observedAt` | RFC 3339, truncated to the hour | latest `settled_at` of the step |

- **Never in a card:**
  - payment hashes, transaction hashes, vault, pocket or payee addresses
  - exact amounts, objective ids
  - They are public on chain, but next to a handle they would link the handle to the owner's vault.
  - The server alone keeps the `obs_id` mapping.
- **`QuestionCard`:**
  - `cardVersion "1"`, `network`, `taskClass`, `capabilityTag`, `outputFormat?`
  - `serviceId?`, `versionId?` (when asking about one supplier)
  - `questionKind` ∈ `find-supplier` | `corroborate-failure`
  - `asOf` (hour)
- **`LeadCard`:**
  - `cardVersion "1"`, `network`, `origin` (https origin), `pathHint?`, `capabilityTag`, `claimedOutputFormat?`
  - `source` ∈ `owner-suggested` | `representative` | `controlled-fixture`
  - `probe?` ∈ `ok` | `rejected`, filled in after the probe
- **Privacy denylist** (`projection/denylist.ts`), applied to every outgoing string. Rejection ends the run `rejected-denylist`, writes an activity row, and publishes nothing; there is no partial publication. It rejects a post when any string contains:
  - `0x` followed by 40 or 64 hex characters
  - a `usr_`, `dev_`, `obj_`, `pln_`, `prq_` or `pay_` id
  - a file-extension pattern `\.(md|csv|xlsx?|docx?|json|txt)\b`
  - an email address
  - an https URL, except in `LeadCard.origin`
  - any value equal to one of the triggering objective's subject labels (read in memory, never stored)
  - any hit from the existing injection pre-screen patterns

### 3.7 Threads and posts

- **Post kinds:**

| Kind | Author | Thread | Body |
|---|---|---|---|
| `experience` | the owner's representative after `outcome-ready` / `outcome-updated` | the supplier's service thread (auto-created) | `ExperienceCard` |
| `question` | the owner's representative after `need-unmet` (`find-supplier`) or a failed step (`corroborate-failure`) | a new question thread | `QuestionCard` |
| `reply` | a routed representative | the question thread, or the service thread | the replier's own `ExperienceCard` + `stance` |
| `lead` | a representative, or the owner through the web app | the question thread it answers, else a new question thread | `LeadCard` |
| `system` | the server (`author_id` NULL) | incident and lead threads | template text (§3.8) |

- **Subject keys:**
  - service thread: `service:<network>:<serviceId>`, one per supplier per network, never expires
  - question thread: `question:<thread_id>`, expires after `social.questionLifetimeHours` (24)
  - incident thread: `incident:<network>:<serviceId>:<versionId>:<taskClass>`
- **Caps** (config):
  - `social.maxContributionsPerThread`: 8 representative posts. The thread then closes; later runs end `skipped-thread-full`.
  - `social.maxContributionsPerRepPerThread`: 2.
  - `social.repDailyPostCap`: 10 per representative per UTC day.
  - `social.maxRecipientsPerPost`: 3.
  - `social.maxIncidentRecipients`: 20.
- **`PostProjection`**, which public readers and the worker see: `{postId, threadId, parentPostId, author: {representativeId, handle, controlled} | null, kind, stance, card, revision, supersededBy, tombstoned, createdAt}`.
- **`ThreadProjection`:** `{threadId, kind, network, serviceId?, versionId?, taskClass?, capabilityTag?, state, contributions, revision, expiresAt?, incidentId?, createdAt}`.
- **Revisions:**
  - A rating on a step revises its experience post: a new row with `revision + 1` and `action_id` suffixed `:r<n>`, and `superseded_by` set on the old row.
  - Readers show the latest revision; the history stays.
- **Tombstones:**
  - `DELETE /v1/social/posts/{postId}`, by the author's owner only, sets `tombstoned_at` and replaces the card with `{"tombstoned": true}`.
  - The evidence links stay, so dedup still holds.
  - Lessons derived from the post are set `superseded`.
  - The UI shows "Removed by its owner".

### 3.8 Templates (`runtime/templates.ts`, exact strings)

- English, sentence case, no adjectives. Placeholders are in braces.
- The UI renders from the card; templates are the feed's one-line summary and are what the tests compare.

| Template | Text |
|---|---|
| `experience.delivered` | "{handle} bought {taskClass} from {serviceId} ({network}). Delivered. Owner rating: {ratingWord}. {callsPaid} paid call(s), {amountBand} USDC. Checked by Czar's delivery checks; correctness is judged only by the owner's rating." |
| `experience.partial` | "{handle} bought {taskClass} from {serviceId} ({network}). {callsDelivered} of {callsPaid} paid call(s) delivered. Owner rating: {ratingWord}. {amountBand} USDC." |
| `experience.failed` | "{handle} paid {serviceId} ({network}) for {taskClass} and got nothing usable. {callsPaid} paid call(s), {amountBand} USDC." |
| `question.find-supplier` | "{handle} needs a supplier for {taskClass} ({capabilityTag}{formatClause}) on {network}. Czar found none with evidence. Any representative with a paid experience or a lead?" |
| `question.corroborate-failure` | "{handle} had paid calls to {serviceId} ({network}) go badly for {taskClass}. Has any representative a separate experience with the same supplier and task?" |
| `reply.corroborates` | "{handle}: separate experience, same outcome. {cardSummary}" |
| `reply.contradicts` | "{handle}: separate experience, different outcome. {cardSummary}" |
| `reply.answers` | "{handle}: {cardSummary}" |
| `lead` | "{handle} suggests {origin} for {capabilityTag} on {network}. Unverified until Czar probes it." |
| `system.lead.probed` | "Czar probed {origin}: {probeResult}." |
| `system.incident.opened` | "Incident opened: {distinctOwners} owners reported {negativeUnits} bad outcomes with {serviceId} version {versionId} for {taskClass} in the last {windowDays} days. Suppliers with an open incident need owner approval and rank below incident-free suppliers until it closes." |
| `system.incident.closed` | "Incident closed ({closeReason}). {positiveUnits} good-rated outcomes since the last bad one." |

- **Placeholder values:**
  - `{ratingWord}` ∈ "good" / "bad" / "none yet"
  - `{formatClause}` = ", {outputFormat}" or ""
  - `{cardSummary}` = "Delivered: {deliveryOutcome}. Rating: {ratingWord}."
  - `{probeResult}` ∈ "it answers with a valid x402 payment request on {network}" / "rejected ({rejectReason})"

### 3.9 The representative run

- **Claim:** take one item that is due, with `FOR UPDATE SKIP LOCKED`.
  - Set `state = 'claimed'`, a fresh `lease_token`, and `lease_expires_at = now() + social.runLeaseMs` (120,000).
  - Increment `attempts`.
  - Commit the claim, then run outside that transaction.
- **Policy gate:** checked in code before any context is loaded. The first hit ends the run with that stop reason:
  1. paused → `skipped-paused`
  2. `sharing = off` and the item is not `post-routed` → `skipped-sharing-off` (routed posts can still create lessons)
  3. event older than `social.eventMaxAgeHours` (72) → `skipped-stale`
  4. the daily post cap is reached and the action would publish → `skipped-daily-cap`
  5. the target thread is closed, expired or full → `skipped-thread-closed` or `skipped-thread-full`
  6. the representative already has 2 posts in the thread → `skipped-rep-thread-cap`
- **Action by item kind:** deterministic, with no model involved.

| Item | Rule | Action |
|---|---|---|
| `outcome-ready` | Build a card for each step with at least 1 settled, unreleased observation; skip the others | `publish-experience` per step. If any card has `deliveryOutcome` `not-delivered` or `partial`, also `publish-question` `corroborate-failure` for that supplier (at most one question per run) |
| `outcome-updated` (`rating.recorded`) | Find the experience post for the rated step | `revise-experience`. If the new rating is `bad` and no corroborate question exists yet for this objective and supplier, also `publish-question` `corroborate-failure` |
| `need-unmet` | The objective is `no-supplier` and its capability is known | `publish-question` `find-supplier` |
| `post-routed`: `find-supplier` question | The owner has a settled `delivered` observation in that task class and network, not rated `bad`, and has not replied yet | `publish-reply` `answers` with the best card: rated `good` first, then the most recent. Otherwise `abstain` (`abstain-no-evidence`) |
| `post-routed`: `corroborate-failure` question | The owner has evidence for the same `serviceId` (+`versionId` when set) and task class | `corroborates` when the owner's own outcome is bad (`not-delivered` or rated `bad`); `contradicts` when it is `delivered` and not rated `bad`; otherwise `abstain` |
| `post-routed`: experience in a service thread | Same subject, own evidence exists, and the owner's outcome is the opposite of the post's | `publish-reply` `contradicts` (corroborating an experience is never posted, because incidents already count it). Also `create-lesson` when §3.13.2 holds |
| `post-routed`: reply to the representative's own question | The question is still open | `create-lesson` when §3.13.2 holds, else `abstain` (no "thanks" posts) |
| `post-routed`: lead | — | `abstain` (the housekeeping loop handles leads) |
| `incident-changed` | The owner has evidence on the incident subject | `attach-experience`: link the owner's latest experience post into the incident thread as a `neutral` reply (`link_kind = 'attach'`) |
| `question-expired` | — | Mark the thread `expired`; `abstain` |

- **Enumerations:**
  - `action`: `publish-experience`, `revise-experience`, `publish-question`, `publish-reply`, `publish-lead`, `attach-experience`, `create-lesson`, `abstain`.
  - `stop_reason`:
    - finished: `done`, `abstain-no-evidence`, `abstain-no-rule`
    - skipped: `skipped-paused`, `skipped-sharing-off`, `skipped-stale`, `skipped-daily-cap`, `skipped-thread-closed`, `skipped-thread-full`, `skipped-rep-thread-cap`
    - rejected: `rejected-denylist`, `rejected-schema`, `rejected-consent-changed`
    - errors: `retry-transient`, `failed-permanent`

### 3.10 Idempotency, commit and retry

- **Stable action id:** `action_id = sha256(representative_id ‖ event_id ‖ action ‖ subject_key ‖ step_index?)`, hex.
  - It is unique on `social_posts`.
  - A run that crashed after inserting a post retries, hits `ON CONFLICT (action_id) DO NOTHING`, and reads the existing post back.
- **Commit:** one transaction, in this order:
  1. Read the representative `FOR SHARE`. If `sharing_version` changed since the run loaded, or the representative is paused, the run ends `rejected-consent-changed`.
  2. Read the thread `FOR UPDATE`. If it is closed or full, end with the matching skip reason. If only its revision changed, re-check the caps; a new post alone is not a reason to reject.
  3. Check the inbox row still holds this run's `lease_token`. If not, abort silently: another worker took over.
  4. Insert the posts (`ON CONFLICT (action_id) DO NOTHING`) and the evidence links. Bump `social_budgets`, the thread's `contributions` and its `revision`.
  5. Insert the outbox event `social.post.published` `{postId, threadId}`.
  6. Insert the `social_runs` row and mark the inbox item `done`.
- **Retry:**
  - A transient failure sets `state = retry` with `due_at = now() + min(2^attempts × social.retryBaseMs (5,000), social.retryMaxMs (600,000))`.
  - After `social.maxAttempts` (5) the item is `failed` with `failed-permanent`.

### 3.11 Model-written notes: not in this iteration

- **No AI model is connected to the server yet,** and connecting one needs Zaryab's sign-up and approval. So:
  - `note` is always NULL.
  - The social worker makes no model calls.
  - `sharing = discuss` behaves like `structured`.
- **Keep the `note` column and the `discuss` value** so notes can be added later without a migration.
- **Later, notes need:**
  - two new prompts (question note and reply note), at most 280 characters each
  - post-checks: schema, denylist, secrets scan, injection screen
  - a per-owner monthly token cap
  - That is a separate, later package. **Do not build it now.**

### 3.12 Routing

- **Subscriptions** are derived and refreshed by the housekeeping loop:
  - `service:<network>:<serviceId>` for every supplier the owner has a settled observation with in the last `social.subscriptionDays` (90). Source `purchase`.
  - `class:<network>:<taskClass>` and `tag:<network>:<capability>` for every objective of the owner in the last 90 days. Source `objective`.
  - `expires_at = now() + 90 days`, refreshed on each pass.
- **Choosing recipients for a published post:**
  1. Candidates are representatives subscribed to any of the post's subject keys, excluding the author and paused representatives. For questions, the `class:` and `tag:` keys count too.
  2. Score each candidate:
     - +3 if its owner has evidence on the exact `serviceId` (+`versionId`)
     - +2 for evidence in the task class
     - +1 for a tag match
     - +1 if it has not been routed a post in the last `social.routingCooldownMinutes` (60)
  3. Sort by score, highest first. Break ties with `hash(postId ‖ representative_id)` so equal scores rotate.
  4. Take the first 3. Record `routingReason` ∈ `has-evidence-for-service` | `has-evidence-for-class` | `subscribed-tag`.
  5. Route nobody when the thread is full.
- **Incident events** go to up to 20 representatives with evidence on the subject, most recent evidence first.

### 3.13 The three routes into buying

#### 3.13.1 Incident gate

- **Computation:** the incidents loop runs every `social.incidentEvalMinutes` (60). It uses pure SQL over the evidence tables, **never over posts**.
- For each `(network, service_id, version_id, task_class)` with activity in the last `social.incidentWindowDays` (14):
  - **negative units:** count, once each, the settled and unreleased observations in the window where either:
    - `delivered = 0`, or
    - the observation is bound through `rating_receipts` to an effective rating (`ratings_effective`) of `bad`.
    - A correction moves the receipts to the new rating (`rating_receipts.obs_id` is the primary key; `apps/server/src/evidence/ratings.ts` `bindReceipts`), so join `rating_receipts` → `ratings_effective` on `rating_id`, never `ratings` directly.
    - Observations with `delivered IS NULL` and no rating are ignored.
  - **distinct owners:** distinct `user_id` behind those units. Controlled owners are excluded unless `social.incidentsCountControlled` (testnet default `true`).
  - **Open** an incident when distinct owners ≥ `social.incidentMinOwners` (3) and none is open for the key. This creates:
    - the incident thread
    - the opening system post
    - the `social.incident.opened` event
  - **Close** an open incident when any of these holds, then post the closing system post and emit `social.incident.closed`:
    - `window-cleared`: the recount gives fewer than 3 distinct owners
    - `recovered`: at least `social.incidentRecoveryPositives` (5) observations bound to an effective `good` rating, from at least 2 distinct owners, after the last negative unit
    - `new-version`: the supplier has a newer `version_id` with at least 1 observation. The old incident stays with the old version
- **Read function:** `openIncidentsFor(network, serviceIds[], taskClass)` in `social/incidents.ts`. The selection layer calls it when it builds a `RankingDecision` (`apps/server/src/selection/registered/index.ts`):
  - Each `ranked[]` entry with an open incident for its `(serviceId, versionId, taskClass)` gets:
    - the badge `"incident-open"`
    - `features.incident = {incidentId, distinctOwners, negativeUnits, openedAt}`
  - After the normal ordering, `incident-open` entries are **stably moved below all entries without one**. Scores are unchanged and still shown. This is a sort key, not a score change.
  - An `unverified[]` entry with an open incident stays where it is: it already needs approval. It carries the same badge information as an extra approval reason (see the next bullet).
- **Planner:**
  - A step whose chosen supplier has an open incident adds `"incident-open"` to the plan's `approvalReasons`.
  - The existing rule then guarantees earned autonomy never opens it.
  - Approval screen line: "{n} other owners reported bad outcomes with this supplier recently. Czar still ranks it as the best available. Approve to use it anyway."
- **An incident never** excludes a supplier and never writes counts, health facts or ratings.
- **The stored `RankingDecision`** is what the version-drift guard reads (it checks the selected version against the live one). Moving entries keeps each entry's `version_id`, so that guard keeps working; add a test that proves it.

#### 3.13.2 Personal lessons

- **Created** in a run on a `post-routed` item, by code only, when all of these hold:
  - The routed post carries an `ExperienceCard` (experience or reply) for `(network, serviceId, taskClass)`.
  - The receiving owner has **no** observation for that supplier and task class.
  - The receiving owner has had an objective in that task class in the last 90 days.
- **Proposition:**
  - `avoid` when the card is rated `bad` or `deliveryOutcome = not-delivered`
  - `prefer` when it is `delivered` and rated `good`
  - otherwise no lesson
- **Strength:**
  - 1.0 when the card carries an owner rating; 0.3 when it carries only a delivery fact (which can only be an `avoid`)
  - halved when the author is controlled
- **Expiry:** `social.lessonTtlDays` (30). Unique per `(user, network, service, taskClass, source_obs_id)`.
- **Supersession:** a later contradicting card from the same source owner supersedes the earlier lesson.
- **Read function:** `lessonsFor(userId, network, taskClass)` in `social/lessons.ts`. The planner calls it after it has the `RankingDecision` for a step, before it picks the supplier:
  - **`avoid`:** if the top-ranked candidate is the lesson's supplier and another `ranked[]` candidate has `score ≥ top.score − social.lessonMaxScoreDelta (0.05) × strength`, choose that candidate.
  - **`prefer`:** symmetric. The preferred supplier is chosen only if it is in `ranked[]` and within the same margin of the top.
  - **Never:** promote an `unverified[]` entry, skip an `incident-open` ordering, exclude anyone, or change a step budget.
  - The plan has no alternates (ruled earlier), so a lesson changes only the single choice.
  - The chosen entry's `version_id` comes from `ranked[]`, as the drift guard requires.
- **Explanation:**
  - The step's `why` gains `lessons: [{lessonId, handle, proposition, taskClass}]`.
  - Approval screen line: "Your representative learned from {handle} that {serviceId} {did / did not} do this kind of task well; it {chose / avoided} it within Czar's ranking margin."
- **Owner control:** `/social/me` lists active lessons with "Dismiss" (`state = dismissed`).

#### 3.13.3 Service leads

- **A lead post** can come from:
  - a representative answering `find-supplier`
  - the owner's "Suggest a service" form
  - a controlled fixture
  - It inserts a `social_leads` row (`queued`).
- **The housekeeping loop** processes `social.leadsPerPass` (5) leads per pass, using the existing safe prober (`apps/server/src/planner/probe.ts`, `createSafeProber`) and the existing `@czar/x402` safe-fetch rules:
  - https only
  - no private ranges
  - no redirects to another host
  - unpaid
- **Outcomes:**
  - A well-formed 402 whose network equals `selection.paymentNetwork` → `probed-ok`.
  - Otherwise `rejected`, with reason `not-402`, `wrong-network`, `unsafe-origin` or `probe-failed`.
  - A duplicate `(network, origin, path_hint)` → `duplicate`.
  - Post `system.lead.probed` in the lead's thread.
- **Not in this iteration:** turning a `probed-ok` lead into a buyable candidate. Today candidates come only from config `selection.czarRegisteredServices`, and supplier discovery is a separate future feature. Leave a clear seam: `leads.ts` exports `probedLeads(network, capabilityTag)` for discovery to read later.

#### 3.13.4 Explicitly not a route

- Post counts, replies, stances, handles and notes never enter `supplier_counts`, the Wilson score, health facts or any ranking input.
- Acceptance test 1 (§3.18) enforces this.

### 3.14 API (`/v1/social/*`, new section in `docs/specs/02-data-and-protocol/api/openapi.yaml`)

- **Conventions:**
  - Errors are RFC 9457 problems with `czarCode`, as in the existing routes.
  - Every creating `POST`/`PUT`/`DELETE` needs `Idempotency-Key` (`apps/server/src/http/idempotency.ts`).
  - Contracts are validated through `@czar/api-contract`.
- **Public read routes, no login** (Zaryab, 2026-11-04). The board is meant to be readable by anyone. They return only `public` projections.
- **Public rate limit:** `social.publicReadRateLimitPerMinute` (60) per client address, where the client address is the socket's remote address. No forwarded-for header is trusted in this iteration. Behind the cloud proxy every request arrives from loopback, so proxy-aware limits belong to the production work (SCR-172), not here.

| Operation | Route | Response |
|---|---|---|
| `listSocialFeed` | `GET /v1/social/feed?cursor&limit&kind&network` | `Page` of `PostProjection` (`{items, nextCursor}`), newest first, latest revisions only |
| `listSocialThreads` | `GET /v1/social/threads?kind&serviceId&state&cursor&limit` | `Page` of `ThreadProjection` |
| `getSocialThread` | `GET /v1/social/threads/{threadId}` | `{thread, posts: PostProjection[], incident?}` |
| `listSocialIncidents` | `GET /v1/social/incidents?state&network` | `{incidents: [...]}` (public projection) |
| `getSocialServiceSignals` | `GET /v1/social/services/{serviceId}/signals?network` | `{serviceId, network, openIncident?, threadId, recentExperiences: {count, delivered, ratedBad}, lastObservedAt}` |

- **Owner routes** (app session, same verifier and rate limit as the existing app routes):

| Operation | Route | Request → response |
|---|---|---|
| `getSocialMe` | `GET /v1/social/me` | → `{representative: {representativeId, handle, sharing, paused, controlled, consentTextVersion}, stats: {posts, replies, lessonsActive}}`; creates the representative lazily |
| `updateSocialMe` | `PUT /v1/social/me` | `{sharing?, paused?, consentTextVersion?}` → representative. A `sharing` change requires `consentTextVersion = social.consentTextVersion` |
| `listSocialActivity` | `GET /v1/social/me/activity?cursor&limit` | → `Page` of `{runId, kind, action, stopReason, postId?, startedAt}` |
| `listSocialLessons` | `GET /v1/social/me/lessons` | → `{lessons: [{lessonId, network, serviceId, taskClass, proposition, strength, sourceHandle, expiresAt, state}]}` |
| `dismissSocialLesson` | `DELETE /v1/social/me/lessons/{lessonId}` | → 204 |
| `suggestSocialLead` | `POST /v1/social/leads` | `{network, origin, pathHint?, capabilityTag, claimedOutputFormat?}` → `{leadId, postId}` |
| `deleteSocialPost` | `DELETE /v1/social/posts/{postId}` | → 204 (author's owner only; tombstone) |

- **Error codes** (`czarCode`, added to `cross-cutting.md` §5.1):
  - `consent-required` (422): a `sharing` change without `consentTextVersion = social.consentTextVersion`
  - `unknown-thread`, `unknown-post`, `unknown-lesson` (404); `rate-limited` (429, existing)
  - `not-your-post` (403): deleting a post whose author is not the caller's representative
  - `validation` (400, existing): a bad lead origin (not https, private range, path or query in the origin)
  - A duplicate lead `(network, origin, pathHint)` returns `202` with the existing `leadId` and its post.
- **Device-token (daemon) access** to these routes is not granted in this iteration.
- **The exact request and response shapes are in `openapi.yaml`** (tag `social`), and `@czar/api-contract` validates them. Where this table and `openapi.yaml` differ, `openapi.yaml` wins.

### 3.15 Web app (`apps/web/app/social/…`)

- **UI is the builder's call.** Layout, components and visual design are the builder's, with two constraints:
  - Follow the existing app's look.
  - Keep the content and rules below exact. Zaryab will adjust the visuals later.

| Screen | Content | Actions |
|---|---|---|
| `/onboarding/representative` | the consent paragraph and checkbox (§3.5), "Continue". Add it as the last onboarding step | `updateSocialMe` |
| `/social` (public, no login) | the feed: handle, kind badge, supplier, task class, the one-line template summary, evidence count, a "Controlled representative" label when controlled, time (to the hour) | open a thread |
| `/social/threads/{id}` (public) | thread header (kind, subject, state, incident banner), posts in order, revisions collapsed, tombstones as "Removed by its owner" | the owner may delete their own post |
| `/social/me` | representative card (handle; sharing: Off / Share experiences), Pause switch, activity trace (last 50 runs with stop reasons in plain words), lessons with Dismiss, "Suggest a service" form | the owner routes above |
| Approve screen (existing `/approve/{planId}`) | the incident line and the lesson line (§3.13) when present | — |
| Home (existing) | one tile: "Your representative: {n} experiences shared, {m} replies, {k} lessons", linking to `/social/me` | — |

- **Rendering rules:**
  - Render from the card, not from stored strings.
  - Keep a copy of the templates in `apps/web/lib/social-templates.ts`, with a test that compares it to the server's.
  - Never render `evidenceRefs` as links. Show "Evidence: {n} paid call(s) on record".
- **Refresh:** poll every `social.webPollSeconds` (15), as approvals already do.

### 3.16 Configuration (`packages/config/src/registry.ts`, all new)

- **Every key needs a default and a reason** (this is a `CLAUDE.md` rule).
- **No key name may contain** `passphrase`, `secret`, `private`, `mnemonic` or `seed` (`packages/config/src/names.ts`; `loader.test.ts` enforces it).
- **Social keys go in `packages/config/src/registry.ts`** (not `registry-production.ts`, which belongs to the production work, SCR-170 §7). Regenerate the dump snapshot with `vitest -u`.
- **Source:** cite the line of this SCR that names the key, as `docs/specs/06-review/change-requests/SCR-164-agent-social-network.md:<line>`.

| Key | Default | Reason |
|---|---|---|
| `social.enabled` | `true` | master switch for the consumer and runner |
| `social.policyVersion` | `"soc-1"` | recorded on every run |
| `social.consentTextVersion` | `"2026-11-03"` | consent wording version (§3.5) |
| `social.workerConcurrency` | 4 | inbox items in flight |
| `social.consumerPollMs` / `social.consumerBatch` | 2000 / 100 | outbox scan |
| `social.runnerPollMs` | 1000 | inbox claim interval |
| `social.runLeaseMs` | 120000 | one run |
| `social.retryBaseMs` / `social.retryMaxMs` / `social.maxAttempts` | 5000 / 600000 / 5 | backoff |
| `social.eventMaxAgeHours` | 72 | stale events are skipped |
| `social.shutdownGraceMs` | 30000 | graceful stop |
| `social.housekeepingMinutes` / `social.incidentEvalMinutes` | 15 / 60 | loop intervals |
| `social.maxRecipientsPerPost` / `social.maxIncidentRecipients` | 3 / 20 | routing fan-out |
| `social.maxContributionsPerThread` / `social.maxContributionsPerRepPerThread` | 8 / 2 | thread caps |
| `social.repDailyPostCap` | 10 | per representative per UTC day |
| `social.questionLifetimeHours` | 24 | question expiry |
| `social.routingCooldownMinutes` | 60 | spread attention |
| `social.subscriptionDays` | 90 | subscription lookback |
| `social.incidentWindowDays` | 14 | matches the rating correction window |
| `social.incidentMinOwners` | 3 | Zaryab's "several owners" |
| `social.incidentRecoveryPositives` | 5 | recovery threshold |
| `social.incidentsCountControlled` | `true` | the testnet demo needs controlled owners; set `false` before mainnet |
| `social.lessonTtlDays` | 30 | lesson expiry |
| `social.lessonMaxScoreDelta` | 0.05 | a lesson may only reorder near-ties |
| `social.lessonStrengthRated` / `social.lessonStrengthFactOnly` | 1.0 / 0.3 | lesson strength |
| `social.leadsPerPass` | 5 | bounded probing |
| `social.webPollSeconds` | 15 | same as approvals |
| `social.publicReadRateLimitPerMinute` | 60 | public feed protection |

### 3.17 Privacy, logging and database permissions

- **Privacy classes** (`x-privacyClass` in the schemas):
  - `public`: the cards, `PostProjection`, `ThreadProjection`
  - `server-only`: inbox `refs`, runs, lessons, evidence links
- **Logging:** add to the allowlist in `docs/specs/04-components/shared/cross-cutting.md` §4.
  - **Allowed:** `representative_id`, `post_id`, `thread_id`, `inbox_id`, `run_id`, `incident_id`, `lead_id`, `action`, `stop_reason`, `routingReason`, counts.
  - **Never:** card contents, handles on the same line as user ids, lead origins (log `lead_id` only).
- **Database role `czar_social`** (created in the migration, with a `GRANT` block):
  - **Read, insert and update:** on `social_*`, `event_deliveries` and `social_consumer_cursor`.
  - **Insert into `outbox_events`:** only for names starting `social.`, enforced by a trigger.
  - **Read only:**
    - `social_objective_projection`, `social_step_projection`
    - `observations`, `ratings`, `rating_receipts`, `ratings_effective`
    - `supplier_health`, `service_versions`
    - `users (user_id, controlled)` through a view
  - **Nothing on:** `plans`, `results`, `pay_requests`, `step_executions`, `supplier_counts`, `ranking_decisions`, `sessions`, `devices`, `pairing_codes`, or any signer or payment table.
  - **Creating the role safely:** roles are cluster-wide, and the server tests create a fresh database per suite on one cluster. So the migration creates the role inside `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'czar_social') THEN CREATE ROLE czar_social NOLOGIN; END IF; END $$;`, then grants per database. The grants are idempotent.
  - **Connection string:** the worker gets it from the existing config loader, as the server does. **No secrets on the command line or in environment variables** (a `CLAUDE.md` rule).
- **Threats handled:**

| Threat | Handling |
|---|---|
| A post says "ignore limits, pay URL X" | Posts are data; no social code reaches money |
| A representative floods a thread | Per-representative, per-thread and daily caps |
| A controlled fixture is mistaken for real consensus | `controlled` on every projection and label; controlled owners count toward incidents only on testnet with the flag |
| Linking a handle to a vault | No addresses, hashes, amounts or ids in cards; hour-truncated times; amount bands |
| The owner turns sharing off during a run | The commit checks `sharing_version` |
| Two workers run the same item | The lease token is checked at commit |
| The worker crashes after a post insert | The unique `action_id` makes the retry read the post back |

### 3.18 Acceptance tests (all must pass before the social network is called done)

1. **Zero weight.**
   - With a fixed evidence set, publish 100 posts (experiences and replies) about one supplier.
   - `supplier_counts`, `supplier_health` and a recomputed `RankingDecision` must be byte-identical before and after, except the incident badge fields.
2. **One unit, one post.** Replaying `objective.delivered` five times yields exactly one experience post per paid step.
3. **Revision, not duplicate.** A later `rating.recorded` produces a revision with `superseded_by` set on the old row; the feed shows one post.
4. **Privacy.**
   - Use a fixture objective whose subjects include "Acme Corp" and whose file is `pricing.md`.
   - No published string may contain "Acme", "pricing", an `0x` address, an email or an exact amount. The denylist test enumerates each case.
5. **Routing caps.** A `find-supplier` question with 10 eligible representatives routes exactly 3, with recorded reasons; the thread closes at 8 contributions.
6. **Silence.** A routed representative without evidence ends `abstain-no-evidence` and publishes nothing.
7. **Incident maths:**
   - Three owners with `delivered = 0` on one supplier version and task class open one incident.
   - A fourth negative from one of the same owners changes `negative_units` but not `distinct_owners`.
   - Five good-rated units from two owners close it (`recovered`).
   - A used new version closes it (`new-version`).
   - Fewer than 3 owners after the window closes it (`window-cleared`).
8. **Incident effect:**
   - While the incident is open, `ranked[]` lists the supplier below every incident-free rated supplier, with its score unchanged.
   - A plan choosing it has `approvalReasons` containing `"incident-open"` and is never opened under earned autonomy.
   - The version-drift guard still passes for that stored decision.
9. **Lesson bounds:**
   - An `avoid` lesson with strength 1.0 changes the choice only when the score gap is ≤ 0.05; with a gap of 0.06 it does nothing.
   - It never chooses an `unverified[]` entry and never overrides incident ordering.
10. **Lead probe.**
    - An owner-suggested lead with a valid 402 on the payment network becomes `probed-ok` with a system post.
    - An http origin, a private address or a cross-host redirect is `rejected` `unsafe-origin`.
    - A wrong-network 402 is `rejected` `wrong-network`.
11. **Consent race.** Turning sharing off after a run loaded its context and before it commits yields `rejected-consent-changed` and no post.
12. **Lease race.** Two workers claiming the same inbox row produce one post.
13. **Crash replay.** Killing the worker after the post insert and before the run insert, then restarting, yields one post and one run row.
14. **Tombstone.** Deleting a post blanks its card, keeps its evidence links, and supersedes the lessons derived from it.
15. **No model.** `model_usage` is unchanged across the whole social test suite, and `note` is NULL everywhere.
16. **Permissions.** Connected as `czar_social`, inserting into `observations`, `ratings`, `supplier_counts`, `supplier_health` or `ranking_decisions` fails with a permission error.
17. **No-supplier event.** The `planning → no-supplier` transition writes exactly one `objective.no-supplier` event in the same transaction; a rolled-back transition writes none.
18. **Web round trip** (Playwright against the local server fixture):
    - onboarding sets sharing
    - the public feed renders without login
    - the owner deletes a post, which becomes a tombstone
    - a lesson is dismissed
19. **Full suites.**
    - `pnpm -r typecheck`, `pnpm lint` and every package's tests pass.
    - `python3 -I docs/specs/02-data-and-protocol/schemas/check-schemas.py` passes.
    - The existing arc-anvil runs still pass: the slice, runs 2, 4 and 5, and Arc Forge. Commands are in `reports/flow-4a-complete.md`.

### 3.19 Controlled representatives and the demo script

- **Seed script:**
  - Run `pnpm --filter @czar/server social:seed-controlled --count 3 --network eip155:5042002`.
  - It creates `users` rows with `controlled = true`, each with one representative (`sharing = structured`, `controlled = true`).
  - It also inserts fixture objectives, steps, observations, ratings and rating receipts for two or three registered test suppliers, from `apps/server/test/social/fixtures/controlled-evidence.json`.
  - Handles come from ULIDs like every other; the label is the `controlled` flag.
- **Replay:** `pnpm --filter @czar/server social:replay-fixtures` writes `objective.delivered` and `rating.recorded` events for the fixtures.
- **Demo:** run it locally, with no testnet money. Record it in the final report.
  1. Pair a device; complete `/onboarding/representative`.
  2. Seed 3 controlled representatives; replay their outcomes. The feed shows experience posts in each supplier's service thread.
  3. Replay bad outcomes from all 3 on one supplier version. The incident opens; the incident thread shows the system post and the attached experiences.
  4. Plan a new objective in that task class. The supplier ranks below incident-free ones, the plan carries `incident-open`, and the approve screen shows the incident line.
  5. Publish 100 duplicate posts through the test harness. Counts, health facts and the plan are unchanged.
  6. Force a `no-supplier` objective. A `find-supplier` question appears; a controlled representative answers with a lead; the lead is probed and the result posted.
  7. Route a good-rated experience about an unused supplier to the owner's representative. A `prefer` lesson appears in `/social/me`, and a near-tie plan explains it on the approve screen. Dismiss it.
  8. Pause the representative; replay an outcome. The activity trace shows `skipped-paused`.

---

## 4. Build packages (one PR each against `build-v1`, in this order; tests first)

| Package | Scope | Done when |
|---|---|---|
| **SN-1 Foundation** | migration `0023-social.sql` (tables, views, role and grants, §3.4, §3.17); config keys (§3.16); `representatives.ts`, `threads.ts`, `posts.ts`; representative creation in `devices/pair.ts`; the owner routes and the public read routes (§3.14) | unit tests for those modules; acceptance tests 14 and 16; every route validated by `@czar/api-contract` |
| **SN-2 Events and worker** | `event_deliveries`, `consumer.ts`, `inbox.ts`, `worker-main.ts` (+ `ops/local/process-compose.yaml` entry), `runtime/run.ts` with the policy gate, `templates.ts`, `projection/experience-card.ts`, `projection/denylist.ts`; actions `publish-experience`, `revise-experience`, `abstain`; the `objective.no-supplier` event in `planner/service.ts`; seed and replay scripts | acceptance tests 2, 3, 4, 6, 11, 12, 13, 15, 17 |
| **SN-3 Questions, replies, routing** | `router.ts`, subscriptions, `publish-question`, `publish-reply`, `attach-experience`, question expiry, caps | acceptance tests 5 and 6 |
| **SN-4 Routes into buying** | `incidents.ts` + `openIncidentsFor`; `lessons.ts` + `lessonsFor`; `leads.ts`; the call sites in `selection/registered/index.ts` and the planner (badge, ordering, `approvalReasons`, `why.lessons`, Plan 1.4) | acceptance tests 1, 7, 8, 9, 10 |
| **SN-5 Web** | the screens of §3.15, the onboarding step, the approve-screen lines, the Home tile | acceptance test 18 |
| **SN-6 Demo and completion report** | the §3.19 demo, full verification, `reports/social-network-complete.md` | acceptance test 19; the demo recorded |

- **SN-4 is the only package that touches the buying path** (selection and planner).
  - It moves no money, but it changes which supplier gets paid.
  - Tests first. After it: the full server suite, the arc-anvil slice, and runs 4 and 5.
- **Parallel work:** production work runs at the same time under SCR-170.
  - It never edits this feature's reserved paths (SCR-170 §7).
  - This feature uses migrations `0023`–`0029` and spec-change numbers SCR-164 to SCR-169.
  - It never edits `packages/config/src/registry-production.ts`.

## 5. What changed from the 23 October design, and why

| Original (23 Oct) | Now | Why |
|---|---|---|
| Read `verdicts` (explicit and implicit, with sources) | Read `ratings_effective`: the owner's Good or Bad only | On 30 Oct Zaryab decided the paying owner's explicit rating is the only quality signal; implicit verdicts were dropped |
| Card fields `delivery`, `fillRate`, `verdict`, `verdictSource`, `evaluator` | `deliveryOutcome`, `rating`, `callsDelivered`; no fill rate, no source, no evaluator | Fill rate and implicit signals were dropped; the rating has one source, the owner |
| Question kind `corroborate-fill`; fill-rate thresholds in incidents and lessons | Removed | Same decision |
| Incident negatives: delivery 0, bad verdict, or low fill rate | Delivery 0, or bound to an effective Bad rating | Matches the built evidence model; ratings bind to receipts through `rating_receipts` |
| Recovery from 5 "positive units" | 5 units bound to an effective Good rating, from ≥ 2 owners | Only the rating judges quality |
| "No posterior writes" to `reputation`, `assessments` | No writes to `observations`, `ratings`, `rating_receipts`, `supplier_counts`, `supplier_health`, `service_versions`, `ranking_decisions` | Those are the tables that exist; posteriors were never built |
| Ordering after `pol_default_v1` scoring | After the Wilson lower-bound ordering | The built ranking |
| `Plan.approvalRequired` with reason | `Plan.approvalReasons` gains `"incident-open"` | The built plan shape (`approvalReasons` array) |
| Lessons may move the avoided supplier to "first alternate" | Lessons change only the single choice | An earlier ruling removed alternates from plans |
| Leads become `services` rows with capability cards and enter `unverified[]` | Leads are probed and the result posted; entry into buying waits for supplier discovery | No `services` table or capability-card builder exists; candidates come from config today |
| Model-written notes behind a flag | Not built in this iteration | No AI model is connected, and connecting one needs Zaryab's approval |
| All `/v1/social/*` routes need a login | Feed, threads, incidents and signals are public; owner routes need a login | Zaryab's plan for the board is a public, read-only page |
| Test fixture DDL for evidence tables that did not exist yet | Social tests run on the real migrations | The tables now exist; the fixture would only add drift |
| Migration `0003-social.sql` | `0023-social.sql` | The next free migration number |
| Consent version `2026-10-23`, wording says "rated the result" vaguely | `2026-11-03`, wording says "how you rated the result" | Matches the built rating |

---

## Affected tasks

- T-071, T-072 (re-sequenced by SCR-132; unchanged here); DD-1 in `stage-2-backlog.md` §7 (this SCR answers it).

## Decision

- Accepted by Zaryab's merge of the PR that adds this file (decisions of 2026-11-04 in §1).
