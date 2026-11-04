# THE AGENT SOCIAL NETWORK: ORCHESTRATOR BRIEF (build stage)

- **From:** chief architect
- **Date:** 2026-11-05
- **Base:** `build-v1` with SCR-164 merged (the PR that adds this brief)
- **What you own, end to end:**
  - dispatch every lane
  - monitor every lane
  - review every PR
  - unblock builders yourself
  - deliver one final report
- **Escalation:** to the architect **only** for the cases in §6. Everything else you decide yourself, using the rules in §5.
- **Merging:** Zaryab merges every PR into `build-v1`. Nobody else merges.

---

## 1. Source of truth (read in full before dispatching anything)

1. **`docs/specs/06-review/change-requests/SCR-164-agent-social-network.md`:** the normative specification.
   - §1: decisions
   - §3.0: the five rules
   - §3.1–§3.19: the design
   - §3.18: the acceptance tests
   - §4: the packages
2. **The files SCR-164 amended:**
   - `docs/specs/02-data-and-protocol/schemas/social-*.schema.json`, `plan.schema.json` (1.4), `common.schema.json` (social ids)
   - `docs/specs/02-data-and-protocol/api/openapi.yaml`, tag `social` (12 operations and the `Social*` schemas)
   - `docs/specs/04-components/shared/cross-cutting.md` §4 (logging allowlist) and §5.1 (error codes)
   - The generated `@czar/schemas` types and the `@czar/api-contract` operations already exist in `build-v1`.
3. **The system the social network plugs into** (all built; read the code):
   - SCR-160, SCR-162 and SCR-163 (ratings, health facts, ranking, service versions)
   - `reports/flow-4a-complete.md`
4. **`CLAUDE.md`** at the repository root. Every rule applies to every lane.

- **Not a source of truth:** anything in `docs-internal/`, or any earlier social network document. Where they differ from SCR-164, SCR-164 wins.
- **Vocabulary:**
  - **representative:** one per owner, run on the server
  - **card:** the structured, public content of a post
  - **rating:** the owner's Good or Bad, as built
  - **incident, lesson, lead:** the three routes into buying (SCR-164 §3.13)

---

## 2. What the social network is (one paragraph for every builder)

- **Every Czar owner gets one server-hosted representative.**
  - When the owner's task finishes, the owner rates it, or no supplier is found, the representative posts a structured card to a shared, public board. It may also ask the board a structured question.
  - The card says which supplier did what kind of task, whether it delivered, the owner's own rating, and links to the paid-call evidence.
- **Routing:** the board routes each post to at most 3 representatives whose owners actually paid that supplier or need that kind of work. They reply with their own owner's evidence, or stay silent.
- **Into buying:** what the board learns reaches buying only three ways:
  - **an incident:** 3 or more distinct owners had bad outcomes with one supplier version in 14 days, so it ranks below incident-free suppliers and needs approval
  - **a personal lesson:** another owner's experience tips a near-tie
  - **a lead:** a suggested supplier is probed safely
- **Never:**
  - A post changes no score.
  - A representative judges nothing; only the owner's rating is a judgement.
  - No model is called.
  - No money is touched.

---

## 3. Packages, lanes, order (SCR-164 §4)

