# SCR-183: Demo seeding, demo timing and demo reset (Demo v1)

| Field | Value |
|---|---|
| ID | SCR-183 |
| Filed by | Claude (chief architect), 2026-11-05 |
| Spec and section | SCR-164 §3.13 (incidents, lessons) and its controlled-fixture rules; `apps/server/src/social/controlled-fixtures.ts` and `controlled-local.ts` behaviour; SCR-164 UI wording for controlled representatives; `packages/config` registry; `ops/cloud/` config |
| Status | Open |
| Tracker | SPEC-03. Unblocks SOC-02, SEL-01, SEL-04, DEMO-01, SOC-06, DEMO-03, UX-07 (`docs/tracker/demo-v1-tracker.md`) |

## Problem
- **The demo has to show, live and within about 2 minutes, that one bad audit plus other agents' evidence moves discovery from Merchant A to Merchant B (DD-03, DD-04).** For that, three things are needed:
  - **a starting market** where A ranks first and B second, both rated
  - **2 other owners with recent bad outcomes on A**, so Bob's rating is the third distinct owner, which opens the incident (`social.incidentMinOwners` = 3)
  - **loops fast enough** to show it live
- **Today:**
  - controlled seeding refuses to run outside the local stack (`controlled-local.ts`: loopback database plus `validateLocalOnlyConfig`)
  - the fixture's history is fixed to the local search suppliers
  - the incident check runs every 60 minutes
  - there is no reset

## Evidence
- `apps/server/src/social/controlled-local.ts:18`: fixtures refuse anything except the explicit local configuration.
- `apps/server/src/social/controlled-fixtures.ts:330`: exactly three owners, on the fixture's declared network.
- `apps/server/src/selection/ranking/order.ts`: any candidate with at least one rating is `ranked[]`; with none it is `unverified[]`.
  - The score is the Wilson lower bound with `selection.confidenceZ` = 1.959964.
- `apps/server/src/social/incidents.ts` `evaluateIncidents`: an incident opens at 3 distinct owners with negative units in the last `social.incidentWindowDays` (14).
  - Controlled owners count when `social.incidentsCountControlled` is `true` (the testnet default).
- **Defaults today:**
  - `social.incidentEvalMinutes` 60
  - `selection.snapshotRefreshSeconds` 300
  - `selection.ratingRefreshDebounceSeconds` 30
  - `social.housekeepingMinutes` 15
  - `social.routingCooldownMinutes` 60

## Proposed change

This SCR is the normative spec for the tasks above until its content is folded into the component specs.

### 1. The demo switch and guard
- **New key `demo.enabled`** (boolean, default `false`; reason: "Demo v1 seeding and reset; never on outside the testnet demo deployment").
- **Every demo command refuses to run unless all of these hold:**
  - `demo.enabled` is `true`
  - `selection.paymentNetwork` is `eip155:5042002`
  - the command carries `--confirm <environment>`, matching `deploy.environment`
- **The local-only guard stays for the existing local fixture command.** The demo commands are new entry points, with this guard in its place. They run with the deployment's own config and database URL (on the VM: the cloud config, the credential files, and the loopback database).
- **Commands** (server scripts, run on the VM by the operator):
  - `social:demo-seed --confirm <environment>`
  - `social:demo-reset --confirm <environment>`
  - `social:demo-check --confirm <environment>`, read-only, prints the §4 checks

### 2. Who is seeded (honest labelling)
- **Three controlled owners, each with a controlled representative,** `sharing = structured`, not paused, consent recorded at the current `social.consentTextVersion`.
- **Display label:** the badge text for `controlled` representatives changes from "Controlled representative" to **"Czar test agent"** everywhere it shows:
  - feed and thread posts
  - `/social/me`
  - the author line on approval-screen lessons
- **Handles:**
  - `Czar-Test-1`, `Czar-Test-2`, `Czar-Test-3`
  - Stored as the handle. Must pass the existing handle rules; if they don't, use the closest valid form and keep the "Czar test agent" badge.
- **These owners never hold funds.** They pay no merchant on chain. Their history is fixture evidence, marked as controlled through the existing `users.controlled` and `observations` path.

### 3. The seeded history (task class `smart-contract-audit`, network `eip155:5042002`)
- **Services:** A = `czar-audit-quick`, B = `czar-audit-deep` (SCR-182). Both must have a verified service version from a bare 402 probe before seeding (the existing `versionFor` rule).

| Owner | On A (`czar-audit-quick`) | On B (`czar-audit-deep`) |
|---|---|---|
| Czar-Test-1 | 6 good, settled 20–40 days before seeding | 2 good, settled 20–40 days before |
| Czar-Test-2 | 6 good, settled 20–40 days before; **1 bad, settled 2 days before** | 2 good, settled 20–40 days before |
| Czar-Test-3 | 6 good, settled 20–40 days before; **1 bad, settled 1 day before** | 1 good and 1 bad, settled 20–40 days before |

- **Totals:**
  - **A:** 18 good, 2 bad → Wilson lower bound ≈ 0.699
  - **B:** 5 good, 1 bad → Wilson lower bound ≈ 0.436
  - So **A ranks 1 and B ranks 2, both in `ranked[]`.**
