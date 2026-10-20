# Czar: product document

- **Owner:** Zaryab
- **Last updated:** 2026-10-18
- **Status:** the current, complete definition of the product. Supersedes earlier versions of this file.
- **Related docs:**
  - `docs/product/decisions-log.md` — decisions made so far and the reasoning behind them
  - `docs/product/feature-roadmap.md` — the feature list this doc builds on, in priority order
  - `docs/architecture/selection-layer-architecture.md` — the evidence-based Selection Layer that Czar includes

---

## 1. Czar in one paragraph

- **Czar watches how a person works, builds a "work soul" for them from what it sees, and turns that soul's unfinished business into objectives that agents complete by buying services in the open agentic economy.**
- Payments are made in USDC on Arc. They go to x402 merchants, to specialist agents doing ERC-8183 jobs, and to the builders whose tools and workflows are used.
- Every purchase produces evidence. That evidence ranks merchants by real performance, and it proves on-chain that each purchase came from a real person's need.

---

## 2. The problem

### 2.1 The agentic economy has supply but almost no demand
- New pay-per-call services come online every week: data, search, media, phone calls, compute.
- Real buying is tiny compared with that supply. Merchants and specialist agents earn very little. Zaryab's own research documents this.
- A senior industry voice makes the same point: Cuy Sheffield (Visa Crypto Labs, personal views) estimates x402 and MPP together did about $87k in a week from about 12k wallets.

### 2.2 Why: demand is capped by human time and imagination
- Every agent payment today starts with a person who thought of a task and typed it.
- People who actually work don't have time to explore what exists. They don't know which merchants, agents or tools could do part of their job better.
- Most people hear about useful tools only by chance, for example by being on Twitter all day.

### 2.3 Discovery is unfair and unproven
- Today's catalogs list services but don't judge them. Circle's Discovery API returns no quality, usage or reputation data, and its search matches spelling, not meaning.
- Ranking by sales volume favours incumbents and can be gamed. Much of today's x402 volume is operators paying themselves.
- New merchants with good services can't get their first customers.

### 2.4 The builders behind people's work go unpaid
- Open-source builders, skill makers and plugin makers create things people use every day, and usually earn nothing from that use.

---

## 3. What Czar is, and what it is not

### 3.1 Czar is
- **A demand engine.** It creates real, well-matched demand from people's actual work.
- **A marketplace with evidence-based discovery.** Merchants are ranked on proof of performance, not on volume or payment.
- **A payment layer.** On-chain budgets, approvals, limits, refunds and revenue splits on Arc.
- **A proof layer.** Each purchase carries a verifiable record that it started with a real person's need.

### 3.2 Czar is not
- Not just a recommendation engine.
- Not a paid-placement or advertising system. Ranking position is never for sale.
- Not an invented persona. The soul comes from observed work, never from fiction.

### 3.3 The origin idea
- Czar began as "Onda for the builders behind people's work." Onda is a browser extension that detects which artist you're listening to and pays them small amounts of USDC on Arc, with escrow for artists who haven't joined yet.
- Czar keeps two ideas from Onda: pay the people whose work you use, and let unclaimed builders claim later. It goes much further on observation, discovery, evidence and on-chain logic.

---

## 4. Who it's for

### 4.1 Users
- **Everyday white-collar professionals who work on screens,** inside or outside crypto.
- They have never heard of x402, and they don't need to.
- What they see: a budget in US dollars (USDC shown as USD, D51, D65), plain-language objectives, one-tap approvals, results delivered where they work, and a clear record of spending and time saved.

### 4.2 Teams and companies
- Teams share objectives and a pooled budget, with limits per member (see 6.13).

### 4.3 Supply side
- **x402 merchants** — pay-per-call services. They set their own prices.
- **Specialist agents** — take on larger work through ERC-8183 escrowed jobs. They set their own prices.
- **Builders** — open-source builders, skill makers and plugin makers. They earn through recipes (6.10) and through claimable payments.

---

## 5. How Czar works: the core loop

1. **Observe.** Observers in the person's work tools record what they do.
2. **Remember.** Observations flow into one shared memory.
3. **Understand.** The soul compiler turns memory into the person's Work Soul.
4. **Want.** The drives engine finds unfinished business in the soul and turns it into objectives.
5. **Price.** For each objective, Czar finds the right services through the Selection Layer and builds a priced plan.
6. **Approve.** The person approves once. The approved amount is locked in an on-chain envelope.
7. **Execute.** Agents pay merchants, specialist agents and recipe authors from the envelope.
8. **Accept.** Results are checked against acceptance rules before money is released.
9. **Deliver.** Results are written back where the person works.
10. **Prove and learn.** The full trail is anchored on Arc as evidence. It updates merchant rankings, the person's soul, and their earned spending limits.