| Pkg | Title | Lane | Starts when | Main paths |
|---|---|---|---|---|
| SN-1 | Foundation | Lane 1 | now | `apps/server/migrations/0023-social.sql`; `apps/server/src/social/{representatives,threads,posts,routes}.ts`; `apps/server/src/devices/pair.ts` (representative creation only); route mounting in `apps/server/src/app.ts`; `packages/config/src/registry.ts` (`social.*` keys) |
| SN-2 | Events and worker | Lane 2 | SN-1 merged | `apps/server/src/social/{consumer,inbox,worker-main}.ts`, `runtime/*`, `projection/*`; `objective.no-supplier` in `apps/server/src/planner/service.ts`; `ops/local/process-compose.yaml` (worker); `apps/server/scripts/seed-controlled-representatives.ts` and the replay script |
| SN-3 | Questions, replies, routing | Lane 2 | SN-2 merged | `apps/server/src/social/router.ts`, subscriptions, the question, reply and attach actions, expiry |
| SN-4 | Routes into buying | Lane 3 | SN-3 merged | `apps/server/src/social/{incidents,lessons,leads}.ts`; call sites in `apps/server/src/selection/registered/index.ts` and the planner; Plan 1.4 emitters |
| SN-5 | Web | Lane 5 | SN-1 merged; final round trip after SN-4 | `apps/web/app/social/**`, `apps/web/app/onboarding/representative`, the approve-screen lines, the Home tile |
| SN-6 | Demo and completion report | Lane 4 | SN-4 and SN-5 merged | the SCR-164 §3.19 demo, full verification, `reports/social-network-complete.md` |

- **Critical path:** SN-1 → SN-2 → SN-3 → SN-4 → SN-6.
- **In parallel:**
  - SN-5 starts after SN-1, against the real routes with seeded data.
  - Lane 4 may build the controlled-evidence fixtures (`apps/server/test/social/fixtures/controlled-evidence.json`) early, for SN-2's seed script.
- **File ownership:**
  - A lane touches only its package's paths and their tests.
  - When two packages need the same file (for example `app.ts` route mounting, or `registry.ts` keys), the later one rebases onto the earlier merge. You sequence it; nobody edits another lane's open branch.
- **Parallel production work (not yours, do not touch):** the chief architect is building production work in parallel under SCR-170, in `ops/cloud/**`, `packages/config/src/registry-production.ts`, new `cloud-main.ts` files, and the signer, daemon and merchants packages.
  - **Ranges for this build:**
    - migrations `0023`–`0029`
    - spec-change numbers SCR-165–SCR-169, if the architect ever issues any
  - **Never edit** `registry-production.ts` or anything under `ops/cloud/`.
  - If a `pnpm-lock.yaml` or config-snapshot conflict appears with production work, regenerate it (`pnpm install`, `vitest -u`). Never hand-merge it.
- **Branches:** each package is one branch `social/sn-<n>-<slug>` from `build-v1` and one PR into `build-v1` (SCR-164 §4). There is no `social/integration` branch; production checks overlap against SCR-170 §7's reserved paths.

---

## 4. Per-package notes (SCR-164 is the specification; these are the traps)

### SN-1 Foundation (Lane 1)

- **Migration `0023-social.sql`:** the DDL of SCR-164 §3.4 verbatim, plus the views and the role block of §3.17.
  - Create the role inside the `IF NOT EXISTS` block. Roles are cluster-wide, and the test helper creates one database per suite.
- **Check before writing the views:** read the real JSON keys of `steps.step` (Plan `Step`: `capability`, `kind`, `serviceId`, `unitAmount`) and of `objectives.submission` (`taskSpec.output.format`). Adapt the view, not the social code.
- **Representative creation** goes inside the pairing transaction in `devices/pair.ts`, and lazily in `getSocialMe`. Nothing else in `pair.ts` changes.
- **Public routes** use `security: []` and `social.publicReadRateLimitPerMinute` per socket remote address (SCR-164 §3.14). No forwarded-for header is trusted.
- **Owner routes** use the existing app-session verifier, rate limit and `Idempotency-Key` helper, as `apps/server/src/app/results.ts` does.
- **Tests:**
  - acceptance 14 (tombstone, the parts that exist in SN-1) and 16 (permissions: as `czar_social`, writes to `observations`, `ratings`, `supplier_counts`, `supplier_health` and `ranking_decisions` fail)
  - `@czar/api-contract` validation of every response in the route tests

### SN-2 Events and worker (Lane 2)

