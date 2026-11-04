# Agent social network completion report (draft)

## Status and scope

**SN-6 / SCR-164. This report is a draft. Flow 4A's social network is not yet signed off.**
The final evidence must come from one merged `build-v1` head after SN-1 through SN-6. A test
file, a passing package branch, or a mocked browser route does not establish that final result.

The feature lets an owner's representative publish structured purchase experience, questions,
replies and leads. Public posts supply context; only the paying owner's Good or Bad rating enters
supplier quality. Incidents and bounded personal lessons affect the planner under SCR-164 §3.13.
No post, reply count, handle, or model-written note is itself a supplier score.

| Package | Current evidence | Final state |
|---|---|---|
| SN-1 foundation | PR #195 merged at `4c9195d`; public and owner routes, migration and role. | Recheck on final merged head. |
| SN-2 events and worker | Implementation is being integrated; seed and replay must be checked against §3.19. | Pending final merged-head review and tests. |
| SN-3 questions and replies | Implementation is being integrated. | Pending final merged-head review and tests. |
| SN-4 buying routes | Incident, lesson and lead work is being integrated. | Pending final merged-head review and tests. |
| SN-5 web | Local commits `94d4125`, `2fe79e0`, `e59bb40`, `7ec5f93`; integrated on the shared branch. | Real-server Playwright round trip pending. |
| SN-6 controlled demo and report | Fixture commit `0a3031a` is integrated, then formatted in the shared branch. | Demo, final report and merge pending. |

The combined integration branch is not a merged PR. Record its final PR number, reviewed head,
merge commit, and review status here before sign-off. Hosted Actions are unavailable due to billing;
missing, skipped or zero-step hosted jobs are not passing checks.

## Key-free evidence already collected

| Head and scope | Exact command | Observed result | Limit |
|---|---|---|---|
| SN-5 `7ec5f93` with SN-2 template dependency `6e4953a` | `fnm exec --using=22.22.0 pnpm --filter @czar/web exec vitest run packages/social-templates.test.ts packages/social-api.test.ts` | 2 files, 11 tests passed | Includes direct web/server summary parity; no browser or server route round trip. |
| Same local head | `fnm exec --using=22.22.0 pnpm --filter @czar/web typecheck` | Passed | Web package only. |
| Same local head | `fnm exec --using=22.22.0 pnpm lint` | Passed | Repository lint, not functional acceptance. |
| Same local head | `fnm exec --using=22.22.0 pnpm --filter @czar/web build` | Passed; `/social`, `/social/me`, `/social/threads/[id]`, `/onboarding/representative` generated | No Playwright execution. |
| Shared integration snapshot `f5a7167`, reported by the orchestrator | Exact command log pending; reported server/web typecheck, root lint, and schema checker from its required directory | Typecheck and lint passed; schema checker reported 34 files, 0 problems | Later SN-4 privacy tests are intentionally red pending a cross-lane fix; this is not current-head green full-suite evidence. |
| Earlier shared integration snapshot, reported by the orchestrator | Exact command log pending for focused server social tests and web social Vitest | Server social 16/16 and web social 11/11 passed before the intentional red tests | Must rerun on final merged head. |

The fixture contains three controlled owners and three supplier descriptors. It marks only the
`incident-search` supplier as locally registered. The
`comparison-search` and `lesson-search` descriptors are fixture-only; they are not registered
or demo-ready. Do not count them as live suppliers until local configuration and unpaid `GET`
402 handlers are in place. The fixture has not been seeded or replayed.

### Read-only local demo preflight

| Dependency | Current finding | Required before the demo |
|---|---|---|
| Local stack | `ops/local/README.md` specifies `process-compose`; composition starts Arc Anvil, deployment, signer, server, indexer and a merchant. | Operator authorizes and provisions the already specified local key references; confirm loopback endpoints and a clean local chain. |
| Social worker | SN-2 is adding the worker to `ops/local/process-compose.yaml`. | Confirm it starts after migrations and uses the restricted `czar_social` role. |
| Controlled seed/replay | The JSON fixture exists; scripts are SN-2 work. | Review `validateLocalOnlyConfig`, the database host refusal, and idempotent replay before running either command. |
| Supplier set | Two supplier descriptors say `fixture-only`. | Register both in local-only config and provide local unpaid `GET` 402 probe handlers, or record the specified `not-402` fallback. Do not copy these origins into cloud config. |
| Browser | SN-5 UI and a mocked-route Playwright test exist. | Add/run a real-server social spec in `e2e-local` and capture controlled-owner evidence after authorization. |
| Money and model boundaries | No real payment or runtime model call is needed for the controlled fixture. | Keep the demo on the local stack and check `model_usage` remains unchanged. |