---

## 6. Product components

Components are numbered in the adopted priority order.

### 6.1 Observers
- **What:** small agents that run inside the person's work tools and record activity.
- **Surfaces:** Claude Code (through its hooks), Codex, Cursor, and a Chrome extension.
- **Output:** normalized `ActivityEvent` records (see 7.1), sent to the shared memory.
- **Rule:** observers record activity. They never spend money.

### 6.2 Shared memory
- **What:** one event store that collects and organizes everything all the observers learn about how the person works.
- **Local-first and encrypted.** It lives on the person's device by default.
- **Feeds** the soul compiler and the drives engine.

### 6.3 The Work Soul
- **What:** a living document per person, `SOUL.md` plus a machine-readable `soul.json`. Czar writes it; the person never has to.
- **Sections:**
  - **Place:** locale, language, time zone, currency, and the rules that apply where they work
  - **Mission:** active projects, each with its goal and deadline
  - **Rituals:** recurring tasks and how often they happen
  - **Friction:** where time leaks — repeated manual steps, failed agent attempts, context switching
  - **Drives:** open loops and unfinished business
  - **Taste:** quality bar, trusted sources, preferred formats and tone
  - **Constraints:** budget, tools they can't use, privacy limits
  - **Spending posture:** past approvals and rejections, how much risk they accept
- **Every belief carries receipts:**
  - links to the observations behind it
  - a confidence score
  - a "last seen" date
  - beliefs fade if they aren't seen again
- **The person can read, edit or delete any line.**
- **Weekly update:** "What Czar learned about you this week."
- **Only a hash of each version goes on-chain,** so the soul can be proven without being revealed.
- **Built by the soul compiler:** LLM plus rules, run on a schedule over the shared memory.

### 6.4 Drives engine
- **What:** turns unfinished business in the soul into candidate objectives.
- **Detectors include:**
  - `TODO`, `FIXME`, `TBD` and placeholders in code and documents
  - work left untouched for days
  - the same topic searched again and again
  - the same error hit repeatedly
  - an agent saying "I can't do that"
  - copy-paste loops between tools
  - deadlines mentioned in documents
- **Each objective records:** goal, the evidence behind it, deadline, estimated minutes saved, and the capabilities needed.
- **Value-of-time filter:**
  - Czar estimates the person's hourly value from role and locale; the person can set it themselves.
  - An objective is shown only when minutes saved × hourly value clearly beats the price, e.g. by 5×.
- **Frequency:** daily or weekly, as the person chooses.

### 6.5 Soul injection and the Czar MCP server
- **What:** Czar writes a compact version of the soul, plus access to its payment tools, into the person's other agents:
  - `CLAUDE.md` or a skill for Claude Code
  - `AGENTS.md` for Codex
  - `SOUL.md` for harnesses such as Hermes and OpenClaw
- **The Czar MCP server's tools:**
  - `get_objectives`
  - `find_service`
  - `quote`
  - `pay` — from the vault, within limits
  - `report_outcome`
- **Effect:** every agent the person runs becomes a buyer, and all spending flows through the vault, so every purchase produces evidence.
- **Guardrails:** injected text is kept minimal, and every payment is checked against the vault's on-chain limits.

### 6.6 Earned autonomy
- **What:** the vault's auto-approve limit rises with verified good outcomes and falls after disputes or refunds.
- **Details:**
  - limit = base × f(purchases with positive evidence), never above the person's own maximum
  - separate limits per category (research, data, creative, and so on)
  - every change is an on-chain event
  - a one-tap freeze stops all new spending: the vault refuses new payments, Czar's signer refuses pocket payments and job payouts, and pocket funds are pulled back (D72). Payments signed just before the freeze can still settle
- **Effect:** people delegate more as trust builds. The mechanism is reusable by other agent apps.

### 6.7 Shadow mode
- **What:** during a person's first week, Czar only watches. It prices what it *would* have bought and reports: "You spent 3h 10m on competitor research. Czar could have done it for $0.62."
- **Effect:** proof of value before any request for money.

### 6.8 Objective envelopes
- **What:** one approval per objective, not per payment.
- **How:**
  1. The objective comes with a priced plan.
  2. The approved amount is locked in an on-chain envelope.
  3. Each step is paid from the envelope.
  4. Anything unspent is refunded automatically.