- **After Bob's bad rating:**
  - A becomes 18 good, 3 bad → about 0.654. **A still outscores B on rating alone.**
  - That is intended: the **incident** is what moves A down (3 distinct owners with recent negatives: Czar-Test-2, Czar-Test-3 and Bob).
- **No incident at seed time:** only 2 owners have negatives on A inside the 14-day window, and B's only bad outcome is outside it.
- **Every seeded observation:**
  - is `delivered = 1` for good outcomes, and bound through `rating_receipts` to an effective rating (`ratings_effective`) of `good`
  - for bad outcomes: `delivered = 1`, bound to an effective `bad` rating
  - has one owner objective per observation, with capability `code-review`, so each test agent gets `class:eip155:5042002:smart-contract-audit` and `service:` subscriptions through the normal housekeeping pass
- **Posts come from the normal pipeline.** The seed writes the same outbox events (`objective.delivered`, `rating.recorded`) the existing fixture writes. The social worker then publishes the test agents' experiences through the representatives' normal code-only runs. No post is written directly.
- **After seeding,** the command triggers one counts and ranking-snapshot refresh, so the starting ranking is visible at once.

### 4. Seed checks (`social:demo-check`)
1. Three controlled representatives exist, `sharing = structured`, each with "Czar test agent" display.
2. The latest ranking decision for `smart-contract-audit`: A `rank 1`, B `rank 2`, both in `ranked[]`, no `incident-open` badge.
3. No `social_incidents` row is open for A or B.
4. Each test agent has an active `class:eip155:5042002:smart-contract-audit` subscription.
5. The test agents' experience posts exist in the feed (eventually; the check reports their count).

### 5. Demo timing
- **Demo values go in a new example overlay, `env/cloud-demo.example.toml`.** The operator appends it to the VM's `cloud.toml` for the demo deployment only. Production defaults are unchanged.

| Key | Default | Demo value | Why |
|---|---|---|---|
| `social.incidentEvalMinutes` | 60 | 1 | Incident opens within about a minute of Bob's rating |
| `selection.snapshotRefreshSeconds` | 300 | 30 | Fresh counts in rankings |
| `selection.ratingRefreshDebounceSeconds` | 30 | 5 | Bob's rating reaches counts quickly |
| `social.housekeepingMinutes` | 15 | 1 | Subscriptions refresh quickly after seeding |
| `social.routingCooldownMinutes` | 60 | 1 | Repeated rehearsals still route to the test agents first |
| `demo.enabled` | false | true | Allows the demo commands |

- **Keep at defaults:**
  - `social.consumerPollMs` (2000) and `social.runnerPollMs` (1000)
  - `social.incidentsCountControlled` (`true` on testnet)
  - `social.incidentMinOwners` (3)
  - `social.incidentWindowDays` (14)
- **Target:**
  - from Bob's rating to an open incident: **≤ 2 minutes**
  - Alice's plan recommending B: as soon as the incident is open, because ranking reads open incidents when it builds each decision

### 6. Reset (`social:demo-reset`)
- **Deletes, inside one transaction:**
  - **every social row:** posts, threads, evidence links, inbox, runs, incidents, lessons, leads, subscriptions, consumer cursor rows written since seeding
  - **the evidence for the two audit services only:**
    - observations, ratings, rating receipts, effective ratings and supplier counts for `czar-audit-quick` and `czar-audit-deep`
    - ranking decisions and health facts for task class `smart-contract-audit`
  - **the controlled owners** and their objectives, devices and representatives
- **Keeps:**
  - Bob's and Alice's accounts, wallets, devices and representatives
  - all receipts, envelopes and chain-derived payment records
  - everything for other services
- **Bob's and Alice's own representatives** are kept with their sharing setting. Their inbox and runs go with the social rows.
- **Afterwards,** run `social:demo-seed` to get the starting state back. A reset followed by a seed twice in a row must give the same `demo-check` result.

### 7. Not changed
- The incident, lesson and routing logic (SCR-164, SCR-165), the scores, and the ranking order.
- No new route, field or table. `demo.enabled` and the label wording are the only additions besides the commands.

## Tests (acceptance)
1. **Guard:** each demo command refuses when:
   - `demo.enabled` is `false`
   - the network is not `eip155:5042002`
   - `--confirm` does not match `deploy.environment`
2. **Seed:** after `social:demo-seed`, all five §4 checks pass.
3. **Incident trigger:** one more owner's settled observation on A bound to a `bad` rating, then `evaluateIncidents` opens exactly one incident on A. B is unaffected.
4. **Planner:** with that incident open, a new user's `code-review` plan chooses B, and the stored decision shows A with `incident-open`, below B.
5. **Reset:**
   - `reset → seed → check` twice gives identical results
   - receipts and other services' rows are untouched
   - the reset refuses without the guard
6. **Label:** feed, thread, `/social/me` and approval-lesson author lines show "Czar test agent" for controlled representatives.
7. **Timing overlay:** loading `env/cloud-demo.example.toml` yields exactly the §5 demo values, and production defaults are unchanged without it.

## Affected tasks
- **GPT:** SOC-02, SEL-01, SEL-04, DEMO-01, SOC-06, DEMO-03, UX-07
- **CL:** OPS-08 (append the overlay on the VM), DEMO-04 (runbook)

## Decision
- <filled in by Zaryab>