## SCR-164 §3.18 acceptance matrix

Each row requires an executable check on the final merged head. “Partial” identifies a useful
test or earlier run, not a pass for the full case.

| # | Required behavior | Test mapping / current evidence | Final merged-head result |
|---|---|---|---|
| 1 | Posts have zero scoring weight; 100 duplicates leave counts, health and decision unchanged | `apps/server/test/social-buying.test.ts`; 100-post invariant still needs a focused test/run | Pending |
| 2 | Five `objective.delivered` replays publish one experience per paid step | `apps/server/test/social/consumer.test.ts`, SN-2 worker tests | Pending |
| 3 | Rating revision supersedes the old post without duplicate publish | SN-2 worker tests; `apps/server/test/social-routes.test.ts` covers revision-chain deletion separately | Pending |
| 4 | Public strings exclude private subjects, paths, addresses, exact amounts and evidence IDs; public day times and random IDs | `apps/server/test/social/denylist.test.ts`, `social/experience-card.test.ts`, `social-routes.test.ts`; current SN-4 privacy regression is red | Pending |
| 5 | Question routing and caps, while service threads remain open | `apps/server/test/social/router.test.ts`; full cap boundaries need final proof | Pending |
| 6 | No-evidence reply abstains without a post | SN-3 routing/worker tests | Pending |
| 7 | Incident open, unit/owner distinction, recovery, no flap, version change, window clear and unknown version | `apps/server/test/social-incidents.test.ts` | Pending |
| 8 | Open incident changes ordering and approval, not score or version guard | `apps/server/test/social-buying.test.ts`; planner integration check | Pending |
| 9 | Lessons obey exact margin and survivor/incident bounds | `apps/server/test/social-buying.test.ts` | Pending |
| 10 | Lead probe and safe-fetch rejection matrix, with no payment | `apps/server/test/social-leads.test.ts`; verify every required edge | Pending |
| 11 | Consent change during a run prevents a post | SN-2 runtime/worker tests | Pending |
| 12 | Two workers on one inbox item publish once | `apps/server/test/social/inbox.test.ts`; worker commit race check | Pending |
| 13 | Before-commit rollback and after-commit replay each yield one post/run | SN-2 runtime/worker fault tests | Pending |
| 14 | Delete tombstones every revision and supersedes derived lessons | `apps/server/test/social-routes.test.ts` | Pending |
| 15 | No model usage and every note stays NULL | SN-2 worker suite plus DB assertion | Pending |
| 16 | `czar_social` cannot read base tables or write rating/ranking/money tables; concurrent migration succeeds | `apps/server/test/social-migration.test.ts` | Pending |
| 17 | `planning → no-supplier` event is transactional and unique | `apps/server/test/planner/service.test.ts` plus SN-2 event test | Pending |
| 18 | Onboarding, public feed, owner tombstone and lesson dismiss in Playwright against local server | `apps/web/e2e/social.spec.ts` has four mocked-route UI checks; real-server `e2e-local` run not done | Pending |
| 19 | All package suites, typecheck, lint, schema checker, Arc slice/runs 2/4/5 and Forge | Commands below; no final merged-head run | Pending |
| 20 | A lower-id event that commits late is delivered once | `apps/server/test/social/consumer.test.ts` | Pending |
| 21 | Sharing-off receives a lesson without publishing; publishing run skips | SN-3/worker tests | Pending |

## Controlled local demo plan and evidence

Run only after the local-only seed/replay safeguards, supplier registration and unpaid probe
handlers are reviewed, and Zaryab authorizes the local stack and its key-producing harnesses.
No seed, stack, payment, model call or device action was performed to prepare this draft.

1. Pair a local fixture owner and complete `/onboarding/representative`; capture the exact
   consent paragraph and saved sharing choice.
2. Seed three controlled representatives, replay their outcomes and show their labelled
   experiences in the public feed and service thread.
3. Replay three distinct owners' bad outcomes against one version; show the incident thread
   and its attached experiences.
4. Plan in that task class; show unchanged score, incident ordering, `incident-open` approval,
   and the exact approval-screen line once its immutable count/wording contract is resolved.
5. Publish 100 duplicate posts in the test harness; compare counts, health and ranking decision
   before and after.
