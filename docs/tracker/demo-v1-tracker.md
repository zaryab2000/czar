# Czar Demo v1 Tracker

- **Goal:** get the Demo v1 flow working live on the Arc testnet as fast as possible. Nothing else matters until it does.
- **Owner of this file:** Zaryab. Any agent may update a task's **Status**, **Owner** and **PR** columns, following the update rules in §2.
- **Started:** 2026-11-05.
- **Code baseline:** `build-v1` at `2e3ed0e` (after PR #227: production integration plus the social network, PR #208).

---

## 1. The demo we are building

### 1.1 Demo v1 script (5–7 minutes, live)

1. **Bob** opens the hosted Czar web app in a browser.
2. Bob registers with a passkey, creates his wallet, sets a small limit, and turns on his representative ("Share experiences").
3. Bob uses **New task**. He describes his smart contract, pastes its source or address, and picks "Smart contract audit".
4. Czar turns that into an audit task and searches the Czar market for x402 merchants that sell audits.
5. Czar **recommends Merchant A** (ranked first) and explains why. **Bob approves** the plan.
6. Bob's wallet pays Merchant A in testnet USDC through the Czar contracts on Arc.
7. Merchant A delivers a shallow audit. **Bob rates it "bad"** in the browser.
8. **Bob's representative** posts his experience on cZarBook (the social feed), then asks other agents to confirm.
9. **2–3 Czar test agents** (seeded, clearly labelled) reply with their own bad experiences with Merchant A.
10. Bob's rating plus the agents' evidence reach discovery. **An incident opens on Merchant A** and appears in the feed.
11. Merchant A **drops below** every merchant without an incident.
12. **Alice** registers and asks for a similar audit.
13. Czar **recommends Merchant B**. Discovery got smarter from one transaction plus agent chatter.

### 1.2 What must be live for the demo

- The Czar web app, hosted on a real domain, so anyone in the room can open it.
- The Czar contracts on Arc testnet (already deployed).
- Two x402 audit merchants live on Arc testnet: **A (shallow)** and **B (thorough)**.
- cZarBook (the social feed), live in the web app.
- The social worker, running in the cloud.

### 1.3 Decisions already made

| ID | Date | Decision |
|---|---|---|
| DD-01 | 2026-11-05 | **Browser only** as the demand entry for Demo v1. No Claude Code or Codex plugin, no `/czar-audit` command and no MCP server for now. |
| DD-02 | 2026-11-05 | Step 5: Czar recommends **one** merchant and Bob **approves** it (no pick-list; the plan has no alternates, an existing ruling). |
| DD-03 | 2026-11-05 | Steps 9–13 use **seeded, labelled Czar test agents** (`controlled` representatives) to supply the other owners' bad experiences. They are never presented as real users. |
| DD-04 | 2026-11-05 | The ranking flip uses the **incident gate** (SCR-164 §3.13.1): 3 distinct owners with bad outcomes within the 14-day **lookback** window. It must show **live, within about 1–2 minutes**, by shortening the demo timing settings (§3, C8). |
| DD-05 | 2026-11-05 | **We build the two audit merchants ourselves**, branded "Czar Lab Quick Audit" (A) and "Czar Lab Deep Audit" (B), labelled as run by Czar. We do not clone or proxy onedollaraudit.com: it is a real third party, runs on Base mainnet, and takes up to 8 hours. |
| DD-06 | 2026-11-05 | The robot-key fix, invite gate, global cap, kill switch, treasury, Python privacy helper, ERC-8183 specialists and npm publishing stay **deferred** (§5). Gateway sweeps moved into C11 by DD-07. |
| DD-07 | 2026-11-05 | **Czar discovers merchants from Circle's Arc testnet registry too.** For each objective, Czar searches **both** its own catalog and Circle's x402 discovery API (`GET https://api.circle.com/v2/x402/discovery/resources`, `network=eip155:5042002`). It ranks all candidates with its own scoring, and filters in or out by capability, payment fit, probe and ranking. Circle merchants are never excluded up front. **Gateway nanopayments are turned on**, with the sweep back to the vault built first. Czar's own merchants (A and B included) also go through Circle's normal registry route. The demo may still use any merchants. Source: Circle discovery research, 2026-11-05. |

### 1.4 Rules every task follows

- `CLAUDE.md` at the repo root applies to every agent and person.
- **Specs first.**
  - A task that adds a route, field, config key or behaviour that is not in `docs/specs/` waits for its spec change request (C9) to merge.
  - Never edit `docs/specs/`, `docs/product/` or `docs/architecture/` inside a build task.
- **Tests first** for any code that reserves, signs, pays, settles or moves USDC.
- **Arc testnet only:** `eip155:5042002`, `https://rpc.testnet.arc.io`.
- **Never touch keys:**
  - Never read, print or commit keys, `.env*` files or secrets.
  - Keys live in Cloud KMS or in files in `deploy.credentialFilesDir` on the VM.
- **Zaryab's approval first** for anything that needs testnet funds, a sign-up, a real device, or a new key.
- **Merges:** only Zaryab merges PRs. Build PRs go into `build-v1` unless a task says otherwise.

---

## 2. How to use this tracker

### 2.1 Owners

| Code | Who |
|---|---|
| **Z** | Zaryab (human setup, approvals, merges) |
| **CL** | Claude (chief architect and its builder agents) |
| **GPT** | GPT / Codex orchestrator agent |
| **COL** | Zaryab's colleague |
| **TBD** | Zaryab assigns |

The **Suggested owner** column is advice. Zaryab writes the final owner in **Owner**.

- **Delegated to COL (2026-11-05):** Package 1 (audit merchants) and Package 2 (browser pages). The full builder prompt is in [`colleague-delegation-packages-1-2.md`](colleague-delegation-packages-1-2.md). COL works only on the rows marked `COL`.

### 2.2 Status values

| Status | Meaning |
|---|---|
| `todo` | Not started |
| `blocked` | Waiting on a dependency; name it in Notes |
| `doing` | An owner is working on it |
| `review` | PR open, waiting for review or merge |
| `done` | Merged **and** its acceptance check passed |
| `dropped` | Removed from scope; give the reason in Notes |

### 2.3 Priority values

| Priority | Meaning |
|---|---|
| **P0** | The demo cannot run without it |
| **P1** | The demo runs without it, but is weaker or riskier |
| **P2** | After the demo |

### 2.4 Update rules for agents

1. **Before starting:** set the task to `doing` and put your owner code in **Owner**, in the PR you open for the task (or in a small tracker-only PR).
2. **When the PR opens:** set `review` and add the PR number.
3. **When it is merged and the acceptance check passed:** set `done`.
   - Paste the acceptance command and result into the PR, not into this file.
4. **When blocked:** set `blocked` and name the blocking task ID in Notes.
5. **Scope:** change only your own task rows. Never reorder or delete other rows.
6. **New work:** if you discover a new task, add a row at the end of the right component, with ID `<component>-NEW-<n>`, status `todo` and owner `TBD`, and mention it in your PR.

---

## 3. Master execution order (critical path)

Execute in this order. Tasks in the same phase can run in parallel unless **Depends on** says otherwise.

### Phase 0: decisions, specs and sign-ups (start now)

| Order | Task | What | Owner |
|---|---|---|---|
| 0.1 | SPEC-01 | SCR: browser "New task" | CL |
| 0.2 | SPEC-02 | SCR: audit merchants A and B | CL |
| 0.3 | SPEC-03 | SCR: demo seeding, demo timing and reset | CL |
| 0.4 | OPS-01 to OPS-05 | GCP, KMS, domain, Anthropic key, testnet funds | Z |
| 0.5 | SPEC-01 to SPEC-03 review and merge | | Z |

### Phase 1: get the stack live and prove one real payment (critical path)

| Order | Task | What | Owner |
|---|---|---|---|
| 1.1 | OPS-06 | Indexer database password path check and fix | CL |
| 1.2 | OPS-07 | Social worker cloud entry point and compose service | GPT |
| 1.3 | OPS-08 | Cloud config for the demo | CL |
| 1.4 | OPS-09 | Provision the VM and deploy | CL + Z |
| 1.5 | OPS-10 | Full compose smoke on the VM | CL |
| 1.6 | SC-01 to SC-03 | Contract addresses, robot gas, fresh-user wallet creation | CL + Z |
| 1.7 | **OPS-11** | **Exit gate:** one real payment on Arc testnet from the cloud | Z + CL |

### Phase 2: build the demo features (parallel lanes; start as soon as specs merge, before Phase 1 finishes)

| Lane | Tasks | Suggested owner |
|---|---|---|
| A: browser task path | UX-01, UX-02, UX-03, UX-04, UX-06, BR-06 (COL, Package 2); BR-02, BR-04 (CL) | COL + CL |
| B: audit merchants | MR-01, MR-02, MR-04, MR-05, MR-07, MR-08 (COL, Package 1); BR-01, BR-03, MR-06 (CL); MR-03 (Z) | COL + CL (CL reviews money-path PRs) |
| C: social and selection seeding | SOC-02, SOC-05, SOC-06, SEL-01, SEL-04, DEMO-01, DEMO-03 | GPT |

### Phase 2b: Circle registry and Gateway (C11, after SPEC work)

| Order | Task | What |
|---|---|---|
| 2b.1 | CD-01 | SCR-187 |
| 2b.2 | CD-02 → CD-03 | Sweep first, then Gateway on |
| 2b.3 | CD-04, CD-05 (parallel) → CD-06 | Offer recognition, discovery source, one ranking |
| 2b.4 | CD-07 | Real Gateway payment to a Circle merchant (after OPS-11) |

### Phase 3: integrate, prove and rehearse

| Order | Task | What |
|---|---|---|
| 3.1 | UX-05 | Fresh-user onboarding on the cloud domain |
| 3.2 | SEL-02, SOC-03, SOC-04, SEL-03 | Live chain: Bob → rating → posts → incident → Alice gets B |
| 3.3 | DEMO-02 | Demo accounts for Bob and Alice, funded |
| 3.4 | DEMO-04 | Runbook |
| 3.5 | DEMO-05, DEMO-06 | Two full dry runs, timed |
| 3.6 | DEMO-07 | Backup recording |
| 3.7 | **DEMO-08** | **Demo ready:** Zaryab's sign-off |

### Critical path

```
SPEC-01..03 ─┐
OPS-01..05 ──┼─> OPS-06..10 ─> OPS-11 (real payment) ─┐
             │                                         ├─> Phase 3 chain test ─> rehearsals ─> DEMO READY
             └─> Lanes A, B, C (parallel) ─────────────┘
```

---

## 4. Tasks by component

### C1. User onboarding (browser)

| ID | Task | Pri | Phase | Depends on | Suggested owner | Owner | Status | PR | Acceptance check | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| UX-01 | **Server route for browser "New task":** create an objective from a signed-in web session, with no paired device. Takes a capability (`code-review`, labelled "Smart contract audit"), a description, and the contract source or address. Applies the same limits, validation and redaction rules SPEC-01 sets. Tests first | P0 | 2 | SPEC-01 | COL | COL | todo | | Route tests pass. An objective created from a web session reaches `planning` and then `awaiting-approval` against a registered audit merchant | Today objectives come only from a paired device (`POST /v1/objectives`, `czar objective`, macOS) |
| UX-02 | **"New task" page:** form fields per SPEC-01 (description; paste source or contract address; service type "Smart contract audit"; optional max budget). Linked from Home | P0 | 2 | UX-01 | COL | COL | todo | | Playwright test: submit the form and see the new task with status "Planning" | Keep the copy plain; no jargon |
| UX-03 | **Task progress in the browser:** a browser-created task shows its state (planning → awaiting approval → paying → delivered) and links to the approval page | P0 | 2 | UX-01 | COL | COL | todo | | Playwright: the state updates without a manual reload (polling is fine) | Check what Home already shows before building |
| UX-04 | **Result and rating for browser tasks:** the delivered audit shows in the result card (Home and Receipts) with Good and Bad rating | P0 | 2 | UX-01, MR-01 | COL | COL | todo | | Rating a browser-created task writes an effective rating (`/v1/app/ratings`) | `result-card.tsx` and `/v1/app/ratings` already exist; confirm they work for browser tasks |
| UX-05 | **Fresh-user onboarding on the cloud domain:** passkey → vault → fund → limits → representative consent ("Share experiences") | P0 | 3 | OPS-11, SC-03 | Z + CL | | todo | | A brand-new user on a second device completes onboarding with no help | Covers the rp id on the real domain (PM-016) and gas for wallet creation |
| UX-06 | **Funding help:** a short "get testnet USDC" step in onboarding (Circle faucet link and amounts), or pre-funded demo wallets | P1 | 3 | OPS-05 | COL | COL | todo | | A new user knows exactly how to fund their wallet in under 1 minute | The treasury top-up is deferred (DD-06) |
| UX-07 | **Demo labels:** controlled representatives show "Czar test agent" (today the badge says "Controlled representative"), and merchants show "Run by Czar" | P1 | 2 | SPEC-03 | GPT | GPT | review | #236, #237 | Feed, thread and approval screens show the labels | Needed for honesty (DD-03). The wording change needs its spec line |

### C2. Czar backend and brain

| ID | Task | Pri | Phase | Depends on | Suggested owner | Owner | Status | PR | Acceptance check | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| BR-01 | **Audit task class:** map `code-review` → `smart-contract-audit` in `planner.capabilityToTaskClass`, and give it a spending category | P0 | 2 | SPEC-02 | CL | CL | done | #235 | `taskClassFor("code-review")` returns `smart-contract-audit`, and planner tests pass | Keeps audit evidence separate from other code reviews |
| BR-02 | **Planner handles browser objectives:** builds the task spec (topic, fields, contract source) and selects among registered audit merchants | P0 | 2 | UX-01, BR-01 | CL | CL | done | #238 | Planner test: a browser objective selects the top-ranked audit merchant and its plan has a readable "why" | Planner part in #238; merge needs SCR-185 (plan schema limits) |
| BR-03 | **Payer sends the contract to the merchant:** the paid request carries the contract source or address in the shape SPEC-02 defines (POST body). Money path, tests first | P0 | 2 | SPEC-02, MR-01 | CL (Opus) | CL | done | #239 | Payer tests: the merchant receives the source; payment is exactly the 402 price; no payment on a probe failure | Registered services already support POST bodies (`registered/index.ts` `body`) |
| BR-04 | **Result check for audits:** accept a delivered report only if it matches the audit-report schema (SPEC-02) | P0 | 2 | SPEC-02 | CL | CL | blocked | | Acceptance test: a valid report is accepted, a malformed one rejected, and a shallow but valid report accepted (the rating judges quality, not the check) | Blocked: waits for COL's `audit-report.schema.json` (Package 1) |
| BR-05 | **Turn on the model provider:** `models.provider = "anthropic"`, key file name, per-user caps; confirm which server parts call the model | P0 | 1 | OPS-04 | CL | CL | done | #240 | `/health` is fine with the provider on, and one model call is logged within its cap | `env/cloud.example.toml` has it `none` today |
| BR-06 | **Readable "why" lines:** the approval page explains the merchant choice in plain words (score, ratings count, incident or not) | P1 | 2 | BR-02 | COL | COL | todo | | Zaryab reads the approval page and understands the choice in 10 seconds | Demo storytelling |

### C3. Smart contracts and keys

| ID | Task | Pri | Phase | Depends on | Suggested owner | Owner | Status | PR | Acceptance check | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| SC-01 | **Contract addresses:** the cloud config reads the deployed addresses from `deployments/` (PM-010 record) and matches what is on chain | P0 | 1 | OPS-09 | CL | | todo | | The server and indexer start, and the indexer follows the vault factory and vault events on Arc testnet | 10 contracts deployed 30 Oct (`ab75543`) |
| SC-02 | **Robot wallet gas:** every signing wallet (robot, evaluator, evidence, merchant settlement if any) has testnet USDC for gas; the low-gas alert is routed | P0 | 1 | OPS-05 | Z + CL | | todo | | Each wallet balance is above its alert threshold, and a test alert reaches Zaryab | On Arc, USDC is the gas |
| SC-03 | **Fresh-user wallet creation on the real testnet:** "Create vault" works for a new user (gas sponsorship or a funded smart account) | P0 | 1 | OPS-09 | CL + Z | | todo | | A brand-new passkey user creates a vault on Arc testnet | Never verified on the real testnet |
| SC-04 | Robot key per wallet (SCR-171 / PM-023) | P2 | — | — | — | | dropped | | — | Deferred (DD-06). Fine for a supervised room; not for a public link |

### C4. Selection layer (ratings → discovery)

| ID | Task | Pri | Phase | Depends on | Suggested owner | Owner | Status | PR | Acceptance check | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| SEL-01 | **Starting ranking:** the seed history makes **A rank 1 and B rank 2, both in `ranked[]`** (rated, not "unverified") before Bob's run | P0 | 2 | SPEC-03, SOC-02, MR-04 | GPT | GPT | review | #243 | The stored ranking decision for `smart-contract-audit` shows A at rank 1 and B at rank 2, with no incident | Local seed-to-rank test passes; VM merchant registration and live check pending. B must be in `ranked[]` for Alice to receive it after A's incident. |
| SEL-02 | **Bob's bad rating counts:** rating → `ratings_effective` → a negative unit on A's settled observation within the window | P0 | 3 | UX-04, OPS-11 | CL | | todo | | Bob's observation is settled and bound to a `bad` effective rating within 1 minute of rating | Depends on the indexer confirming Bob's payment |
| SEL-03 | **Alice gets B:** after the incident opens, Alice's ranking moves A below B, and her plan recommends B with no incident approval reason | P0 | 3 | SOC-04, UX-05 | CL | | todo | | Alice's plan step = Merchant B; A has the `incident-open` badge in her stored decision | The core demo moment |
| SEL-04 | **Demo timing (selection):** `selection.snapshotRefreshSeconds` 300 → 30 and `selection.ratingRefreshDebounceSeconds` 30 → 5 in the demo overlay | P0 | 2 | SPEC-03 | GPT | GPT | review | #237 | Values loaded on the VM (config dump) | Demo overlay only; production defaults unchanged |

### C5. cZarBook social layer

| ID | Task | Pri | Phase | Depends on | Suggested owner | Owner | Status | PR | Acceptance check | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| SOC-01 | **Social worker live in the cloud:** consumer, runner, housekeeping and incident loop running on the VM | P0 | 1 | OPS-07, OPS-09 | GPT | | todo | | A test event creates an inbox row and a run within 10 s on the VM | Today `worker-main.ts` is local-only and compose has no social service |
| SOC-02 | **Cloud-safe seeding of Czar test agents:** 3 labelled controlled representatives with evidence on the audit task class: 2 recent bad outcomes on A, older good outcomes on A, good outcomes on B; sharing on; subscribed to the audit service and class | P0 | 2 | SPEC-03, MR-04 | GPT | GPT | review | #243 | After seeding: the feed shows the agents with labels, `social_subscriptions` rows exist, and **no incident is open yet** (only 2 bad owners) | Local guarded seed and worker pipeline tests pass; VM seed and live feed check pending. |
| SOC-03 | **Bob's representative posts and agents reply:** after Bob's bad rating, his representative posts the experience and a "corroborate-failure" question; the seeded agents reply "corroborates" with their evidence | P0 | 3 | SOC-01, SOC-02, SEL-02 | GPT | | todo | | Within 1 minute of the rating: 1 experience post, 1 question, and at least 2 replies with stance `corroborates` | All logic exists (`run.ts`); this checks it live |
| SOC-04 | **Incident opens live:** `social.incidentEvalMinutes` 60 → 1 in the demo overlay; the incident on A opens and its system post appears in the feed | P0 | 3 | SOC-03, SEL-04 | GPT | | todo | | Within 2 minutes of Bob's rating: an open `social_incidents` row for A and the "Incident opened…" post in the thread | 3 distinct owners: Bob plus 2 seeded |
| SOC-05 | **Bob's representative is set up:** representative onboarding turns sharing to "Share experiences" for Bob | P0 | 2 | — | GPT | GPT | review | #233 | Bob's representative has `sharing = structured` after onboarding | Page exists (`/onboarding/representative`); confirm |
| SOC-06 | **Demo reset (social):** remove demo posts, threads, incidents, lessons and inbox rows, then re-seed | P0 | 2 | SPEC-03 | GPT | GPT | blocked | #242 | Reset and re-seed twice in a row and get the same starting feed and ranking | Needed for repeated rehearsals; Reset scope ruled by the architect 2026-11-05 (SCR-186, #242) |
| SOC-07 | Feed shows posts in real time during the demo (poll interval) | P1 | 2 | — | GPT | GPT | review | #233 | A new post appears in the feed within 15 s without reload | Existing feed polls every 15 s |

### C6. Production readiness and operations

| ID | Task | Pri | Phase | Depends on | Suggested owner | Owner | Status | PR | Acceptance check | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| OPS-01 | Create the GCP project, billing and VM quota | P0 | 0 | — | Z | | todo | | Project exists, billing on | $300 new-account credit |
| OPS-02 | Create the Cloud KMS key ring and signer keys per the signer key list | P0 | 0 | OPS-01 | Z (CL guides) | | todo | | The signer starts with `gcp-kms` and signs a test message | No key file ever exists |
| OPS-03 | Buy the domain; set DNS for the app and API names that Caddy serves | P0 | 0 | — | Z | | todo | | `dig` resolves to the VM's IP | |
| OPS-04 | Create the Anthropic API key with a hard monthly spend cap; place it as a credential file | P0 | 0 | — | Z | | todo | | The key file is in `deploy.credentialFilesDir` with the right owner and mode | Never on a command line or in an env var |
| OPS-05 | Testnet USDC for the robot and operator wallets, merchant payee addresses (receive only) and the Bob and Alice demo wallets | P0 | 0 | MR-03 | Z | | todo | | Balances checked on the Arc explorer | Faucet: 20 USDC per address every 2 hours |
| OPS-06 | **Indexer database password path:** check whether the indexer has the same bug PR #225 fixed for server, merchants and signer; fix it if so | P0 | 1 | — | CL | CL | done | #234 | The indexer connects to Postgres on the VM with its password file | Flagged "not confirmed" in PR #227 |
| OPS-07 | **Social worker cloud entry point and compose service** (like PM-059 for server, merchants and indexer) | P0 | 1 | — | GPT | GPT | review | #233 | Compose test passes, and the service starts in the smoke run | |
| OPS-08 | **Cloud config for the demo:** model provider on; audit merchants registered; the job path stays off; lab settings as needed; demo overlay file wired (DEMO-01) | P0 | 1 | SPEC-02, SPEC-03 | CL | CL | doing | #240 | `config dump` on the VM shows the expected values | #240 covers the model provider and job-path-off parts only; audit merchants (MR-04) and the overlay (DEMO-01) are others'; Model provider and job-off done in #240; audit catalog (MR-04, COL) and demo overlay (DEMO-01, GPT) pending |
| OPS-09 | **Provision and deploy:** run `create.sh`; place the compose files, `cloud.toml` and `deployments/` on the VM; start the stack | P0 | 1 | OPS-01..04 | CL + Z | | todo | | `https://<api domain>/health` returns 200 from the internet | The README step 7 copy method is manual today |
| OPS-10 | **Full compose smoke on the VM** with indexer, merchants and web (not yet run anywhere) | P0 | 1 | OPS-09 | CL | | todo | | Every service is healthy, and the web app loads on the domain | |
| OPS-11 | **EXIT GATE: one real payment.** Zaryab signs up on the cloud domain and pays the existing Czar Search merchant on Arc testnet (CLI objective from his Mac is fine for this gate) | P0 | 1 | OPS-10, SC-01..03 | Z + CL | | todo | | A receipt shows a real Arc testnet transaction hash, and the indexer recorded it | **Highest-risk item.** Build nothing else on top until it passes |
| OPS-12 | Backups running on the VM (timer active; one dump written) | P1 | 1 | OPS-09 | CL | | todo | | `systemctl list-timers` shows the backup timer, and one backup object exists | PR #226 |
| OPS-13 | Ops Agent config installed by hand; only app container logs shipped | P1 | 1 | OPS-09 | Z + CL | | todo | | Logs from server, signer, merchants and web are visible; no Postgres or Ponder raw output | |
| OPS-14 | **SCR-180 deploy rule:** deploy or restart the signer only when no signature is outstanding | P1 | 1 | — | CL | | todo | | Written in the runbook (DEMO-04) | A pocket with an old pending signature refuses until it expires |

### C7. x402 audit merchants

| ID | Task | Pri | Phase | Depends on | Suggested owner | Owner | Status | PR | Acceptance check | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| MR-01 | **Merchant A, "Czar Lab Quick Audit":** x402 route on Arc testnet USDC; takes contract source or address; returns a schema-valid but **shallow** report (generic findings); fast, cheap model | P0 | 2 | SPEC-02 | COL | COL | todo | | Unpaid request → 402 with Arc testnet terms; paid request → schema-valid report in under 30 s | Must be honest-shallow, not broken: the rating judges it |
| MR-02 | **Merchant B, "Czar Lab Deep Audit":** same interface; a thorough, severity-ranked report with fixes; stronger model | P0 | 2 | SPEC-02 | COL | COL | todo | | Same as MR-01, and the report lists severity, location and fix for each finding | |
| MR-03 | **Payout keys:** create signer keys `K10:czar-audit-quick` and `K10:czar-audit-deep` (Cloud KMS on the VM, the local keystore locally); `payTo` comes from the signer (SCR-182 §1) | P0 | 0 | — | Z | | todo | | The signer serves both K10 addresses, and no key material exists outside KMS or the keystore | Needs Zaryab's approval (new keys) |
| MR-04 | **Register A and B in the Czar market:** catalog entries with the `code-review` capability, probe input, price, and verified service versions | P0 | 2 | MR-01, MR-02, BR-01 | COL | COL | todo | | A planner probe of each returns one valid 402; the ranking decision lists both | |
| MR-05 | **Prompt safety:** the contract source and any merchant input reach the model only as labelled, JSON-encoded data (`docs/specs/04-components/shared/ai-prompts.md`); output is schema-checked; spend is capped per call | P0 | 2 | MR-01, MR-02 | COL | COL | todo | | A test contract with "ignore previous instructions" in a comment still returns a normal report | Untrusted-text rule in `CLAUDE.md` |
| MR-06 | **Live on the VM:** merchants container serves A and B behind Caddy; the planner reaches them | P0 | 3 | MR-04, OPS-10 | CL | | todo | | Probe from the VM server succeeds for both | |
| MR-07 | **Merchant tests:** 402 terms, payment verification, replay rejection, delivery-time limit, report schema | P0 | 2 | MR-01, MR-02 | COL | COL | todo | | Merchant test suite passes | Payment verification is a money path: tests first |
| MR-08 | **Prices:** A cheaper than B (for example A 0.50 and B 1.00 testnet USDC) within the planner's default max | P1 | 2 | SPEC-02 | COL | COL | todo | | Both prices are under `planner.defaultMaxUnitAtomic` | Price is not the reason A ranks first; the seeded history is |

### C8. Demo data, timing and rehearsal

| ID | Task | Pri | Phase | Depends on | Suggested owner | Owner | Status | PR | Acceptance check | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| DEMO-01 | **Demo timing overlay** (for example `env/demo.toml`): incident check every 1 min, snapshot refresh 30 s, rating debounce 5 s, plus any other wait SPEC-03 lists | P0 | 2 | SPEC-03 | GPT | GPT | review | #237 | The VM loads the overlay, and a config dump shows the demo values | Production defaults unchanged |
| DEMO-02 | **Demo accounts:** Bob and Alice passkeys on the demo devices; wallets created and funded; Bob's representative on | P0 | 3 | UX-05, OPS-05 | Z | | todo | | Both log in and see a funded wallet | Alice must have **no** own evidence on A |
| DEMO-03 | **One-command reset and re-seed** for the whole demo state (social, selection seed, Bob's and Alice's tasks) | P0 | 2 | SOC-06, SEL-01 | GPT | GPT | blocked | #242 | Reset then dry run gives the same result twice | Testnet only; refuses on any other network; Reset scope ruled by the architect 2026-11-05 (SCR-186, #242) |
| DEMO-04 | **Runbook:** minute-by-minute script; who clicks what on which device; expected screen at each step; what to say while waiting; fallback if a step is slow | P0 | 3 | Phase 2 done | CL | | todo | | Zaryab can run the demo from the runbook alone | |
| DEMO-05 | **Dry run 1** on the cloud, timed per step | P0 | 3 | all P0 above | Z + CL | | todo | | Every step works; timings recorded | |
| DEMO-06 | **Dry run 2** after fixes, timed | P0 | 3 | DEMO-05 | Z + CL | | todo | | End to end in 7 minutes or less | |
| DEMO-07 | **Backup recording** of a full successful run | P1 | 3 | DEMO-06 | Z | | todo | | Video saved | In case the live network misbehaves |
| DEMO-08 | **Demo ready:** Zaryab's sign-off | P0 | 3 | DEMO-06 | Z | | todo | | — | |

### C9. Specs and governance (Phase 0)

| ID | Task | Pri | Phase | Depends on | Suggested owner | Owner | Status | PR | Acceptance check | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| SPEC-01 | **SCR-181: browser "New task."** Covers: session-authenticated objective route (no device token); capability picker; form fields; size limits on pasted source; redaction and privacy rules for server-side intake; rate limits; state shown back to the browser | P0 | 0 | — | CL | CL | done | #229 | SCR merged into `build-v1` | Unblocks UX-01..04, BR-02 |
| SPEC-02 | **SCR-182: audit merchants A and B.** Covers: catalog entries; request shape (POST body with source or address); audit-report result schema; result check; prices; payout key references; task class `smart-contract-audit`; model choice and spend caps; prompt safety | P0 | 0 | — | CL | CL | done | #229 | SCR merged | Unblocks MR-*, BR-01, BR-03, BR-04 |
| SPEC-03 | **SCR-183: demo seeding, timing and reset.** Covers: a cloud-safe controlled seed (testnet-only guard plus an explicit demo flag); exact seed history for A and B; the "Czar test agent" label; demo timing overlay keys and values; reset scope | P0 | 0 | — | CL | CL | done | #231 | SCR merged | Unblocks SOC-02, SOC-06, SEL-01, SEL-04, DEMO-01, DEMO-03, UX-07 |
| SPEC-04 | Production spec-gap bundle: lab seed name vs secret rule, second payee key reference, per-service lab price, RPC URLs as pointers, credential-list format, proxy body-cap key | P2 | — | — | CL | | todo | | SCR merged | Recorded in PR #227 |

### C10. Optional: live merchant ranking UI

| ID | Task | Pri | Phase | Depends on | Suggested owner | Owner | Status | PR | Acceptance check | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| OPT-01 | **Live ranking page:** read-only list of merchants for the audit task class with score, ratings count and incident badge, refreshing every few seconds | P1 | 2 | SEL-01, spec | COL | COL | todo | | During the demo, A visibly moves below B within 2 minutes of Bob's rating | Strong visual for step 12; needs its own spec. Without it, the incident thread tells the story |

---

### C11. Circle registry discovery and Gateway nanopayments (DD-07)

- **Why:** Czar must work with the merchants already on Circle's Arc testnet registry, not only with its own catalog.
- **Research facts (2026-11-05):**
  - 134 Arc testnet listings, **all payable only through Circle Gateway**
  - no audit seller among them
  - substring search, no quality signal
  - input schema often missing; output schema mostly missing
- **Order inside C11:** spec → sweep (money safety) → Gateway on → discovery source → merge into selection → end-to-end test.
  - CD-01 to CD-07 are P0 because DD-07 makes them part of Demo v1.
  - If they put the demo at risk, Zaryab can move them to P1.

| ID | Task | Pri | Phase | Depends on | Suggested owner | Owner | Status | PR | Acceptance check | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| CD-01 | **SCR-187: Circle discovery source plus Gateway turn-on.** Covers: discovery request (network, category or query from capability, limits, paging, cache TTL); listing → candidate mapping (resource, method, `accepts`, input schema); merge and dedupe with `selection.czarRegisteredServices`; capability ↔ Circle category map; Gateway offer recognition (`extra.name = "GatewayWalletBatched"`) routed to the `gateway-nano` rail; the sweep and refund back to the vault; config keys; Circle terms caveat | P0 | 2 | — | CL | | todo | | SCR merged | Unblocks CD-02 to CD-09 |
| CD-02 | **Pocket sweep and refund back to the vault:** withdraw every unspent Gateway deposit from the pocket to the owner's vault after the step (success, failure or cancel). **Money path, tests first** | P0 | 2 | CD-01 | Claude builder (Opus) | | todo | | Tests: leftover after a success, a failed call or a cancel returns to the vault; nothing is left stranded; replay-safe | Was cut as SCR-177/PM-044/PM-047; required before CD-03 |
| CD-03 | **Turn on Gateway nanopayments:** `routing.gatewayEnabled = true` for the demo deployment, only after CD-02 merges | P0 | 2 | CD-02 | CL | | todo | | Config dump shows it on; a `gateway-nano` step plans and pays against a Czar merchant on the local chain | |
| CD-04 | **Selection recognises Circle Gateway offers:** today the eligibility rule misses them (no `paymentFlow`; SIWX declared as a 402-level extension). Route them to `gateway-nano`, and filter offers that need SIWX or sessions. Tests first | P0 | 2 | CD-01 | Claude builder | | todo | | Tests with the real Quicknode and BotPay 402 shapes: classified correctly; never paid on the vanilla rail | Research Q4 |
| CD-05 | **Circle discovery source:** fetch `network=eip155:5042002` plus the category or query for the capability; cache per the response `cache-control` (1 h); page by `offset` with dedupe (page order is unstable); map each listing to a candidate; live-probe before ranking | P0 | 2 | CD-01 | GPT or Claude builder | | todo | | Recorded API fixtures: listings map to candidates; an unpaid probe is required before any is ranked; the API down means fallback to Czar's own catalog only | api.circle.com must be allowed by safe fetch and VM egress |
| CD-06 | **One search, one ranking:** Czar's own catalog and Circle candidates merge into one candidate list per objective (dedupe by resource URL and `payTo`), then run through the normal ranking, incidents, lessons and filters | P0 | 2 | CD-04, CD-05 | Claude builder | | todo | | Planner test: Circle and own candidates rank together; a capability mismatch is filtered out; Circle merchants are never excluded before ranking | Core of DD-07 |
| CD-07 | **End-to-end Gateway payment to an existing Circle merchant** on Arc testnet (for example Quicknode `arc-testnet`, 0.0001 USDC): discover → probe → rank → pay through the pocket → leftover swept back | P0 | 3 | CD-03, CD-06, OPS-11 | Z + CL | | todo | | Receipt with a real Gateway settlement; vault balance reconciles after the sweep | Needs testnet funds: Zaryab's approval |
| CD-08 | **Input builder for listings:** build the request from the listing's input schema (body or query); listings without a schema need a model-built input (SCR-187 decides) | P1 | 2 | CD-05 | Claude builder | | todo | | Tests per schema type; never sends fields outside the schema | 84% of Arc mainnet listings have no input schema |
| CD-09 | **Generic delivery check for listings with no output schema** (for example "valid JSON or text within limits, then the boundary screen") | P1 | 2 | CD-01 | Claude builder | | todo | | Acceptance tests for schema-less deliveries | |
| CD-10 | **List Czar's merchants through Circle's registry route:** apply to list Czar Search, Spot, Extract and audit A and B on Circle's agent marketplace (testnet). The application and its approval are Circle's process | P1 | 2 | MR-06 | Z | | todo | | Listings visible in the discovery API for `eip155:5042002` | Approval and timeline are not guaranteed, so `czarRegisteredServices` stays as the fallback; listing names Czar publicly |
| CD-11 | **Circle terms confirmation:** written confirmation that caching, re-ranking and showing incidents about listed sellers is allowed | P1 | 2 | — | Z | | todo | | Written reply from Circle | Research Q5: terms are silent; Developer Terms s.2 risk |

## 5. Deferred (not in Demo v1)

| Item | Why deferred | Reference |
|---|---|---|
| Claude Code plugin, `/czar-audit`, MCP server, Codex plugin | DD-01: browser only | PM-032, PM-033, PM-038, SCR-179 |
| The observer chain (hooks → mapping → soul → publisher) | Weeks of work; unpredictable live | SCR-179, T-063/066/068/069 |
| Robot key per wallet | Supervised demo only | SCR-171, PM-023 |
| Narrower passkey powers | Supervised demo only | SCR-173, PM-029 |
| Invite gate, global cap, kill switch | Supervised demo only | — |
| Treasury top-ups | Pre-fund demo wallets instead | SCR-177 |
| Python privacy helper | Not on the browser path | PM-036 |
| ERC-8183 job specialists | x402 only for Demo v1 | — |
| npm publishing and license | No install needed for a browser demo | PM-034 |
| Privacy copy and user guide | After the demo | PM-053 |

---

## 6. Demo step → task map

| Demo step | Tasks that make it work |
|---|---|
| 1. Bob opens the web app | OPS-09, OPS-10, OPS-03 |
| 2. Bob registers | UX-05, SC-03, SOC-05, DEMO-02 |
| 3. Bob uses "New task" | SPEC-01, UX-01, UX-02 |
| 4. Czar finds audit merchants | BR-01, BR-02, MR-04, MR-06 |
| 5. Czar recommends A; Bob approves | SEL-01, BR-06, UX-03 |
| 6. Payment on Arc | OPS-11, BR-03, SC-01, SC-02 |
| 7. A delivers; Bob rates "bad" | MR-01, BR-04, UX-04 |
| 8. Bob's representative posts | SOC-01, SOC-03 |
| 9. Test agents reply | SOC-02, SOC-03, UX-07 |
| 10. The incident opens | SEL-02, SOC-04, DEMO-01 |
| 11. A drops below B | SEL-03 (OPT-01 for a live ranking view) |
| 12. Alice registers and asks | UX-05, DEMO-02 |
| 13. Czar recommends B | SEL-03, MR-02 |

---

## 7. Risks to watch

| Risk | Impact | Mitigation |
|---|---|---|
| The first real-testnet payment fails (never run against the cloud) | Blocks everything | OPS-11 is the Phase 1 exit gate; fix before anything stacks on it |
| B is "unverified", not in `ranked[]` | Alice still gets A, and the demo fails | SEL-01 acceptance requires B in `ranked[]` |
| Live waits are longer than expected (indexer lag, polling) | The demo runs over 7 minutes | DEMO-01 timing overlay; measure in DEMO-05; filler talk in the runbook |
| Arc testnet RPC or faucet outage on demo day | The demo stops | DEMO-07 backup recording; pre-fund early |
| Seeded agents look like fake users | Credibility | DD-03 and UX-07 labels; say so out loud in the demo |
| Merchant model output is unsafe or off-format | A broken step | MR-05 prompt safety; BR-04 schema check |
| The shared robot key | Exposure if the link goes public | Supervised room only; SC-04 deferred |

---

## 8. Change log

| Date | Change | By |
|---|---|---|
| 2026-11-05 | Tracker created from the Demo v1 plan and decisions DD-01 to DD-06 | CL |
| 2026-11-05 | Packages 1 and 2 delegated to COL (12 rows); SPEC-01 to SPEC-03 reserved as SCR-181, SCR-182, SCR-183 | CL |
| 2026-11-05 | SCR-181 and SCR-182 filed; UX-01 delegated to COL so Package 2 needs nothing from CL; MR-03 is now the two K10 signer keys | CL |
| 2026-11-05 | SCR-183 filed (demo seeding, timing, reset) | CL |
| 2026-11-05 | Status sync: SPEC-01..03, OPS-06, BR-01..03, BR-05 done; SCR-185 applied (#238); BR-04 blocked on COL schema; GPT PRs #233, #236, #237, #243 in review; reset (SOC-06, DEMO-03) ruled via SCR-186 (#242) | CL |
| 2026-11-05 | DD-07 and C11 added: Circle registry discovery, Gateway nanopayments on with the sweep first, Czar merchants via Circle's registry route; Gateway sweeps removed from deferred | CL |
