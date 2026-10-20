# 3. Specialist agent discovery (ERC-8183)

- **ID:** I-F-3
- **Raised by:** Zaryab, while reviewing the architecture (Planning and the ERC-8183 job flow)
- **Date:** 2026-10-19
- **For:** the project architect agent, to review and turn into decisions, spec changes and tasks
- **Status:** requested feature. Not yet a decision.
- **Related:** I-F-2 (`2_supplier-matching-and-market-knowledge.md`), I-F-4 (`4_job-delegation-detection.md`)
- **Depends on research:** I-R-1 (`docs/imperative-research/1_arc-job-provider-index.md`): whether any provider index exists on Arc and what to build for the hackathon
- **Scope note (Zaryab, 2026-10-19):** ranking job providers is **not** a priority. ERC-8183 is a niche market with few providers, and some will be Czar-run. Version 1 needs **finding and listing** providers, not scoring them.

---

## 1. The problem

- Czar has a full payment path for **specialist agents**: ERC-8183 jobs with escrow, where Czar is the evaluator and releases money only when the work passes. It's the only path where "pay on acceptance" is enforced on-chain (spec 01 §1, D27).
- **But nothing in the specs says how Czar finds those agents.**
  - The payment router sends a step to an ERC-8183 job when "Supplier is a specialist agent, or the step needs acceptance before payment, or `unitAmount ≥ routing.jobThresholdAtomic` (5 USDC)" (`server-planning-and-payment.md` CZ-14 §5 step 1).
  - So it assumes the supplier is **already known** to be a specialist agent. No component searches for agents, checks what they can do, or decides which one to hire.
  - The Selection Layer's sources are Czar's merchant index and Circle's x402 catalog, which lists HTTP endpoints, not agents.
- **Result:** the escrow path is built, tested and paid for, but has no supply. In the Phase 1 acceptance scenario a job can only go to an agent Czar sets up itself.

## 2. What the project says today

| Where | What it says |
|---|---|
| `docs/specs/04-components/server-planning-and-payment.md` CZ-14 §5 | Routing rule 1 sends "specialist agent" suppliers to `erc8183-job`. No definition of how a supplier becomes one. |
| `docs/specs/04-components/server-acceptance-evidence-selection.md` CZ-18 §5.1 | ERC-8004 reads are Phase 2, "identity only". No agent retrieval in any phase. |
| same, CZ-16 | Czar acts as the ERC-8183 evaluator (K7) and checks deliverables. |
| `docs/specs/02-data-and-protocol/` §4.7, §4.11 | Plans can name ERC-8183 providers as payees (`PayeeLeaf.kind` = 2); `JobRecord` stores `provider`. No provider directory. |
| Ground truth part 2 A4, A5 | ERC-8183 has no official mainnet instance; Circle's testnet instance has ~187k jobs but no directory. ERC-8004 has registries on Arc, but usage is thin and concentrated (part 1 R3: 2,316 mainnet agents, 80.7% from two bulk registrants), and feedback needs no permission, so it's easy to spam (A5-07). |

## 3. Sources that could feed discovery (from current ground truth)

| Source | What it gives | Trust |
|---|---|---|
| **ERC-8004 Identity Registry** on Arc (part 1 R1) | Agent ID, owner, `agentURI` → registration file with `name`, `description`, `services` (endpoints such as `A2A`, `MCP`, `web`), `x402Support`, `supportedTrust` (part 2 A5-04) | Identity only. Self-declared, unverified. Optional domain proof through `/.well-known/agent-registration.json` (A5-05). |
| **ERC-8004 Reputation Registry** | Feedback values and tags per agent | Weak: anyone except the owner can post (A5-07). Read only from trusted clients (FD-19). |
| **ERC-8183 job history** on Arc (`JobCreated`, `JobCompleted`, `JobRejected`, `JobExpired`, `PaymentReleased` events) | Which provider addresses actually completed paid work, for how much, and how often they were rejected or expired | Strong, on-chain behaviour. Evaluator-affiliated outcomes need care (CZ-18 flags `evaluator-affiliated`). |
| **Czar-registered specialists** | Agents that apply to Czar, describe capabilities and accept Czar as evaluator | As strong as Czar's vetting. |
| **x402 merchants that are really agents** (an `A2A`/`MCP` service with `x402Support: true`) | Overlap between the two markets | Matches through the same capability cards (feature 2.3). |

## 4. Features for version 1

### 3.1 Specialist agent registry in Czar's index

- **What:** extend the Selection Layer's service record to cover **agents**, not only HTTP endpoints. Each agent record holds:
  - a capability card: what it does, its inputs, its deliverable format and typical turnaround
  - its price model and payout address (provider address)
  - its ERC-8004 agent ID, if any
  - its evidence: Czar job outcomes and on-chain job history
