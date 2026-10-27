# Builder coordination — Phase 1 parallel lanes

This file is context for every builder agent. Read it before starting any task.

---

## How we work

- **5 builder agents** run in parallel, each in its own lane with its own worktree.
- **The architect** remains the authority for canonical specifications and decisions.
- **Codex GitHub review** reviews builder PRs; **Zaryab's designated Codex reviewer session**
  prepares task briefs and performs final review. Builders fix findings on their own PR branches.
- **Zaryab** merges PRs and approves anything that touches testnet funds, sign-ups, or real devices.
- Base branch for all work: **`build-v1`**.
- Actions minutes are unavailable; verification runs locally. Existing workflows remain in
  `.github/workflows/`; failed, missing, or skipped hosted checks are not passing evidence.
- No Czar runtime hosted model calls until G0-16 terms are recorded and K18 is approved.
  Product model tests use recorded replies. Zaryab has separately authorized Codex GitHub
  code and security review of repository source and PR diffs; this does not satisfy G0-16/K18.
- Read `docs/pr-review-workflow.md` for review requests, builder polling, fixes, and final review.
- Testnet deployment is deferred until most backend and frontend builds are ready (D92).

---

## Lane assignments

Each lane owns specific folders. **Work only in your lane's folders.** Do not edit files owned by
another lane.

### Lane 1 — Contracts and chain

- **Owns:** `contracts/`, `packages/vault-client/`, `apps/signer/`, `deployments/`, `env/`, `apps/indexer/`, `ops/` (SCR-136)
- **Task queue:** T-026 → T-022 → T-105 → T-036 → T-037 → T-040
- **Track A (SCR-136):** TA-01, TA-02, TA-03, TA-04, TA-07, TA-10, TA-11,
  then T-124 (TA-20) and the T-125 encoder and indexer part (TA-22a). Briefs are local
  and gitignored at `docs-internal/builder-prompts/track-a/`; Zaryab supplies the relevant
  lane prompt to each builder.
- **Local arc-anvil port:** 8545

### Lane 2 — Server payments and runtime

- **Owns:** `apps/server/src/boundary/`, `apps/server/src/payer/`, `apps/server/src/evidence/receipts.ts` (file), and the server core: `apps/server/src/main.ts` (SCR-126 §2), `local-main.ts`, `local-app.ts`, `index.ts`, `planner/`, `objectives/`, `router/`, `db/`, `models/`, `object-store.ts` (SCR-136)
- **Task queue:** T-046 → T-048 → T-049 → T-052 → T-054 (done or in review); Track A: T-122 (TA-08, TA-09), T-085 server listener (TA-12), T-053 (TA-21), T-125 server part (TA-22b), then T-050a
- **Local arc-anvil port:** 8546

### Lane 3 — Acceptance, evidence, selection and supply

- **Owns:** `apps/server/src/acceptance/`, `apps/server/src/evidence/` (except `receipts.ts`), `apps/server/src/selection/`, `apps/merchants/` (SCR-136)
- **Task queue:** T-047 (merged); Track A: T-123 (TA-06), T-043 reopened (TA-05). T-056, T-057, T-058, T-055, T-090, T-091, T-115 follow the evidence and social-network replan (Track B)
- **Local arc-anvil port:** 8547

### Lane 4 — Daemon and plugins (Mac side)

- **Owns:** `apps/daemon/`, `apps/redact-sidecar/`, `plugins/`, `apps/mcp/`
- **Task queue:** T-109 → T-062 → T-063 → T-066 → T-068 → T-069 → T-073 (held: re-planned with the evidence and social-network layer, Track B)
- **Local arc-anvil port:** 8548

### Lane 5 — Web app

- **Owns:** `apps/web/`, `apps/server/src/app/`, `apps/server/src/app.ts` (route registration), `apps/server/src/http/`, `apps/server/src/devices/` (SCR-136)
- **Task queue:** T-081 → T-084 → T-086 → T-082 (merged); Track A: TA-14, TA-16, TA-13, TA-15, T-125 app part (TA-22c)
- **Local arc-anvil port:** 8549

---

## Worktree setup

Each builder works in its own git worktree, not in the main checkout.

```bash
git worktree add ../czar-<lane> -b codex/t<NNN>-<slug> origin/build-v1
```

- Replace `<lane>` with your lane number (1–5).
- Replace `<NNN>` with the task number and `<slug>` with a short kebab-case name.
- One task per branch. One branch per PR.

---

## Shared packages — conflict rules

These packages are shared across lanes: `@czar/schemas`, `@czar/hashing`, `@czar/config`,
`@czar/api-contract`.

- Edit a shared package **only** where your task requires it.
- Put the shared-package change in a **separate small commit** so the architect can review it in
  isolation.
- **Config registry:** append keys only. Never rename or remove an existing key. Keys named in an accepted SCR are added by the architect in the spec-application branch; builders do not add them (SCR-136).
- **Server routes:** a lane registers its own non-app routes in `apps/server/src/app.ts` in a separate small commit that Lane 5 reviews (SCR-136).
- **Migrations:** each lane adds migrations for its own tables in `apps/server/migrations/` (SCR-136); fetch `origin/build-v1` before opening the PR and check migration numbering.
  Merge base updates into a published branch; do not rewrite already pushed commits.
  Recheck numbering after other migration PRs merge.

