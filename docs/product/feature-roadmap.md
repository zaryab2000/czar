# Czar feature roadmap: the work soul and the growth engine

- **Date:** 2026-10-18
- **Author:** Claude, as research lead
- **Status:** adopted by Zaryab on 2026-10-18, in this exact order and priority
- **Inputs:** `docs/product/czar-product.md`, `docs/product/decisions-log.md`, `docs/architecture/selection-layer-architecture.md`, and Cuy Sheffield's "The Soul of Agentic Commerce" (`docs/research/references/`)

---

## 0. The upgrade in one sentence

- **Czar builds a "work soul" for each person from what they actually do, turns that soul's unfinished business into funded objectives, and proves on-chain that every purchase came from a real person's need.**

---

## 1. Summary

| # | Idea | Part | Main gain | Phase 1? |
|---|---|---|---|---|
| 1.1 | Work Soul file with receipts | Soul | Turns memory into wants | Yes (v0) |
| 1.2 | Drives engine: open loops → objectives | Soul | Demand without human ideas | Yes (3 detectors) |
| 1.3 | Soul injection into every agent the user runs | Soul | Many more buyers per user | Lite (MCP server) |
| 1.4 | Earned autonomy: limits that grow on-chain | Soul + contracts | Users delegate more over time | Yes |
| 1.5 | Shadow mode: "what you missed" report | Soul | Proof of value before spending | Yes |
| 1.6 | Team soul and team vault | Soul | Companies pay; bigger budgets | Later |
| 2.1 | Objective envelopes: one approval per objective | Users | Less friction per purchase | Yes |
| 2.2 | Pay on acceptance | Users | Less risk → more delegation | Partial |
| 2.3 | Deliver results into the workflow | Users | Value lands → repeat buying | Yes (one surface) |
| 2.4 | Standing objectives | Users + merchants | One-off → recurring revenue | Later |
| 2.5 | Recipes with on-chain revenue splits | Users + builders | How skill makers get paid | Yes (one recipe) |
| 2.6 | ROI ledger | Users | Justifies bigger budgets | Yes (simple) |
| 2.7 | Context minimization | Users | White-collar adoption | Partial |
| 2.8 | Demand radar for merchants | Merchants | Supply follows real demand | Later |
| 2.9 | Unmet-demand ERC-8183 jobs | Specialist agents | New jobs from latent demand | Later |
| 2.10 | Exploration budget for new merchants | Merchants | First revenue for newcomers | Later |
| 2.11 | Merchant fix-it feedback | Merchants | Merchants improve → earn more | Later |
| 2.12 | Signed quotes and `upto` pricing | Merchants | Bigger, variable-cost jobs | Later |
| 2.13 | Proof of real demand | Protocol | The piece no one else has | Yes (headline) |

---

## Part 1 — The work soul

### 1.1 The Work Soul file (structured, versioned, with receipts)

- **What it is:** the shared memory compiled into one living document per person, `SOUL.md` plus a machine-readable `soul.json`. The person never has to write it; Czar does. On day one the person may add to it (D90): an optional five-minute interview, or suggested lines from files, pastes or an agent summary they choose, each accepted line by line and labelled with its source.
- **Sections, mapped from Cuy's soul elements to work:**
  - **Place** → locale, language, time zone, currency, and the rules that apply where they work
  - **Mission** → active projects, each with its goal and deadline
  - **Rituals** → recurring tasks and how often they happen (weekly report, Monday pipeline review)
  - **Friction** → where time leaks: repeated manual steps, failed agent attempts, constant context switches
  - **Drives** → open loops and unfinished business (see 1.2)
  - **Taste** → quality bar, trusted sources, preferred formats and tone
  - **Constraints** → budget, tools they can't use, privacy limits
  - **Spending posture** → past approvals and rejections, how much risk they accept
- **Every line carries receipts.** Cuy's Emmanuel "carries the receipts" for his facts. Czar's version goes further:
  - each belief links to the observation events behind it
  - each has a confidence score and a "last seen" date
  - beliefs fade if they aren't seen again
- **The person can read, edit or delete any line.** That builds consent, and it fixes wrong guesses.
- **Phase 1 use of confirmed answers (D90):** constraints, a mission deadline for the same project, and the hourly value. Taste, place and spending posture are saved context until a later design uses them.
- **Storage:** local-first and encrypted. Only a hash of each version is committed on Arc, so the soul can be proven without being revealed.
- **How it's built:**
  1. Each observer (Claude Code, Codex, Cursor, Chrome) emits normalized `ActivityEvent` records.
  2. The events go into the shared memory (an event store).
  3. A nightly "soul compiler" (LLM plus rules) updates the soul.
  4. The person sees a weekly diff: "What Czar learned about you this week."
