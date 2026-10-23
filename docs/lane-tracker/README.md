# Czar lane tracker

Run from the repository root with pinned Node 22:

```sh
fnm exec --using=22.22.0 pnpm tracker
```

Open **http://127.0.0.1:4319**. The tracker binds only to loopback and makes no hosted calls.
It does not need Postgres, the signer, Arc Anvil, GitHub Actions, or new dependencies.

## Using the board

- Choose a lane, search tasks, or filter by status.
- Use **Add task** or **Edit** to change scope, owner, priority, status, blockers, acceptance,
  and evidence. Saves update `docs/lane-tracker/tasks.json` immediately.
- Expand a card to see acceptance criteria and evidence.
- **Reload** picks up changes made by another browser or an agent.
- A stale save is rejected rather than overwriting somebody else's changes. Reload the latest
  tasks while keeping your draft, review the changes, then save deliberately.
- **Export JSON** downloads a backup. Repository persistence does not depend on browser storage.

The initial 48 tasks reflect the 2026-10-23 audit at `59ffdb6`. Lanes 3 and 4 are explicitly
not audited. Implementation, merged PRs, deferred checks, and accepted tasks have distinct states.
An accepted/verified task requires acceptance criteria and supporting evidence.

## Updating as an agent

The JSON file is the operational tracker; canonical specifications remain authoritative.
Read the tracker before selecting lane work. Add an item for new scope; record progress,
blockers, PR URLs, reviewed SHAs, and exact validation evidence as work proceeds.
Do not mark a task accepted merely because its PR merged.

Agents can use the same atomic save API as the browser: GET `/api/tasks`, preserve its ETag,
then PUT the updated document with `Content-Type: application/json`, `If-Match: <ETag>`,
and `Origin: http://127.0.0.1:4319`. A stale document returns 409. Only the fixed tracker
file is writable through this API. For direct file edits, stop the server first and preserve
all task IDs and other lanes' entries. Do not run multiple tracker servers against one file.

Edits stay local until committed and merged through a PR into `build-v1`. Keep tracker data
with the associated implementation PR where practical. Never put secrets or private payloads
in task descriptions or evidence.

## Checks

```sh
node --test scripts/lane-tracker.test.mjs
```

This tracker does not start builders, subscribe to GitHub, or merge PRs. Review/fix automation
continues to follow `docs/pr-review-workflow.md`.
