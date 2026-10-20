# 2. Supplier matching and market knowledge

- **ID:** I-F-2
- **Raised by:** Zaryab, while reviewing the architecture (from "Observation → objective" into "Planning")
- **Date:** 2026-10-19
- **For:** the project architect agent, to review and turn into decisions, spec changes and tasks
- **Status:** requested feature. Not yet a decision.
- **Related:** `1_soul-inputs-beyond-observation.md` (knowing the user), `3_specialist-agent-discovery.md` (finding ERC-8183 agents)

---

## 1. The problem

Czar's core promise is to tell the user **exactly which services, specialist agents or tools will get their job done**, and buy them. That needs two kinds of knowledge:

- **A. Knowing the user:** what they work on, how they work, what they need. Covered by the soul, the drives engine and feature 1.
- **B. Knowing the market:** which x402 merchants, ERC-8183 specialist agents and (later) open-source skills or repos exist, what each one really does, how good it is and what it costs.

**Knowing the market is the weakest part of the design today.** It exists, but it's thin:

1. **Needs are squeezed into 13 fixed tags.** The drives engine turns an objective into tags from a fixed list (`local-soul-and-drives.md` CZ-06 §5.3): `web-search`, `page-extract`, `table-build`, `summarize`, `translate`, `data-lookup`, `price-lookup`, `email-lookup`, `company-lookup`, `image-generate`, `transcribe`, `code-review`, `chart-build`. Anything outside them can't be expressed. The model (P-05) may reorder or drop tags but never add one.
2. **Matching is exact tag matching, not meaning.** The Selection Layer's Phase 1 retrieval is "capability-tag match (exact tags from the planner's taxonomy)" (`server-acceptance-evidence-selection.md` CZ-18 §5.1, C3). Keyword search plus embeddings is Phase 2.
3. **The main source of services is Circle's catalog, which is poor at search:**
   - It has no ranking, rating, uptime or reputation fields, and its text search matches spelling, not meaning (ground truth part 1 D3).
   - Its filter accepts only 6 categories, and `DATA_ENRICHMENT` is rejected (F4-03).
   - In Phase 1 Czar uses only Circle's `category` and `tags` fields. Service descriptions are thrown away (CZ-18 §5.3).
   - Czar may not mirror it (part 1 D8, D15), so it must be queried live every time.
   - On Arc testnet it lists 134 items, 132 of them RPC endpoints (part 1 D6). On testnet there's almost nothing useful to buy except Czar's own merchants.
4. **New services are excluded by default (a chicken-and-egg problem):**
   - A service is "unverified" until it has at least 5 effective checked calls (`selection.nMin` = 5).
   - The planner's default is `unknown_policy = exclude` (`selection.plannerUnknownPolicy`), so it never pays an unverified service.
   - The "exploration slot" that would try new services is Phase 3.
   - Result: in Phase 1 only services that already have Czar evidence can be bought. In practice that means Czar's own three merchants (`czar-spot`, `czar-extract`, `czar-search`).
5. **The soul doesn't shape supplier choice.** The planner reads only `constraints` from the soul (`ObjectiveSubmission.constraints`). Taste ("prefers Markdown tables"), Friction and Mission don't influence which supplier is picked or what output is asked for.
6. **No agent discovery.** There's no mechanism to find ERC-8183 specialist agents. That's file 3.
7. **No open-source index.** Skills, plugins and repos only arrive later as "recipes" (roadmap 2.5). Nothing finds an existing free tool that would solve the need without paying anyone.

### What this means for the user, in the Sam example

- Sam's need "fill a competitor price table" becomes `web-search` + `page-extract` + `table-build`.
- The planner finds whatever has those exact tags *and* already has Czar evidence.
- It never considers:
  - a specialist "SaaS pricing research" agent
  - a paid dataset of competitor prices
  - a free open-source scraper skill Sam could just install
- And it doesn't know Sam wants the result as a Markdown table.

## 2. What the project says today

| Where | What it says |
|---|---|
| `docs/specs/04-components/local-soul-and-drives.md` CZ-06 §5.3 | Fixed 13-tag capability taxonomy. P-05 may not add tags outside it. |
| `docs/specs/04-components/server-planning-and-payment.md` CZ-13 §5 steps 1–3 | Capabilities → task classes → CZ-18 `RankingDecision` → probe the top 3 live 402s. |
| `docs/specs/04-components/server-acceptance-evidence-selection.md` CZ-18 §5.1 | Phase 1 retrieval = exact tag match; BM25 + embeddings in Phase 2; probers Phase 2–3; exploration slot Phase 3. |
| same, §5.2 | Unverified = `n_eff` < 5; never scored; the planner excludes unknowns by default. |
| same, §5.3 | Circle's catalog is live-only; only `category` and `tags` are used in Phase 1; descriptions are discarded. |
| `docs/specs/00-ground-truth/circle-arc.md` D3, D5, D6, D8 | No ranking in the catalog; category filter broken; testnet is mostly RPC; terms forbid mirroring. |
| `docs/product/feature-roadmap.md` 2.5 | Recipes (skills as paid workflows) come later. |

## 3. Features for version 1

### 2.1 A richer description of the need

- **What:** the objective carries a **need description**, not just tags:
  - the task in plain words (redacted)
  - the expected output shape (format, fields)
  - the quality bar
  - deadline and budget
- **Taste and Constraints from the soul fill the output shape and limits** (for example "Markdown table", "EUR", "no customer names").
- **Tags stay** as a coarse first filter, but the taxonomy becomes **extensible**: a versioned list in `@czar/config` that the architect can grow, with a "no matching tag" path instead of silently forcing a bad fit.
- **Done when:** an objective sent to the server includes the need description and the output shape, and the planner passes the output shape to the step input and to the acceptance profile.

