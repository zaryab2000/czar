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
- **`redaction`:** from `@czar/redaction` layer 2 over `goal` and the `taskSpec` values. Counts and entity names only.
  - If layer 2 finds an unmarked hit, the command refuses to send and prints the entity names, not the text.
- **`objectiveHash`:** computed with `@czar/hashing` `objectiveHash`. The server recomputes it (a mismatch gives `422`).

### After submitting
- The command prints `objectiveId`.
- It polls `GET /v1/objectives/{id}` every `daemon.objectivePollSeconds` until the objective reaches `awaiting-approval` or a terminal state. It prints each state change.
- At `awaiting-approval` it prints the approval URL, `<app origin>/approve/<planId>`.

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
- A planted secret in `goal` is refused before sending.
- The seed soul version is created once and reused.
- Polling stops at `awaiting-approval` and at terminal states.
- Logs contain no goal text.
- Lint, typecheck, `@czar/daemon` tests.

## Decision
- Architect ruling under Zaryab's delegation. Recorded by his merge.