- **Worker database role:** the worker runs `SET ROLE czar_social` on every pooled connection.
- **Consumer:** reads `outbox_events` after its own cursor and never touches `delivered_at` (that belongs to the planner's consumer).
- **The card is built from the evidence tables only:**
  - `observations` (settled, unreleased, by `objective_id` and `step_index`)
  - `ratings_effective` for the rating
  - the projection views for capability and output format
  - the amount band from the step's `unitAmount` × `callsPaid` (a job: its budget)
- **Denylist:** applied to every outgoing string before commit. Any hit means no post at all.
- **`objective.no-supplier`:** written in the same transaction as the `planning → no-supplier` update in `planner/service.ts`. Nothing else in that file changes in SN-2 (SN-4 owns the planner's choice logic).
- **Tests:** acceptance 2, 3, 4, 6, 11, 12, 13, 15 and 17.

### SN-3 Questions, replies, routing (Lane 2)

- **Recipients:** at most 3 per post, chosen by the §3.12 scoring with the rotation tie-break. A full thread routes nobody.
- **Silence is a recorded run** (`abstain`), never an error.
- **Tests:** acceptance 5 and 6.

### SN-4 Routes into buying (Lane 3): the only package that touches buying

- **Tests first, always.** It moves no money, but it changes which supplier gets paid.
- **Incidents:**
  - pure SQL over the evidence tables
  - join `rating_receipts` → `ratings_effective` on `rating_id`, because a correction moves receipts
  - count distinct owners; exclude controlled owners unless `social.incidentsCountControlled`
- **The selection call site** (`registered/index.ts`):
  - after the existing ordering, add the badge and `features.incident`, then stably move incident entries below the rest
  - scores unchanged
  - the stored `RankingDecision` keeps every entry's `version_id`, so the SCR-163 §6 drift guard must still pass (prove it with a test)
- **The planner:**
  - `"incident-open"` goes into `approvalReasons` (the existing earned-autonomy guard then applies by itself)
  - lessons change only the single choice, inside `social.lessonMaxScoreDelta × strength`, and never choose an `unverified[]` entry
  - `why.lessons[]` is written
  - the Plan `schemaVersion` becomes `"1.4"` when either field is written
- **Leads:**
  - use the existing `createSafeProber` (`planner/probe.ts`) and the `@czar/x402` safe-fetch rules
  - no lead enters buying in this iteration
- **Tests:** acceptance 1, 7, 8, 9 and 10.
- **After this package:** the full server suite, the arc-anvil slice, and runs 4 and 5 (commands in `reports/flow-4a-complete.md`).

### SN-5 Web (Lane 5)

- **UI is the builder's call.** Follow the existing app's look; keep SCR-164 §3.15's content, wording and rules exact.
- **`/social` and thread pages work without login.** `/social/me` needs the app session.
- **Templates:** keep a copy in `apps/web/lib/social-templates.ts`, with a test that compares it to the server's.
- **Tests:** acceptance 18, with Playwright against the local server fixture (`apps/web/e2e-local`, `playwright.local-server.config.ts`). No testnet.

### SN-6 Demo and completion report (Lane 4)

- **The SCR-164 §3.19 demo:** on the local stack with controlled representatives. No testnet money.
- **Verification:** acceptance 19 and the full verification of §8 below.

### Every package, without exception

- **Tests first:** the PR has a commit with failing tests before the code commit. Paste the red-then-green evidence.
- **PR body = the `CLAUDE.md` task report:**
  - package id
  - files changed
  - exact commands and results
  - "Builder decisions" (§5)
  - "Found, not fixed"
  - spec gaps
- **Minimum verification:**
  - `pnpm -r typecheck`
  - `pnpm lint`
  - the touched packages' full test suites
  - the server suite baseline on `d9fb168`: 82 files, 606 passed. It only grows.
  - `receipt-arc.test.ts` is a known intermittent test (SCR-158 §1). Re-run it alone once on failure, and record both results.
- **Logging allowlist** (`cross-cutting.md` §4):
  - allowed: the social ids, `action`, `stopReason`, `routingReason`, counts
  - never logged: card contents, handles beside user ids, lead origins
- **Builders never:**
  - edit `docs/specs/`
  - call a model
  - touch testnet
  - read secrets
  - merge
  - edit the production paths in §3

---

## 5. Decision rules (you and the builders decide with these; no escalation)

1. **Spec silent or ambiguous.** Choose the option that:
   - (a) keeps every SCR-164 §3.0 rule: no ranking writes, no money, no private text, one evidence unit counted once, silence allowed
   - (b) shares less about the owner
   - (c) fails closed: no post rather than a partial post; approval required rather than auto-open
   - (d) adds no config key unless a number is unavoidable (then add one, with a default and reason, in `registry.ts`)
   - (e) is the smallest change

   Record it under "Builder decisions" with file:line.
2. **A defect found while working:**
   - one that can leak private text onto the board, let a post change a score, or change which supplier is paid outside SN-4's rules: fix it test-first in the PR it belongs to
   - anything else: "Found, not fixed"
3. **A test that existed before and now fails:** find the cause; fix it when it's this PR; record an old flake and continue.
4. **Merge conflicts:** the later PR rebases onto `build-v1`. Never force-push `build-v1`.
5. **Your review before you hand a PR to Zaryab:** check it against its SCR-164 section, the §3.0 rules, the tests-first evidence and the task report. Send it back to the lane yourself when it fails.

---

## 6. When to escalate to the architect (only these)

- Escalate **only** when one of these is true. Send one message, with the evidence and your proposed answer.
  1. **A spec contradiction** that the decision rules can't resolve without breaking a §3.0 rule.
  2. **A needed edit under `docs/specs/`.**
  3. **A change needed in the buying path** (selection, planner, payer) beyond what SN-4 owns.
  4. **Any need for** a model, testnet funds, keys, a sign-up, a real device or secrets. These go to Zaryab, copied to the architect.
  5. **A package blocked for more than 3 hours** with no path under the decision rules.
- **Everything else is yours:** naming, file layout, test design, UI, minor wording, refactors inside a package, flaky tests, and merge order inside the dependency graph.

---

## 7. Monitoring and reporting

- **Track every package as:** dispatched → tests red → green → PR open → your review passed → ready for Zaryab → merged.
- **Status line to Zaryab** at every PR that is ready to merge: the PR number, the package, a one-line result, and its place in the merge order. No other interim updates unless he asks.
- **Merge order:** strictly the dependency order of §3. Tell Zaryab which PR is next whenever one merges.

---

## 8. Definition of done (the social network complete)

1. SN-1 to SN-6 are merged into `build-v1`.
2. All 19 acceptance tests of SCR-164 §3.18 pass on the merged head, plus:
   - `pnpm -r typecheck` and `pnpm lint`
   - every package suite
   - `python3 -I docs/specs/02-data-and-protocol/schemas/check-schemas.py`
   - the arc-anvil slice and runs 2, 4 and 5
   - `FOUNDRY_PROFILE=arc arc-forge test`
3. The SCR-164 §3.19 demo has run and is recorded with screenshots.
4. **Independent review:** a fresh reviewer agent that has not seen the work gets only:
   - the combined SN diff
   - `CLAUDE.md`
   - SCR-164
   - the instruction: "Find defects that let private text reach the board, let a post or anything other than a rating change a score, change which supplier is paid outside SCR-164 §3.13, double-count an evidence unit or an owner, or let the social role write ranking or payment tables. Report each as file:line plus a concrete failure scenario."

   Fix every critical finding test-first; record the rest.
5. **Final report** in `reports/social-network-complete.md`, opened as a PR. It contains:
   - PRs and SHAs
   - exact test results
   - each acceptance test mapped to its test file
   - the demo evidence
   - builder decisions
   - defects fixed and not fixed
   - review findings
   - open items (model-written notes, agent-suggested ratings, leads into buying with supplier discovery, A2A)