- **Done when:** the planner can ask CZ-18 for agents by need and get a **list** of matching providers (unranked is fine) with their capability cards.

### 3.2 Ingest ERC-8004 identities as leads (identity only)

- **What:** the indexer (CZ-19) reads ERC-8004 `Registered` / `URIUpdated` events on Arc and fetches each registration file (sanitized as untrusted text). Agents with services and payout information become **leads**: unverified candidates, not ranked suppliers.
- **Safety:**
  - Registration text is retrieval-only and never scored (same rule as catalog text).
  - Reputation feedback is ignored except from trusted clients.
  - Bulk-registered spam must be filtered. Part 1 R3 shows 80.7% of mainnet agents come from two registrants.
- **Done when:** ERC-8004 agents appear as leads with their capability text, and none can be paid without passing feature 3.4.

### 3.3 Read ERC-8183 job history as evidence (low priority; not needed without ranking)

- **What:** the indexer reads job events from the ERC-8183 instances Czar uses (Circle's testnet instance now, and `CzarJobEscrow` later) and builds per-provider stats: jobs completed, rejected, expired, the amounts, and the median time to submit.
- **Use:** shown to the user as plain facts on the provider card ("completed 12 jobs, 1 rejected"), and kept for future ranking. Not a version 1 requirement.
- **Done when:** a provider's record shows its on-chain completion rate and the ranker uses it, with jobs where Czar was the evaluator marked `evaluator-affiliated`.

### 3.4 Agent onboarding and vetting

- **What:** a way for specialist agents to join Czar's supply. The agent:
  - registers (ERC-8004 ID optional)
  - publishes a capability card
  - accepts Czar as evaluator
  - passes a small Czar-funded trial job, building on the exploration idea in feature 2.4
- **Done when:** a new agent can go from lead to **listed** through a trial job on testnet without manual database edits. For the hackathon, Czar-run agents may be listed directly (see I-R-1, Q5).

### 3.5 Router uses the provider list, not an assumption

- **What:** routing rule 1 becomes: the step goes to `erc8183-job` when the **planner chose a job for this unit of work (I-F-4) and a listed provider matches it**, or the step needs acceptance before payment, or the amount is over the job threshold. In the last two cases the planner must also find a listed provider; if there is none, it falls back or reports "no supplier".
- **Done when:** a plan can contain a job step whose provider came from the provider list, chosen by the user or by a simple rule, with the reason shown on the approval screen.

## 5. Low priority (later versions)

| # | Item | Why later |
|---|---|---|
| L1 | Agent-to-agent negotiation (an agent quotes a custom price or scope before the job) | Needs a protocol choice (A2A or other) and more trust work. |
| L2 | Cross-chain agent discovery (ERC-8004 registries on other chains) | Phase 1 is Arc only. |
| L3 | Publishing Czar's evaluator outcomes to ERC-8004 reputation | Already planned as a Phase 2 mirror. Needs care: Czar is evaluator-affiliated. |

## 6. What the architect needs to change

1. **`docs/specs/01-system-architecture/system-architecture.md`:** add agent discovery to CZ-18's responsibilities and to the Planning and ERC-8183 job flows.
2. **`docs/specs/02-data-and-protocol/`:** an agent record and capability card in the index; agent leads; the `RankingDecision` supplier type (merchant or agent).
3. **`docs/specs/04-components/server-acceptance-evidence-selection.md`:** agent records, ERC-8004 lead ingestion moved from Phase 2 into Phase 1 (identity only), and agent onboarding and trial. Job-history evidence and provider ranking are low priority.
4. **`docs/specs/04-components/server-planning-and-payment.md`:** the CZ-14 routing rule 1 rewrite (3.5); the planner asks CZ-18 for agents.
5. **Indexer (CZ-19):** ERC-8004 `Registered` / `URIUpdated` and ERC-8183 job events as inputs. They are partly listed today for alerts only.
6. **Ground truth:** check current ERC-8004 agent counts and the share of real versus spam registrations on Arc testnet, and whether any ERC-8183 provider directories exist today.
7. **Board and `docs/specs/05-build-plan/phase-1-tasks.md`:** new tasks under CZ-18, CZ-19 and CZ-14. The Phase 1 acceptance scenario (M8) must say where its specialist agent comes from.

## 7. Open questions for the architect

- Will Phase 1 have any real specialist agents, or only a Czar-run test agent? If only a test agent, say so in the acceptance scenario.
- Is ERC-8004 good enough as a lead source given its spam profile, or should Phase 1 use Czar registration only?
- Who pays for agent trial jobs?
- Should one capability card format cover both x402 merchants and agents, so feature 2.3 and feature 3.1 share it?