### 2.2 Meaning-based matching in Phase 1

- **What:** bring the Phase 2 retrieval forward. Use keyword search (BM25) plus embeddings over:
  - Czar's own index
  - the **live** Circle catalog text (descriptions, input and output schemas), used in memory only and discarded after the query, as today
- **Embedding choice:** follow ground truth C1. Store ≤ 1,024 dimensions and record the model ID with each vector.
- **Safety:** catalog text is still retrieval-only. It never affects the score and never reaches the planner raw (current rule).
- **Done when:** a need such as "competitor SaaS prices into a table" retrieves relevant services even when their tags differ, and a test shows catalog text can't change a service's score.

### 2.3 Czar's own market index (understand what each service really does)

- **What:** a Czar-maintained index of services with **verified, structured capability cards**:
  - what the service actually returns
  - its input and output schema
  - observed latency and price
  - which needs it solved before
- **How:**
  - The card is filled from the live 402 (the x402 Bazaar `extensions.bazaar` info and schema, part 2 A3-35) and from Czar's probes.
  - Merchants can register (the Phase 2 `POST /v1/index/submit` brought forward).
- **Rule:** it must respect Circle's terms (no mirroring of Circle's catalog, part 1 D8). Cards are built from Czar's own probes and registrations, not copied from Circle.
- **Done when:** every service Czar can buy has a capability card, and the planner matches needs against cards, not just tags.

### 2.4 A safe way to try new services (fix the chicken-and-egg)

- **What:** bring a limited exploration path forward from Phase 3. Without it, only Czar's own merchants can ever earn evidence.
- **Options for the architect** (pick one or combine):
  - **Czar-funded probes:** Czar pays for test calls to new services with its own small budget, checks the results, and builds evidence before any user money is used. The prober is Phase 2 in the spec today.
  - **User opt-in exploration:** a per-user setting "allow untested services up to $X per objective", shown clearly on the approval screen.
  - **Shadow comparison:** in shadow mode, quote unverified services next to verified ones so the user can choose to try them.
- **Done when:** a new merchant can go from unverified to ranked on testnet without manual seeding, and no user money reaches an unverified service without explicit opt-in.

### 2.5 Use the soul when choosing and briefing suppliers

- **What:** the planner gets a **redacted, structured preference set** from the soul: output format, trusted sources, quality bar, budget posture.
- **It uses that set to:**
  - break ties between suppliers
  - fill each step's input (for example "return Markdown")
  - set the acceptance checks
- **Safety:** structured fields only, no free soul text to the planner (same rule as today for merchant text).
- **Done when:** two users with different Taste get different output formats for the same objective.

### 2.6 Explain the match to the user

- **What:** each plan step says why this supplier was chosen, in plain words:
  - which part of the need it covers
  - its evidence
  - its price
  - the alternatives and why they lost
- **Done when:** the approval screen shows the reason for every supplier and every rejected alternative.

## 4. Low priority (later versions)

| # | Item | Why later |
|---|---|---|
| L1 | **Open-source tools index** (skills, plugins, MCP servers, repos) as zero-cost suppliers, so Czar can say "install this free skill" instead of paying | Needs its own trust model (code you install is riskier than an API you call). It also ties into recipes (roadmap 2.5) and builder payouts. Strongly wanted, but as its own feature once paid matching works. |
| L2 | Learning the tag taxonomy from real objectives | Needs volume. |
| L3 | Merchant-side "fix-it" feedback (spec Phase 3, §6.19) | Already planned. |

## 5. What the architect needs to change

1. **`docs/specs/02-data-and-protocol/`:**
   - Add a need-description and output-shape object to `Objective` / `ObjectiveSubmission`.
   - Add a capability-card shape to the Czar index item (spec 02 §12).
2. **`docs/specs/04-components/local-soul-and-drives.md`:**
   - P-05 writes the need description.
   - The taxonomy becomes versioned config with a "no fit" path.
   - The soul's Taste and Constraints feed the output shape.
3. **`docs/specs/04-components/server-acceptance-evidence-selection.md`:**
   - Move BM25 + embeddings retrieval and capability cards into Phase 1.
   - Choose an exploration path (2.4).
   - Update the `selection.plannerUnknownPolicy` rules.
4. **`docs/specs/04-components/server-planning-and-payment.md`:** the planner consumes the need description, capability cards and the preference set; steps carry output-shape inputs; plans carry the reasons for each choice.
5. **`docs/specs/04-components/ai-prompts.md`:** update P-05 (need description) and P-03 (planner reads cards and preferences as structured data only).
6. **Ground truth:** confirm Circle's terms allow in-memory use of catalog descriptions for retrieval (today's spec AR-11 marks the legal reading as low confidence).
7. **Board and `docs/specs/05-build-plan/phase-1-tasks.md`:** new or moved tasks under CZ-18 (Selection Layer, M7), CZ-13 (Planner) and CZ-06 (Drives engine). **Consider moving Selection Layer work earlier than M7**, since every money path depends on it.

## 6. Open questions for the architect

- Is the Selection Layer still "lite" in Phase 1 once matching is admitted to be the core value? Should part of Phase 2 move into Phase 1?
- Who pays for exploration: Czar or the user?
- How does Czar build capability cards for Circle-listed services without breaking the no-mirroring rule?
- On testnet, where will enough real services come from to test matching at all? Czar's own merchants only cover 3 needs.
