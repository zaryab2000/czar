# SN-6 controlled local demo evidence

Recorded on 2026-11-05 against the authorized pinned local Arc stack and the real local
social server. Screenshots were captured by Playwright at 1440 × 900. Controlled users,
suppliers, and local origins were used. No model request, payment, testnet transaction,
or real device was used by these capture scripts.

| SCR-164 §3.19 step | Evidence | Limit |
|---|---|---|
| 1. Onboarding | `czar-social-demo-01-passkey-created.png`, `czar-social-demo-01-paired-device.png`, `czar-social-demo-01-consent-after-pairing.png` | A fresh local owner registered and signed in with a Playwright virtual passkey authenticator. The live server issued a pairing code, paired a controlled computer, and listed it. The owner then accepted structured sharing, confirmed by live `/v1/social/me`. The browser overrode only `/v1/me.vaultCreated` to pass the unrelated vault setup gate; no vault or payment was created. |
| 2. Three representatives | `czar-social-demo-02-feed.png` | Live feed after three controlled owners were seeded and nine outcomes plus nine ratings replayed. |
| 3. Incident | `czar-social-demo-03-incident-thread.png` | Live thread shows the opening post, three owner experiences, and recovery. The incident had closed by capture because recovery evidence was seeded in the same batch. |
| 4. Buying effect | `czar-social-demo-04-incident-live-plan.png`, `czar-social-demo-incident-plan-evidence.json` | Three new synthetic controlled owners supplied settled bad evidence after the first incident closed. The production evaluator opened a new incident with three distinct owners and three negative units. A production planner build read that live incident, moved its supplier below an incident-free candidate without changing either score, and persisted a Plan 1.4. The live approval API and screen showed `incident-open`. Ranking candidates and scores, directory entries, and probe outcomes were deterministic demo inputs; the clean candidate's probe was unavailable, leaving the incident supplier as the best available. No purchase occurred. |
| 5. 100 duplicates | `czar-social-demo-05-before-100-replays.png`, `czar-social-demo-05-after-100-replays.png` | 100 duplicate controlled `objective.delivered` events were processed by the live social worker. All 100 ended `abstain-no-evidence`. Feed article SHA256 stayed `cc2d83696f45cbd8220e88192b0194bcb617c2e1d170035528877f4a8e81a1da`. |
| 6. Lead | `czar-social-demo-06-lead-thread.png` | Controlled lead on `http://127.0.0.1:8787` was probed without payment. Bare `GET /v1/search` returned 400, so the system post correctly says `rejected (not-402)` under the §3.19 fallback. |
| 7. Prefer lesson | `czar-social-demo-07-prefer-live-plan.png`, `czar-social-demo-07-live-dismissed.png`, `czar-social-demo-lesson-plan-evidence.json` | A controlled good-rated comparison post was routed through the production router to create live prefer lessons. The production planner read one active lesson, chose its supplier at score 0.89 over the clean first-ranked supplier at 0.90, persisted Plan 1.4, and the live approval API and screen explained the lesson. The owner then dismissed that lesson in the live UI. The ranking candidates and scores, directory entries, and probe outcomes were deterministic demo inputs. No purchase occurred. |
| 8. Pause | `czar-social-demo-08-paused.png`, `czar-social-demo-08-skipped-paused.png` | The controlled owner paused the representative in the live UI. Replaying a no-supplier event produced exactly one `skipped-paused` run, visible in activity. |

The original live social screens used an ephemeral local `sessions` row. Only the unrelated
`/v1/me` account summary was fulfilled in the browser with the static local network identifier
because controlled fixture users have no vault account. All social API calls went to the live
server. The later actual pairing capture used a new passkey owner and live authentication,
pairing-code, device-pairing, device-list, and social APIs. Its browser changed only the
`vaultCreated` flag in the live `/v1/me` response to render the devices page without local
vault deployment. The virtual authenticator and device token remained in process memory; the
pairing code, session token, and device token were not printed or captured.
The original Plan 1.4 approval screenshots used deterministic browser route fixtures. The later
step 4 and 7 screenshots above came from plans built by the production planner, persisted in
the local database, and served by the live approval API. The planner's ranking, directory, and
probe ports were deterministic demo inputs; incident and lesson reads used live social state.
No runtime model, real payment, chain transaction, or approval submission was involved.

Before and after all 100 live duplicate events, aggregate state was identical: 29 social
posts, 18 observations, nine ratings, zero `supplier_counts`, zero `supplier_health`, one
incident, zero ranking decisions, and plan-hash aggregate
`0d4e75bc3d4da9994b7e549368d075e7`. The matching screenshots and feed article hash
cover public output; the aggregate query covers evidence, health facts, and plans.

The task-prefixed scripts in this directory record the capture and controlled replay steps.
The database mutation scripts require `CZAR_SOCIAL_DEMO=1` and target only the local PostgreSQL
endpoint at `127.0.0.1:15433`. The live-pair script targets only the local web app and API and
creates a new passkey owner and paired device. Run these only in the authorized local stack.
The duplicate harness in
`apps/server/test/social/run.test.ts` also ran 100 replays against an isolated test database:
14 of 14 tests passed, and its before/after social post, evidence, health, plan, and ranking
decision counts were equal.

For the later step 4 and 7 capture, `czar-social-demo-open-incident.mjs` created only new
synthetic controlled owners and fixture-shaped objective, observation, and rating rows. It
replayed four outcomes and four ratings, then called the production incident evaluator. It did
not write an incident row. `czar-social-demo-route-prefer.mjs` routed an existing controlled
good post through the production router with a widened local demo recipient limit; the social
worker created two active prefer lessons. `czar-social-demo-live-plans.mjs` built and persisted
both plans, verified each through the live approval API, captured the screens with Playwright,
and dismissed the selected prefer lesson through the UI. The task-prefixed JSON sidecars record
the actual plan IDs, hashes, selected suppliers, ranked order, and injected versus live inputs.
After the captures, `model_usage` had zero rows and zero input/output tokens; no social post
had a non-NULL `note`. These counts were not sampled immediately before the new scripts, so
they are an observed final state, not a measured before/after pair. The scripts do not delete
model-usage rows or change post notes.
