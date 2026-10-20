# I-R-1. An index of ERC-8183 job providers on Arc

- **ID:** I-R-1
- **Raised by:** Zaryab, while reviewing Planning (ERC-8183 jobs)
- **Date:** 2026-10-19
- **For:** the research agent first, then the project architect
- **Status:** open research. No spec or architecture work until this is answered.
- **Feeds:** I-F-3 (`docs/imperative-features/3_specialist-agent-discovery.md`), I-F-4 (`docs/imperative-features/4_job-delegation-detection.md`)

---

## 1. Why this needs research

- Czar can pay for ERC-8183 jobs (escrow, Czar as evaluator, pay or refund on acceptance), but it has **no way to find who can do a job**.
- Phase 1 only allows a "named provider" (`system-architecture.md` §19 phase table). The acceptance test uses a Czar-run test agent (`phase-1-acceptance-scenario.md`).
- For x402 there is at least Circle's Discovery catalog. For agents that take ERC-8183 jobs, **we don't know of any directory on Arc.**
- Before designing anything, we need to know what exists, what Czar would have to build, and what's realistic for the hackathon.

**Scope note from Zaryab:** ranking job providers is **not** a priority. This is a niche market with few providers, some of them likely run by Czar. The goal is **finding and listing** providers, not scoring them.

## 2. What we already know (ground truth, 2026-10-18)

| Fact | Source |
|---|---|
| Circle's ERC-8183 instance on Arc testnet: proxy `0x0747…4583`, ~187k jobs created (`jobCounter` 186,931), 0 hooks ever whitelisted, one EOA admin | part 2 A4-07 – A4-09 |
| No official ERC-8183 instance on Arc mainnet; third-party ones exist (e.g. `0x8D0A…9Bb6`) | part 2 A4-12, A4-13 |
| ERC-8004 registries on Arc mainnet and testnet. The registration file has `name`, `description`, `services` (endpoints such as `A2A`, `MCP`, `web`), `x402Support`, `supportedTrust` | part 1 R1, part 2 A5-04 |
| ERC-8004 mainnet usage is thin and concentrated: 2,316 agents, 80.7% from two bulk registrants; feedback needs no permission | part 1 R3, part 2 A5-07 |
| Circle's Discovery API lists x402 HTTP resources only, not agents or job providers | part 1 D1 – D11 |
| Arc docs list indexers (Ponder, Goldsky, Envio, The Graph Studio) that could index job and registry events | part 2 A9-01 – A9-05 |

## 3. Research questions

### Q1. Does any job-provider or agent directory exist on Arc today?
- Does Circle or Arc run or announce an agent marketplace, directory, or "selection layer" covering ERC-8183 providers or ERC-8004 agents?
- Does any third party run one on Arc (explorers, ERC-8004 browsers, ACP-style marketplaces)?
- **Method:** Arc and Circle docs, changelogs and blog; Arc ecosystem pages; search for ERC-8004 explorers and ERC-8183 marketplaces; on-chain look at whether any contract reads or aggregates ERC-8004 data.

### Q2. Who are the providers in the existing ERC-8183 job data on Arc?
- On Circle's testnet instance (~187k jobs): how many distinct `provider` addresses? How many jobs did each complete, reject or expire? Are the jobs real work or test or bulk traffic?
- What do the `description` strings look like? Many may be `czar:<hash>`-style hashes, free text or URIs.
- Do provider addresses map to ERC-8004 agent IDs (`agentWallet` / owner)?
- The same questions for known third-party instances on Arc mainnet.
- **Method:** read `JobCreated`, `ProviderSet`, `JobSubmitted`, `JobCompleted`, `JobRejected`, `JobExpired` logs in pages of 10,000 blocks or fewer (A9-06); sample descriptions; cross-reference ERC-8004.

### Q3. Is ERC-8004 a usable lead source for job providers?
- What share of ERC-8004 agents on Arc testnet and mainnet are real versus bulk or spam?
- How many publish a registration file with reachable `services` endpoints? How many declare ERC-8183 or job capability in any way?
- Is there any convention for an agent to advertise "I accept ERC-8183 jobs", and at which instance?
- **Method:** read `Registered` / `URIUpdated` events, fetch a sample of registration files (as untrusted data), check the endpoints.

### Q4. What is the "selection layer" equivalent for job providers, and should Czar build it?
- What is the smallest useful index? Fields: provider address, ERC-8004 ID, what it does (capability card), deliverable format, price model, turnaround, which ERC-8183 instance it accepts, endpoint for the brief.
- Where should it live?
  - **(a)** off-chain in Czar's server (like CZ-18)
  - **(b)** a small on-chain directory contract on Arc
  - **(c)** no new store: ERC-8004 registrations plus a Czar allowlist
  - **(d)** a mix
- How do providers get in: self-registration, Czar curation, or both?
- **Method:** compare the options on build time, trust, openness to other buyers, and fit with the Selection Layer's evidence model (`docs/architecture/selection-layer-architecture.md`).

### Q5. What can we realistically build for the hackathon proof of concept?
Options to evaluate (cost, time, demo value):

| Option | What it is | Notes to verify |
|---|---|---|
| **P1. Curated list** | Czar-maintained JSON or table of 2–5 providers, mostly Czar-run agents | Fastest. Honest only if the demo says the agents are Czar-run. |
| **P2. ERC-8004-backed list** | Czar-run agents register in ERC-8004 with a registration file that declares job capability; Czar reads ERC-8004 plus an allowlist | Uses an existing standard. Is there a field for job capability, or do we extend `services`? |
| **P3. Minimal on-chain directory** | A tiny Arc contract: `register(capabilities, endpoint, jobEscrow)`, events only | Open to anyone; adds a contract to audit. |
| **P4. Job-history indexer** | Index ERC-8183 events to list providers that actually delivered | Real data, but Q2 may show testnet traffic is noise. |
| **P5. Open jobs** | Post a job with no provider and let agents claim it (`setProvider`); Phase 3 in the spec today | Needs agents watching for jobs; may not be possible on Circle's instance (check `setProvider` rules). |

Also: how many **Czar-run specialist agents** are needed for a convincing demo, and which job types (input from I-R-2)?

## 4. Expected output

- A short findings file under `docs/research/evidence/` graded like ground truth (CONFIRMED, STRONG SIGNAL, WEAK SIGNAL, GAP).
- A recommendation: **index design** (Q4) and **hackathon option** (Q5), with cost and time.
- Raw on-chain reads saved under `docs/research/evidence/experiments/`, with block numbers.

## 5. Open questions for Zaryab

- Is it acceptable for the hackathon demo to show only Czar-run specialist agents, if the demo says so clearly?
- Should Czar's job-provider index be open for other buyers to read, or Czar-internal?