---

## What you must not do

1. **Do not edit another lane's folders.** If your task needs a change there, describe it in your
   task report and stop that item.
2. **Do not edit anything under `docs/specs/`, `docs/product/`, or `docs/architecture/`.** Spec gaps
   are filed as SCRs using `docs/specs/05-build-plan/spec-change-request-template.md`.
3. **Do not invent fields, routes, functions, events, parameters, or versions.** If it is not in the
   specs, it does not exist yet.
4. **Do not make Czar runtime hosted model calls.** Product model tests use recorded replies
   until G0-16/K18 approval. Codex GitHub source/PR review is separately authorized.
5. **Do not deploy to testnet, request funds, create accounts, or use real devices.** These require
   Zaryab's explicit approval.
6. **Do not read, print, log, or commit private keys, seed phrases, API keys, `*.key`, `*.key.json`,
   or `.env*` files.** Keys live behind the signer service, never in code or environment variables.
7. **Do not merge your PR.** Open it into `build-v1`, post your report, and handle the review/fix
   loop in `docs/pr-review-workflow.md`. Request final review after fixing confirmed findings.
8. **Do not start the next task** until the reviewer confirms the current PR was merged.

---

## Postgres

- Tests use `127.0.0.1:15432`.
- Each test suite creates its own random database (`czar_t_<hex>`), so suites can run in parallel
  without conflicts.

---

## Task completion checklist

A task is done when:

1. Every acceptance test listed in the task passes locally.
2. A PR is opened into `build-v1` with the branch `codex/t<NNN>-<slug>`.
3. A task report is posted containing:
   - Task ID and title
   - Files changed
   - Test commands and their results
   - SCRs filed, if any
   - Open issues and anything you could not verify

After implementation, stay active for the review/fix loop or explicitly report that the
builder session must be resumed. Awaiting final review is not permission to merge; Zaryab
merges only after the designated reviewer's recommendation for the current head SHA.

---

## Review priority

The final reviewer prioritizes PRs in this order: Lane 1, Lane 2, Lane 3, Lane 5, Lane 4.

---

## Builder preamble (copy into each builder's system prompt)

```
You are a Czar builder on LANE <N> (<lane name>). Other builders work in parallel on other lanes.

- At startup, read AGENTS.md, SECURITY.md, docs/builder-coordination.md, and
  docs/pr-review-workflow.md. The review/fix loop is part of every assigned task;
  do not wait for another prompt to activate it or stop after opening the PR.
- Work only in your worktree: ../czar-<lane>. Branch: codex/t<NNN>-<slug> from the latest
  origin/build-v1.
- For an existing task, preserve your work, fetch origin, and merge origin/build-v1 into
  your feature branch. Continue the existing task and PR rather than creating duplicates.
- You own: <folders>. Do not edit other lanes' folders. Edit shared packages (schemas, hashing,
  config, api-contract) only where your task requires it, in a separate small commit.
- Config registry: append keys only. Migrations: fetch origin/build-v1, check numbering, and merge
  base updates into published branches; never rewrite pushed commits.
- Your local arc-anvil port is <port>. Postgres: 127.0.0.1:15432 (tests create their own database).
- No Czar runtime hosted model calls (product model tests use recorded replies). Codex GitHub
  source/PR review is authorized. No testnet, no funds, no accounts, no keys.
- Never edit docs/specs, docs/product, docs/architecture. Spec gap → stop that item, describe it as
  an SCR in your report, continue with the rest.
- Implementation handoff = acceptance tests pass locally + PR into build-v1 + task report.
- Every PR targets build-v1. Stay active and poll submitted reviews, inline comments,
  discussion comments, reactions, and task/check status about once a minute while a requested
  review is pending, for at most 30 minutes.
- The automatic PR-open Codex code/security pair is review run 1. Aim for two runs per PR;
  three is the absolute maximum, including manual requests. Count runs across all heads and
  sessions on this PR. Do not reset the count by changing branch or opening a duplicate PR.
- Independently validate findings against canonical specifications. Fix confirmed in-scope
  defects in one batch, run relevant checks, push, and explain fixes with commit SHA and evidence.
  Opening/pushing your task PR and posting review requests and fix explanations are authorized.
- Request run 2 after the consolidated fix batch. Request run 3 only for a confirmed blocking
  P0/P1, money-path, or security fix, or when the final reviewer explicitly asks. Never request
  run 4 or re-request merely because a push occurred. Record code/security states honestly.
- After the budget or 30 minutes without completion, stop the bot loop and hand the latest SHA
  to the final reviewer for a current-head check. Escalate any unresolved blocking finding or
  specification/ownership gap. A stale or unfinished bot review is never a pass.
- Report awaiting final review with PR URL, head SHA, validation evidence, unresolved findings,
  and skipped checks. Do not merge the PR or start another task.
```

Fill in `<N>`, `<lane name>`, `<folders>`, `<port>` from the lane table above.
Use this preamble for every lane, including lanes started later. Existing sessions need to
reload these instructions once; new sessions that receive this preamble start the loop by default.
