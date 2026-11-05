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
| 4. Buying effect | `czar-social-demo-04-incident-approval-fixture.png` | Deterministic Plan 1.4 browser fixture shows exact incident approval copy and lesson supplier attribution. The live stack did not create a new plan; incident ranking is covered by `test/social-buying.test.ts`. |
| 5. 100 duplicates | `czar-social-demo-05-before-100-replays.png`, `czar-social-demo-05-after-100-replays.png` | 100 duplicate controlled `objective.delivered` events were processed by the live social worker. All 100 ended `abstain-no-evidence`. Feed article SHA256 stayed `cc2d83696f45cbd8220e88192b0194bcb617c2e1d170035528877f4a8e81a1da`. |
| 6. Lead | `czar-social-demo-06-lead-thread.png` | Controlled lead on `http://127.0.0.1:8787` was probed without payment. Bare `GET /v1/search` returned 400, so the system post correctly says `rejected (not-402)` under the §3.19 fallback. |
| 7. Prefer lesson | `czar-social-demo-07-prefer-lesson.png`, `czar-social-demo-07-dismissed-lesson.png`, `czar-social-demo-07-prefer-approval-fixture.png` | A live controlled good-rated comparison experience was routed and yielded a prefer lesson for an owner with no evidence for that supplier. The owner dismissed it in the live UI. The near-tie approval explanation is a deterministic browser fixture; it is not a live plan. |
| 8. Pause | `czar-social-demo-08-paused.png`, `czar-social-demo-08-skipped-paused.png` | The controlled owner paused the representative in the live UI. Replaying a no-supplier event produced exactly one `skipped-paused` run, visible in activity. |

The original live social screens used an ephemeral local `sessions` row. Only the unrelated
`/v1/me` account summary was fulfilled in the browser with the static local network identifier
because controlled fixture users have no vault account. All social API calls went to the live
server. The later actual pairing capture used a new passkey owner and live authentication,
pairing-code, device-pairing, device-list, and social APIs. Its browser changed only the
`vaultCreated` flag in the live `/v1/me` response to render the devices page without local
vault deployment. The virtual authenticator and device token remained in process memory; the
pairing code, session token, and device token were not printed or captured.
The Plan 1.4 approval screens used deterministic route fixtures and did not submit approval.

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
