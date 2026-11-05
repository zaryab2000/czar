# SCR-181: Browser "New task" (objectives from a web session)

| Field | Value |
|---|---|
| ID | SCR-181 |
| Filed by | Claude (chief architect), 2026-11-05 |
| Spec and section | `docs/specs/02-data-and-protocol/api/openapi.yaml` (new `/v1/app/objectives` routes); `docs/specs/02-data-and-protocol/data-and-protocol.md` (objective intake); `docs/specs/04-components/server/server-planning-and-payment.md` §objective intake; `docs/specs/04-components/web/` (new page); `apps/server/migrations/` (new `0031`) |
| Status | Open |
| Tracker | SPEC-01. Unblocks UX-01, UX-02, UX-03, UX-04, UX-06, BR-06 (`docs/tracker/demo-v1-tracker.md`) |

## Problem
- **Objectives can only be created by a paired device.** `POST /v1/objectives` needs a device token (`czar objective`, macOS only).
- **Demo v1 (DD-01) needs a browser path:** a signed-in user types a task, pastes a contract, and submits it.
- **Nothing in the specs defines:**
  - a session-authenticated objective route
  - how the server fills the device-only submission fields
  - what the browser shows while the task runs

## Evidence
- `apps/server/src/app.ts:985`: `POST /v1/objectives` is the only objective route, and it is device-authenticated.
- `objective-submission.schema.json` requires `deviceId`, `soulVersionHash`, `observationHashes`, `detector`, `minutesSaved`, `hourlyBand` and `redaction`. All are produced by the daemon today.
- `apps/server/migrations/0001-cz12.sql:17`: `devices.platform CHECK (platform IN ('macos','linux','windows'))`, and `objectives.device_id NOT NULL REFERENCES devices`.
- `docs/production/2026-11-05-parallel-production-plan.md`: the browser "New task" path was named the alpha's demand entry (with SCR-179), but was never specified.

## Proposed change

This SCR is the normative spec for the tasks above until its content is folded into the component specs.

### 1. The browser device
- **Migration `0031-web-device.sql`:** extend the platform check to `('macos','linux','windows','web')`.
- **On a user's first browser objective,** the server creates **one** device row for that user:
  - `platform = 'web'`, `device_name = 'Browser'`
  - `token_hash` = 32 random bytes that are **never issued** as a token, so no request can ever authenticate as this device
  - It is created inside the objective transaction with `ON CONFLICT DO NOTHING`, keyed by a partial unique index on `(user_id) WHERE platform = 'web'`.
- **That device's `device_id` is the objective's `deviceId`.**
- **Lists:**
  - The device appears in Settings → Devices with the label "Browser (tasks you start on the web)".
  - It cannot be paired, revoked by token, or used by the daemon.
  - Revoking it from Settings hides it, and blocks new browser objectives until the user signs in again.

### 2. Routes (session-authenticated, same middleware as `/v1/app/ratings`)
- **`POST /v1/app/objectives`**
  - **Middleware:** `appSessionVerifier`, then `appRateLimit`.
  - **Headers:** `Idempotency-Key` required, same format as `/v1/app/ratings`.
  - **Request body** (`app-objective-request.schema.json`, new):

    | Field | Type | Rule |
    |---|---|---|
    | `kind` | string | enum `["smart-contract-audit"]` (one value for Demo v1; extend by SCR) |
    | `title` | string | 1–120 chars; becomes `taskSpec.topic` and the subject label |
    | `description` | string | 0–1000 chars; becomes `goal` (after layer 1) |
    | `contractSource` | string | 0–`app.objectiveMaxSourceChars` chars; becomes `taskSpec.context` (after layer 1) |
    | `contractAddress` | string | optional; `^0x[0-9a-fA-F]{40}$` |
    | `maxTotal` | `Amount6` | optional; becomes `constraints.maxTotal` |

  - **Exactly one of** `contractSource` or `contractAddress` must be present. Otherwise: `400 validation`.
  - **Response `201`:** `{ "objectiveId": "obj_…", "state": "received" }`.
  - **Errors:**
    - `400 validation`
    - `409 idempotency-conflict`
    - `429` (rate limit)
    - `403` when the user has no vault yet (`"Create your wallet first"`)
- **`GET /v1/app/objectives`**
  - The session user's objectives, newest first, paged (`limit` ≤ 50, `cursor`).
  - Items follow `app-objective.schema.json` (new): `objectiveId`, `title`, `kind`, `state` (`ObjectiveStatusValue`), `planId` (when one exists), `createdAt`, `updatedAt`, `origin` (`"web"` or `"device"`).
- **`GET /v1/app/objectives/{objectiveId}`**
  - One item of the same shape.
  - Returns `404` if the objective is not the session user's.
- **Ownership:** all three routes read and write only rows whose `user_id` is the session user.

### 3. How the server builds the submission
- **Built server-side,** then sent through the **same** objective intake code path as `POST /v1/objectives` (validation, `objectiveHash`, outbox `objective.received`).
- **Field mapping:**

  | Submission field | Value |
  |---|---|
  | `schemaVersion` | `"1.0"` |
  | `objectiveId` | server `ulid("obj_")` |
  | `deviceId` | the user's web device (§1) |
  | `soulVersionHash` | `H("czar.web-objective.no-soul.v1")` (`@czar/hashing`); a constant meaning "no local soul" |
  | `observationHashes` | `[]` |
  | `detector` | `"placeholder"` (manual entry, D82) |
  | `goal` | `description` after layer 1, or `"Audit " + title` when empty |
  | `capabilities` | `["code-review"]` for `kind = "smart-contract-audit"` |
  | `minutesSaved` | `app.webObjectiveMinutesSaved` |
  | `hourlyBand` | `app.webObjectiveHourlyBand` |
  | `constraints` | `{ maxTotal }` when given |
  | `redaction` | `{ layer2: { hits: 0, entities: [] } }`; layer 2 (Presidio) does not run on this path (§4) |
  | `submittedAt` | server clock |