- **Why it matters:** it turns a log into an identity that produces wants. Unlike an invented soul, every want is traceable to real work.

### 1.2 Drives engine: from open loops to objectives

- **Detectors for unfinished business:**
  - `TODO`, `FIXME`, `TBD` and placeholders like "[Add link]" in code and docs
  - branches or documents untouched for days
  - the same topic searched again and again
  - the same error hit repeatedly
  - the agent saying "I can't do that"
  - copy-paste loops between tools
  - deadlines mentioned in documents
- **Each open loop becomes a candidate objective:** goal, the evidence behind it, deadline, estimated minutes saved, and the capabilities needed (e.g. "web search + table extraction + chart").
- **A value-of-time filter:**
  - Czar estimates the person's hourly value (from role and locale, and the person can set it).
  - It surfaces an objective only when minutes saved × hourly value beats the price by a clear margin, e.g. 5×.
  - This keeps Czar from spamming, and it makes every suggestion an ROI case.
- **Why it matters:** this is Cuy's "prompts → loops" leap for commerce. Demand stops waiting for the person to have an idea.

### 1.3 Soul injection: every agent the person runs becomes a buyer

- **What it is:** Czar writes a compact version of the soul, plus a pointer to its payment tool, into the person's other agents:
  - `CLAUDE.md` or a skill for Claude Code
  - `AGENTS.md` for Codex
  - `SOUL.md` for harnesses like Hermes and OpenClaw (named in Cuy's article)
- **Czar exposes an MCP server with five tools:** `get_objectives`, `find_service`, `quote`, `pay` (from the vault, within limits) and `report_outcome`.
- **Why it matters:**
  - Czar becomes infrastructure for every agent the person uses, not one more app.
  - All spending flows through the vault, so every purchase produces evidence.
- **Risk:** injected text is an attack surface. Keep it minimal, and gate every payment through the vault's on-chain limits.

### 1.4 Earned autonomy: spending limits that grow with track record (on-chain)

- **What it is:** the vault's auto-approve limit rises with verified good outcomes and falls after disputes or refunds.
  - Rule of thumb: limit = base × f(purchases with positive evidence), never above the person's own maximum.
  - Separate limits per category (research, data, creative).
  - Every change is an on-chain event, and the person can freeze everything in one tap.
- **Why it matters:**
  - People delegate more as trust builds, so they spend more over time.
  - It's a reusable primitive: a trust-weighted allowance any agent app could use.
- **Fits the decision already made:** limits live in Czar's own vault contract on Arc.

### 1.5 Shadow mode: the "what you missed" report

- **What it is:** for the first week, Czar only watches. It prices what it *would* have bought, then shows: "You spent 3h 10m on competitor research. Czar could have done it for $0.62 using [service]."
- **Exception (D90):** when the person clicks **Do this** on an open task Czar found in a current file, that one task may go ahead during the first week. Do this is not spending approval: the person still approves the plan, and earned allowance never pays for it. The rest of the first week stays in shadow mode. (Built with the Flow 7 evidence review, SCR-030.)
- **Why it matters:**
  - Proof of value comes before any request for money, which lifts conversion.
  - It's also the clearest way to show a new user Czar's value: replay a real day, then show the bill Czar would have run.

### 1.6 Team soul and team vault (later)

- **What it is:** members' souls roll up into a team soul with shared objectives. A team vault holds a pooled budget with per-member limits.
- **Why it matters:** white-collar work happens in teams, and companies already pay for tools. This answers "who pays" with bigger budgets.

---

## Part 2 — The growth engine

### 2A. For users: delegate more, pay more

#### 2.1 Objective envelopes
- One approval per objective, not per payment.
- The objective comes with a priced plan. The approved amount is locked in an on-chain envelope, steps are paid from it, and anything unspent is refunded automatically.
- Same pattern as the earlier quote-first design, built natively on Arc.

#### 2.2 Pay on acceptance
- Results are checked against acceptance rules before payment is released (`1_b` component C7, acceptance profiles).
- Larger jobs go through ERC-8183 with Czar's validator as the evaluator.
- "Money back by default" lowers the risk of delegating, so people delegate more.

#### 2.3 Deliver results into the workflow
- Results land where the work is: a PR comment, a section inserted into the doc, rows added to the spreadsheet, a drafted email.
- Each observer gets a matching write-back adapter.
- Value people actually use leads to repeat buying. A chat answer they have to copy over doesn't.

#### 2.4 Standing objectives
- Recurring needs become standing orders under a budget, e.g. "competitor price scan every Monday."
- This converts one-off demand into recurring revenue for merchants, the biggest volume multiplier in this list.

#### 2.5 Recipes with on-chain revenue splits
- A recipe is a reusable multi-step workflow that calls several merchants, e.g. "market brief" = search + three page scrapes + summary + chart.
- Each run pays every merchant in the recipe *and* the recipe's author, split by a splits contract on Arc.
- **This is how skill makers get paid.** A skill becomes a recipe, and its author earns per run instead of hoping for tips.

#### 2.6 ROI ledger
- Every receipt shows estimated minutes saved next to its cost.
- A monthly statement: "Czar saved you 14 hours for $9."
- A visible return justifies a bigger budget next month.

#### 2.7 Context minimization
- Before any call, Czar strips names, secrets and private details, and sends merchants only what the task needs.
- White-collar users and their employers will ask about this. It's the practical answer to the security question that comes back with this user group.

### 2B. For merchants and specialist agents: earn more

#### 2.8 Demand radar
- An anonymous, aggregated feed of objectives Czar couldn't fill well: "412 people this week needed X; no service exists, or the existing ones failed."
- It's only published above a minimum group size, so no individual can be identified.
- Merchants build what's wanted, so supply follows real demand.

#### 2.9 Unmet-demand jobs (ERC-8183)
- When no service fits, Czar posts an open ERC-8183 job with no provider named yet. A provider is set later with `setProvider`, once a specialist agent takes it.
- Latent demand turns into paid jobs for specialist agents.

#### 2.10 Exploration budget for new merchants
- A small share of spending goes to new services that passed probes but have no sales history yet, chosen with a bandit method such as Thompson sampling.
- Pay on acceptance (2.2) protects the user if the new merchant fails.
- This puts the Unfairness Report's cold-start fix into practice: newcomers get their first revenue.

#### 2.11 Merchant fix-it feedback
- When a merchant is skipped or fails acceptance, it gets the structured reason, e.g. "output missing field X", "p95 latency 4.2s vs 2s budget", "price 3× peer median."
- Merchants fix the problem and win more work.
- Reuse the Decipher Ranker merchant cockpit and FixList.

#### 2.12 Signed quotes and `upto` pricing
- Merchants sign a quote that holds for N minutes, so plans don't change mid-run.
- Support x402's `upto` scheme (pay actual cost up to a cap) so merchants can sell bigger, variable-cost jobs. 25 catalog entries already use it.

### 2C. Protocol level: the piece no one else has

#### 2.13 Proof of real demand
- **What it is:** each purchase is linked by hashes into one chain of evidence:
  1. the observation of real work
  2. the objective it produced
  3. the person's approval, signed with their passkey
  4. the payment
  5. the outcome evidence
- The chain is anchored on Arc through `OpenEvidenceLog` from `1_b`.
- **Why it matters:**
  - Rankers can weight purchases that started with a real person above agent self-dealing.
  - It's evidence for Circle's "stranger test": a genuine third-party buyer.
  - It answers the wash-volume problem your research flagged. Your Circle deep-dive cites a measurement study that found 84.98% of x402 settlements on Base were operator-internal.
- **The headline:** Czar doesn't just add volume, it adds volume that can be proven real.

---

## 3. Phase 1 scope

- **Soul and demand:** 1.1 (soul v0 from the Claude Code observer, plus the optional interview and reviewed suggestions from selected agent files, tracked git work, pastes and agent summaries, D90), 1.2 (three detectors), 1.5 (shadow report as onboarding; per-task Do this exception after SCR-030)
- **Not in Phase 1 (D90):** chat-archive import (SCR-031), a native folder picker, manual task entry (P2-16)
- **Contracts core:** 2.1 envelopes with 1.4 earned autonomy in the vault, 2.5 one recipe with an on-chain split
- **Proof:** 2.13 evidence chain anchored on Arc testnet
- **Last mile:** 2.3 one write-back surface (e.g. a PR comment or doc insert)
- **Lite version:** 1.3 as an MCP server only, with no injection into other agents yet
- **Later:** 1.6, 2.4, 2.8, 2.9, 2.10, 2.11, 2.12

---

## 4. Risks these ideas add

- **Soul privacy:** a soul is the most sensitive file Czar holds. Keep it local-first, user-editable, and on-chain only as a hash.
- **Runaway spending from generated objectives:** envelopes, on-chain limits and shadow mode come first.
- **Injected souls as an attack surface:** minimal injected text, and payments always gated by the vault.
- **Wrong or uncomfortable hourly-value estimates:** let the person set it.
- **Demand radar leaking information:** minimum group sizes before anything is published.

---

## 5. One-line positioning

- "Cuy Sheffield says: stop writing tasks, start writing souls. Czar writes the soul for you, from your work, and proves every dollar it spends came from a real person's need."
