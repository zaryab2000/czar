# SCR-147: Daemon `czar objective` command for submitting an objective by hand

| Field | Value |
|---|---|
| ID | SCR-147 |
| Filed by | chief architect, 2026-10-27, for the local end-to-end flow before Track A closes |
| Spec and section | 02 §4.4 `ObjectiveSubmission`, §5.2 hashes, §9.2 `/v1/objectives`; CZ-02/CZ-03 daemon (`local-observers-and-daemon.md`); `phase-1-tasks.md` (new task T-126) |
| Status | Accepted (Zaryab's delegation for Track A closure; recorded by his merge) |

## Problem
- Objectives can only be submitted with a device token, through `POST /v1/objectives`.
- The normal producers are detectors, drives and proposals (T-062, T-063, T-066). They are held for Track B.
- The web app has no submit page, and `apps/mcp` is empty.
- So nobody, including Zaryab, can start an objective. That leaves no way to test the paid flow end to end locally.

## Change: new task T-126 (Lane 4), a daemon command that submits one objective
- **Command:** `czar objective "<goal>"`.
- **Options:**

  | Option | Default | Repeatable | Values |
  |---|---|---|---|
  | `--capability` | `web-search` | yes | from `drives.capabilityTaxonomy` |
  | `--kind` | `list-fill` | no | `TaskSpec.kind` enum |
  | `--topic` | `<goal>` truncated to the schema limit | no | — |
  | `--subject <label>` | — | yes | at least 1 |
  | `--field <name>` | — | yes | at least 1 |
  | `--minutes-saved <n>` | `0` | no | — |
  | `--hourly-band` | `A` | no | `A`..`E` |
  | `--max-total <Amount6>` | none | no | — |

- **Requires** a paired device (`czar pair <code>`). Without one, it exits with an error naming `czar pair`.

### How it builds the `ObjectiveSubmission`
Only existing schemas, hashes and routes are used. Nothing is added to the server, the schemas or the routes.
- `objectiveId`: a new `Id(obj)`. `submittedAt`: now. `deviceId`: from the stored device token.
- `detector`: `"placeholder"`, an existing enum value. `observationHashes`: `[]`.
- **`taskSpec`:** built from the options, with `sourceTrust = "user-prompt"`, and validated with `@czar/schemas`.
- **`soulVersionHash`:** computed with `@czar/hashing` `soulVersionHash` over the daemon's current soul version.
  - If none exists yet, the command creates and stores a seed version: `{version: 0, compiledAt: <first-use time>, sections: {}}`.
  - It reuses that seed for later submissions, so the value is stable.
- **`redaction` (amended 2026-10-27, follows D84):**
  - **Layer 1 (secrets)** runs on `goal`, `topic`, every `subjects[].label` and every `fields[]` value. Any hit → refuse before any request is sent, printing the rule names only.
  - **Layer 2 (personal data)** runs on `goal` only. It treats the `TaskSpec` subject labels and field values as allowed spans, which are never replaced (D84: they are the task). Any other hit in `goal` is replaced with `[[R:P:<ENTITY>#n]]` markers, as in spec 01 §11.2. `redaction.layer2` records the hit count and entity names.
  - **`TaskSpec` values** are sent unchanged after Layer 1.
- **Redaction sidecar (amended 2026-10-27):**
  - The command uses the daemon's existing lazy sidecar helper (`apps/daemon/src/sidecar.ts`), started on demand.
  - Socket: `czar-redact.sock`, mode 0600, in the daemon socket directory.
  - Per-call timeout: `redaction.layer2TimeoutMs`. Idle stop: `redaction.sidecarIdleS`. No process-compose service.
  - If the sidecar can't start or answer, the regex fallback runs and the result is marked forced-review (D45, `redaction.layer2Fallback`). The command then prints the redacted `goal` and asks `Send? [y/N]`.
  - Without a TTY, or on any answer other than `y`, it exits non-zero **before** any request is sent.
  - The runbook documents installing the sidecar's `uv` environment.
- **`objectiveHash`:** computed with `@czar/hashing` `objectiveHash`. The server recomputes it (a mismatch gives `422`).

### After submitting (amended 2026-10-27)
- The command prints `objectiveId`.
- It polls `GET /v1/objectives/{id}` every `daemon.objectivePollSeconds` and prints each `status` change.
- **Approval URL:** at `awaiting-approval` it prints `<app origin>/approve/<planId>`. `planId` comes from `ObjectiveStatus.planSummary.planId`, which the OpenAPI response already defines.
  - The server must populate `planSummary` (`planId`, `cap`, `category`, `stepCount`, `spent`) from its `plans` table whenever a plan exists. This is an implementation fix, not a contract change. Owner: Lane 2 (`objectives/`).
  - `<app origin>` is the config key `app.publicOrigin` if it exists; otherwise the command prints only `planId` and `/approve/<planId>`. It adds no key.
- **Result write-back (minimal CZ-11 subset, new):** when the status is final and `resultId` is present:
  1. `GET /v1/results/{resultId}` with the device token.
  2. Write `<cwd>/.czar/results/<objectiveId>.md` atomically (`.tmp` then rename). Content: `Result.renderedBody` exactly as served, with the header line CZ-11 §5.2 specifies. No rewriting of labelled spans.
  3. `POST /v1/objectives/{objectiveId}/results/ack` with `{resultId, writtenAt, surface: "claude-code-file"}`, idempotency key = `resultId`.
     - Retry up to 3 times with backoff on network errors or 5xx. A 4xx stops with the error code printed.
     - The server scopes both calls to the device's user (OpenAPI `DeviceToken`).
  4. Print the file path.
- **`czar result <objectiveId>`** repeats the write-back for an objective already final (idempotent).
- **No web result view.** CZ-22 keeps merchant text out of the app. The app shows the receipt, envelope and spending; the result content lives in the project file.

### Logging
- It follows cross-cutting §4: never the goal, `taskSpec` values or tokens. Only IDs and states.

## New config key
- `daemon.objectivePollSeconds` = 5. Reason: a human watching the terminal sees state changes promptly, and one GET per 5 s is negligible load.

## Not changed
- Server, schemas, OpenAPI.
- The detector, drives and proposal pipeline (T-062, T-063, T-066 stay held for Track B).

## Acceptance (T-126)
- The submission validates against `objective-submission.schema.json`, and the server accepts it (`objectiveHash` recomputes).
- With no paired device it exits non-zero, naming `czar pair`.
- A planted secret in `goal` or any `TaskSpec` value is refused before sending.
- `TaskSpec` subjects and fields survive layer 2 unchanged; other PII in `goal` becomes markers.
- Sidecar down: no TTY → exit before any request; TTY + `y` → sent with the forced-review flag recorded in local logs (no text).
- `awaiting-approval` prints the approval path with `planId` from `planSummary`.
- Write-back writes the file once and acks once; a re-run of `czar result` is idempotent; ack retries on 5xx only.
- The seed soul version is created once and reused.
- Polling stops at `awaiting-approval` and at terminal states.
- Logs contain no goal text.
- Lint, typecheck, `@czar/daemon` tests.

## Decision
- Architect ruling under Zaryab's delegation. Recorded by his merge.