- **`taskSpec`:**
  - `schemaVersion "1.1"`, `kind "list-fill"`, `topic = title`
  - `subjects = [{ label: contractAddress ?? title }]`
  - `fields = ["severity","location","issue","fix"]`
  - `context = contractSource` (after layer 1), omitted for address mode
  - `sourceTrust "user-prompt"`, `output { format: "json", formatSource: "default" }`
- **`app.objectiveMaxSourceChars` is 2000,** which equals the `task-spec.schema.json` `context` maximum. The browser shows the limit. Larger contracts use address mode (SCR-182 §2).

### 4. Privacy on this path (amends the "objectives are redacted" wording for web objectives)
- **Layer 1** (`@czar/redaction`, the same rules the daemon uses) runs on the server over `title`, `description` and `contractSource` before anything is stored.
  - If layer 1 removes anything, the response still succeeds, and the progress view shows "Czar removed N items that looked like secrets".
- **Layer 2 does not run** on this path.
- **The New task page states plainly, above the submit button:** "What you paste is sent to Czar and to the merchant you approve. Do not paste secrets or private keys."
- **Logging:** logs carry the objective ID and hashes only. They never carry the title, description or source (cross-cutting §4).

### 5. Rate limits and parameters (new `@czar/config` keys)

| Key | Type | Default | Unit | Reason |
|---|---|---|---|---|
| `app.objectiveMaxSourceChars` | integer | 2000 | chars | Equals `taskSpec.context` max |
| `app.webObjectivesPerUserPerHour` | integer | 10 | count | Stops one account flooding the planner and merchants |
| `app.webObjectiveMinutesSaved` | integer | 60 | minutes | Fixed estimate for manual web tasks (D82) |
| `app.webObjectiveHourlyBand` | string | `"C"` | band | Neutral default; no local soul on the web |
| `app.objectivePollSeconds` | integer | 3 | seconds | Browser polling interval for task progress |

### 6. What the browser shows (component behaviour)
- **The New task page (`/tasks/new`):**
  - form fields as in §2: title, description, source *or* address (a toggle), and optional max budget in USDC
  - a live character count against `app.objectiveMaxSourceChars`
  - the §4 privacy line
  - a "New task" button on Home
- **The task progress page (`/tasks/{objectiveId}`):** polls `GET /v1/app/objectives/{id}` every `app.objectivePollSeconds`. Plain labels:

  | `state` | Label |
  |---|---|
  | `received`, `planning`, `replanning` | "Finding the best merchant…" |
  | `no-supplier` | "No merchant found yet" |
  | `awaiting-approval` | "Waiting for your approval": a button to `/approve/{planId}` |
  | `opening`, `executing` | "Paying and running…" |
  | `delivered` | "Delivered": shows the result card (existing `result-card.tsx`), with Good and Bad rating |
  | `failed` | "Something went wrong": shows the error class |
  | `expired`, `dismissed` | "Closed" |

- **Rendering the delivered report:** findings grouped by severity, each with location, issue and fix.
  - The report is untrusted text: render it as text, never as HTML.
- **Home:** lists browser tasks together with device tasks (`origin` shown as a small "Web" or "Device" tag).
- **Funding help (`/onboarding/fund`):**
  - a short "Get testnet USDC" block with the Circle faucet link
  - "20 USDC every 2 hours per address"
  - copy-to-clipboard for the wallet address
  - copy only; no new route
- **Approval page "why" (BR-06):** renders the existing plan fields (`steps[].why`, `approvalReasons`, `why.lessons[]`, the SCR-165 incident line) as one plain sentence each. No new plan fields.

## Tests (acceptance)
1. **Session auth:** no session → 401; another user's objective → 404 on GET.
2. **Validation:**
   - both source and address present → 400
   - neither present → 400
   - source over `app.objectiveMaxSourceChars` → 400
   - bad address → 400
3. **Idempotency:** the same key and body returns the same `objectiveId`; the same key with a different body → 409.
4. **Web device:** two browser objectives from one user create exactly one `platform='web'` device, and its token hash never authenticates `POST /v1/objectives`.
5. **Intake parity:** the stored submission validates against `objective-submission.schema.json`, its `objectiveHash` matches `@czar/hashing`, and one `objective.received` outbox event is written.
6. **Layer 1:** a source containing a test secret pattern is stored without it, and the removal count is shown.
7. **Rate limit:** the 11th request in an hour → 429.
8. **No vault:** → 403 with the plain message.
9. **Playwright:**
   - submit → progress shows "Finding the best merchant…"
   - "Waiting for your approval" appears without a reload
   - a delivered task shows the result card, and a Bad rating is recorded through `/v1/app/ratings`

## Affected tasks
- UX-01 (server routes, migration, intake), UX-02 (New task page), UX-03 (progress page), UX-04 (result and rating), UX-06 (funding help), BR-06 (approval "why"), BR-02 (planner receives these objectives)

## Decision
- <filled in by Zaryab>