- **Signing:** the person approves with a passkey, so there's no seed phrase and no visible gas.

### 6.9 Delivery into the workflow (write-back adapters)
- **What:** results land where the work is: a PR comment, a section inserted into a document, rows added to a spreadsheet, a drafted email.
- **One write-back adapter per observer surface.**

### 6.10 Recipes with revenue splits
- **What:** a recipe is a reusable, multi-step workflow that calls several merchants. Example: "market brief" = search + three page scrapes + summary + chart.
- **Each run pays** every merchant in the recipe *and* the recipe's author, split by a splits contract on Arc.
- **This is how builders get paid.** Skill makers and workflow authors publish recipes and earn on every run.
- **Builders who haven't joined yet:** their share is held in escrow under their identity until they verify and claim it.

### 6.11 ROI ledger
- **What:** every receipt shows estimated minutes saved next to its cost.
- **Monthly statement:** "Czar saved you 14 hours for $9."

### 6.12 Context minimization
- **What:** before any call, Czar strips names, secrets and private details, and sends a merchant only what the task needs.

### 6.13 Team soul and team vault
- **What:** members' souls roll up into a team soul with shared objectives.
- **A team vault** holds a pooled budget with limits per member, and the company pays.

### 6.14 Pay on acceptance
- **What:** results are checked against acceptance rules before money is released. These are the acceptance profiles in the Selection Layer (6.21).
- **Larger jobs** run as ERC-8183 jobs with Czar's validator as the evaluator.
- **Default:** money back when a result fails.

### 6.15 Standing objectives
- **What:** recurring needs become standing orders under a budget. Example: "competitor price scan every Monday."
- **Effect:** one-off buying becomes recurring revenue for merchants.

### 6.16 Demand radar
- **What:** an anonymous, aggregated feed for merchants of objectives Czar couldn't fill well. Example: "412 people this week needed X; no service exists, or the existing ones failed."
- **Privacy:** published only above a minimum group size.

### 6.17 Unmet-demand jobs
- **What:** when no service fits an objective, Czar posts an open ERC-8183 job with no provider named.
- **How:** the provider is set later with `setProvider`, when a specialist agent takes the job.

### 6.18 Exploration budget for new merchants
- **What:** a small share of spending goes to new services that pass probes but have no sales history yet.
- **How:** chosen with a bandit method such as Thompson sampling.
- **Protection:** pay on acceptance (6.14) means the user doesn't lose money if a new merchant fails.

### 6.19 Merchant fix-it feedback
- **What:** merchants that are skipped or fail acceptance get the structured reason. Examples: "output missing field X", "p95 latency 4.2s vs 2s budget", "price 3× peer median."

### 6.20 Signed quotes and `upto` pricing
- **Signed quotes:** merchants sign a quote that holds for a set time.
- **`upto` pricing:** support for x402's `upto` scheme, which pays the actual cost up to a cap, for variable-cost work.

### 6.21 Selection Layer: evidence-based discovery
- **What:** the marketplace's discovery and ranking engine, specified in full in `docs/architecture/selection-layer-architecture.md`.
- **Sources of services:**
  - live queries to Circle's Discovery API
  - merchants registering directly with Czar
  - paid endpoints discovered on-chain
  - ERC-8004 registrations
- **Evidence it uses:**
  - buyer-signed receipts bound to the payment
  - pre-committed probes by independent probers
  - ERC-8183 job outcomes
- **Matching:** semantic matching of objectives to service capabilities, not spelling-based search.
- **Ranking rules:**
  - position is never for sale
  - "no history" is kept separate from "bad history"
  - unverified services appear in their own labelled section
  - rankings are explained and can be recomputed by anyone from the published evidence
- **Anchoring:** `OpenEvidenceLog` on Arc anchors probe commitments, evidence batches and policy releases.

### 6.22 Proof of real demand
- **What:** every purchase is linked by hashes into one chain of evidence:
  1. the observation of real work
  2. the objective it produced
  3. the person's passkey-signed approval
  4. the payment
  5. the outcome evidence
- **Anchored** on Arc through `OpenEvidenceLog`.
- **Effect:** rankers can weight purchases that started with a real person above agent self-dealing. Czar adds volume that can be proven real.

### 6.23 Builder identity and claims
- **What:** each builder gets one claimable identity, such as an ENS name or another on-chain ID, that ties together their GitHub, package and payout addresses.
- **Admission of free tools and skills** into the marketplace uses signals that are hard to fake, such as GitHub stars and reviews.