6. Force `no-supplier`, route a `find-supplier` question, submit a controlled lead and show an
   unpaid 402 probe result. If no local merchant answers bare `GET` with 402, show and record
   `not-402` instead of claiming a successful probe.
7. Route a good-rated experience, show a bounded `prefer` lesson and near-tie explanation,
   then dismiss it on `/social/me`.
8. Pause the representative, replay an outcome and show `skipped-paused` in the activity trace.

Record dated screenshots or traces for the feed, incident/thread, approve view, lesson/dismiss,
lead probe and paused activity. Use controlled data only. Add artifact paths and the exact
build head here after the authorized run; no screenshots exist yet.

## Operator-authorized commands: not run for this draft

The local stack start is documented in `ops/local/README.md`. It requires separately
provisioned local signer key references and deployments; the command does not provision them.
The existing `apps/web/e2e-local/local-server-fixture.mjs` writes a temporary run-6 key file
and deploys contracts, so even a browser test using that configuration needs explicit approval.

```sh
# Only after operator approval and local-only configuration preflight:
process-compose -f ops/local/process-compose.yaml up

# Only after verifying the seed script's database-host refusal and fixture registration:
pnpm --filter @czar/server social:seed-controlled --count 3 --network eip155:5042002
pnpm --filter @czar/server social:replay-fixtures

# Key-free merged-head static checks (run before chain work):
fnm exec --using=22.22.0 pnpm -r typecheck
fnm exec --using=22.22.0 pnpm lint
cd docs/specs/02-data-and-protocol/schemas
python3 -I check-schemas.py
cd ../../../..

# Full package suites only after auditing their harnesses for key generation:
fnm exec --using=22.22.0 pnpm -r test

# Pinned local Arc checks; each harness may generate ephemeral keys:
CZAR_LOCAL_CHAIN=1 fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run test/local-pocket/flow-4a-slice-arc.test.ts
CZAR_LOCAL_CHAIN=1 fnm exec --using=22.22.0 pnpm --filter @czar/signer exec vitest run test/local-chain.test.ts
CZAR_LOCAL_CHAIN=1 fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run test/local-pocket/pocket-arc.test.ts
CZAR_LOCAL_CHAIN=1 fnm exec --using=22.22.0 pnpm --filter @czar/server exec vitest run test/local-pocket/crash-restart-arc.test.ts
cd contracts
FOUNDRY_PROFILE=arc arc-forge test
cd ..

# Browser round trip after adding a real-server social spec under apps/web/e2e-local:
fnm exec --using=22.22.0 pnpm --filter @czar/web e2e:local-server
```

The `pnpm -r test` command can report intentional skipped Arc suites; record pass/skip counts
per package and run the Arc suites above separately. Run the schema checker from its own
directory; invoking it at the repository root checks nothing. Use the pinned `arc-anvil` and
`arc-forge`, never standard Foundry substitutions. Restore any Forge-written snapshot before
reporting a clean diff.

For a public-feed screenshot after the approved local stack is running, start web separately
with `CZAR_SERVER_URL=http://127.0.0.1:3000 fnm exec --using=22.22.0 pnpm --filter @czar/web exec next dev --hostname localhost --port 3001`, then:

```sh
pnpm --filter @czar/web exec playwright screenshot --browser chromium \
  --wait-for-timeout 1000 http://localhost:3001/social /private/tmp/czar-social-feed.png
```

Capture owner-only views only in an authenticated controlled-owner browser session; never put
session tokens in command arguments, logs or screenshot filenames. Copy reviewed image artifacts
to the final report's evidence location and link them here after the run.

## Builder decisions, review and open work

- **Builder decisions:** record final per-package choices with file and line after the bundled
  integration review. No unapproved specification change is implied by this draft.
- **Defects fixed / found, not fixed:** populate from the exact final PR diff and review findings.
  Current SN-4 privacy regressions require a test-first fix before the full suite can pass.
- **Independent review:** pending. Give a fresh reviewer only the combined diff, `CLAUDE.md`,
  SCR-164 and the bounded defect brief in the orchestrator's definition of done. Record its
  concrete findings, fixes and final-head rerun.
- **Open product items:** model-written notes, agent-suggested ratings, discovery that lets
  probed leads become buyable, and A2A remain outside SCR-164's completed scope.
- **Remaining gate:** SN-1 through SN-6 merged into `build-v1`, all 21 cases verified on that
  merged head, authorized local demo with screenshots, independent review, and Zaryab sign-off.
