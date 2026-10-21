# Builder coordination — Phase 1 parallel lanes

This file is context for every builder agent. Read it before starting any task.

---

## How we work

- **5 builder agents** run in parallel, each in its own lane with its own worktree.
- **1 architect** (Claude, in Zaryab's session) reviews every PR, fixes bugs on the PR branch, and tells Zaryab when a PR is safe to merge.
- **Zaryab** merges PRs and approves anything that touches testnet funds, sign-ups, or real devices.
- Base branch for all work: **`build-v1`**.
- No hosted CI. All verification is local test runs.
- No hosted model calls until G0-16 terms are recorded and the K18 account is approved. All model tests use recorded replies (offline mode).
- Testnet deployment is deferred until most backend and frontend builds are ready (D92).

---

## Lane assignments

Each lane owns specific folders. **Work only in your lane's folders.** Do not edit files owned by another lane.

### Lane 1 — Contracts and chain

- **Owns:** `contracts/`, `packages/vault-client/`, `apps/signer/`, `deployments/`, `env/`
- **Task queue:** T-026 → T-022 → T-105 → T-036 → T-037 → T-040
- **Local arc-anvil port:** 8545

### Lane 2 — Server payments

- **Owns:** `apps/server/src/boundary/`, `apps/server/src/payer/`, `apps/server/src/receipts/`
- **Task queue:** T-046 → T-048 → T-049 → T-050 → T-052 → T-054
- **Local arc-anvil port:** 8546

### Lane 3 — Acceptance and evidence

- **Owns:** `apps/server/src/acceptance/`, `apps/server/src/evidence/`
- **Task queue:** T-047 → T-056 → T-057 → T-058 → T-055
- **Local arc-anvil port:** 8547

### Lane 4 — Daemon and plugins (Mac side)

- **Owns:** `apps/daemon/`, `apps/redact-sidecar/`, `plugins/`, `apps/mcp/`
- **Task queue:** T-109 → T-062 → T-063 → T-066 → T-068 → T-069 → T-073
- **Local arc-anvil port:** 8548

### Lane 5 — Web app

- **Owns:** `apps/web/`, `apps/server/src/app/`
- **Task queue:** T-081 → T-084 → T-086 → T-082
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

These packages are shared across lanes: `@czar/schemas`, `@czar/hashing`, `@czar/config`, `@czar/api-contract`.

- Edit a shared package **only** where your task requires it.
- Put the shared-package change in a **separate small commit** so the architect can review it in isolation.
- **Config registry:** append keys only. Never rename or remove an existing key.
- **Migrations:** before opening your PR, rebase on `origin/build-v1` and rename your migration file to the next free number.

---

## What you must not do

1. **Do not edit another lane's folders.** If your task needs a change there, describe it in your task report and stop that item.
2. **Do not edit anything under `docs/specs/`, `docs/product/`, or `docs/architecture/`.** Spec gaps are filed as SCRs using `docs/specs/05-build-plan/spec-change-request-template.md`.
3. **Do not invent fields, routes, functions, events, parameters, or versions.** If it is not in the specs, it does not exist yet.
4. **Do not make hosted model calls.** All model tests use recorded replies until G0-16 is done.
5. **Do not deploy to testnet, request funds, create accounts, or use real devices.** These require Zaryab's explicit approval.
6. **Do not read, print, log, or commit private keys, seed phrases, API keys, `*.key`, `*.key.json`, or `.env*` files.** Keys live behind the signer service, never in code or environment variables.
7. **Do not merge your PR.** Open the PR into `build-v1`, post your task report, and wait for the architect's review.
8. **Do not start the next task** until the architect says the current PR is merged.

---

## Postgres

- Tests use `127.0.0.1:15432`.
- Each test suite creates its own random database (`czar_t_<hex>`), so suites can run in parallel without conflicts.

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

---

## Review priority

The architect reviews PRs in this order: Lane 1, Lane 2, Lane 3, Lane 5, Lane 4.

---

## Builder preamble (copy into each builder's system prompt)

```
You are a Czar builder on LANE <N> (<lane name>). Other builders work in parallel on other lanes.

- Work only in your worktree: ../czar-<lane>. Branch: codex/t<NNN>-<slug> from the latest origin/build-v1.
- You own: <folders>. Do not edit other lanes' folders. Edit shared packages (schemas, hashing, config, api-contract) only where your task requires it, in a separate small commit.
- Config registry: append keys only. Migrations: before opening the PR, rebase on origin/build-v1 and rename your migration to the next free number.
- Your local arc-anvil port is <port>. Postgres: 127.0.0.1:15432 (tests create their own database).
- No hosted model calls (all model tests use recorded replies). No testnet, no funds, no accounts, no keys.
- Never edit docs/specs, docs/product, docs/architecture. Spec gap → stop that item, describe it as an SCR in your report, continue with the rest.
- Finish = all acceptance tests pass locally + PR opened into build-v1 + task report (task, files, commands and results, SCRs, open issues). Do not merge. Do not start another task.
```

Fill in `<N>`, `<lane name>`, `<folders>`, `<port>` from the lane table above.