---

## 7. Data model (summary)

### 7.1 `ActivityEvent`
- Source surface, timestamp, event type (tool call, file read or write, command, search, error, agent refusal, page visit), redacted content summary, project reference.

### 7.2 `soul.json`
- The eight sections in 6.3. Each belief holds its value, evidence links, confidence, last-seen date and version.

### 7.3 `Objective`
- Goal, evidence links, deadline, estimated minutes saved, capabilities needed, priced plan, status.

### 7.4 Signed records (EIP-712)
- **Approval:** objective hash, envelope cap, expiry — signed by the person's passkey.
- **Quote:** merchant, price, validity window — signed by the merchant.
- **Receipt:** payment reference, result hash, acceptance result — signed by the buyer.
- **Evidence link:** hashes chaining observation → objective → approval → payment → outcome.

---

## 8. On-chain components (Arc)

### 8.1 `CzarVault`
- Holds each person's or team's budget in USDC.
- Per-category limits, earned-autonomy limits, freeze.
- Objective envelopes: open, fund on approval, pay steps, settle and refund.
- Checks passkey approvals through ERC-1271.

### 8.2 `RecipeSplits`
- Splits each recipe run between its merchants and the recipe author.
- Escrows shares for builders who haven't claimed their identity yet.

### 8.3 `OpenEvidenceLog`
- Anchors evidence batches, probe commitments, soul-version hashes and proof-of-demand chains.

### 8.4 Existing standards used
- **USDC** on Arc for all payments.
- **Circle Gateway Nanopayments** for small per-call payments.
- **ERC-8183** for escrowed jobs with specialist agents.
- **ERC-8004** for agent identity, portable feedback and validation.

### 8.5 Network
- Arc. Development runs on Arc testnet, paying x402 merchant services deployed there with Circle's seller SDK.

---

## 9. User experience

### 9.1 Surfaces
- **Web app (desktop browser in Phase 1; mobile in stage 2, D69):** budget, objectives, approvals, results, spending history, ROI ledger, soul viewer and editor, freeze button.
- **Plugins and extension:** observers and write-back in Claude Code, Codex, Cursor and Chrome.

### 9.2 First-time journey
1. Sign up with a passkey and set a budget in US dollars (USDC shown as USD, D51, D65).
2. Install the observer in the tools you use.
3. Week one runs in shadow mode, ending with a "what you missed" report.
4. Approve your first objective with one tap.
5. The result arrives in your work, with a receipt showing cost and time saved.

### 9.3 Everyday journey
- Czar surfaces objectives daily or weekly.
- Small objectives under your earned limit run on their own. Bigger ones wait for your approval.
- Standing objectives run on schedule.

---

## 10. Trust, safety and privacy

- **The soul is the most sensitive data Czar holds.** It stays local-first, encrypted and user-editable. Only hashes go on-chain.
- **Spending is bounded on-chain:** envelopes, per-category limits, earned autonomy and freeze.
- **Generated objectives never spend without** an approval or an earned limit.
- **Context minimization** happens before every merchant call.
- **Injected souls are minimal,** and every payment they trigger goes through the vault.
- **The demand radar** publishes only above minimum group sizes.

---

## 11. Build order

### 11.1 Phase 1 — the core loop
- Observer for Claude Code
- Shared memory
- Work Soul v0
- Drives engine with three detectors
- Shadow mode
- `CzarVault` with objective envelopes and earned autonomy
- One recipe with on-chain revenue splits (`RecipeSplits`)
- Proof-of-real-demand chain anchored in `OpenEvidenceLog`
- One write-back surface
- Czar MCP server

### 11.2 Phase 2 — growth
- Observers for Codex, Cursor and Chrome
- Full soul injection into other agents
- Pay on acceptance
- Standing objectives
- ROI ledger
- Context minimization
- Full Selection Layer

### 11.3 Phase 3 — scale and supply side
- Team soul and team vault
- Demand radar
- Unmet-demand ERC-8183 jobs
- Exploration budget for new merchants
- Merchant fix-it feedback
- Signed quotes and `upto` pricing

---

## Change log

| Date | ID | Change |
|---|---|---|
| 2026-10-19 | D65 | §4.1 and §9.2: budgets shown in US dollars (USDC 1:1, D51) instead of the user's own currency. |
- 2026-10-19 · D69: §9.1 surface renamed to the desktop web app; mobile is stage 2.

- 2026-10-19 · D72 / RV-007: §6.6 freeze wording narrowed to what is enforced (new spending stops; pockets pulled back).
