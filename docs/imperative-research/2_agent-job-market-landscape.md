# I-R-2. Which agent jobs are in demand today

- **ID:** I-R-2
- **Raised by:** Zaryab, while reviewing Planning (ERC-8183 jobs)
- **Date:** 2026-10-19
- **For:** the research agent first, then the project architect
- **Status:** open market research. Answers are needed before choosing demo jobs and before designing job detection (I-F-4).
- **Feeds:** I-F-4 (`docs/imperative-features/4_job-delegation-detection.md`), I-R-1 (which specialist agents Czar should run)

---

## 1. Why this needs research

- On Arc there may be few or no real ERC-8183 jobs (I-R-1, Q2). For the demo, Czar may need to run its own specialist agents and post realistic jobs.
- To make those jobs convincing, and to know which kinds of Sam's work are worth delegating, we need to know **what kinds of agent jobs people actually pay for today** across the agent-commerce landscape, not just on Arc.
- This is market research, not protocol research.

## 2. Research questions

### Q1. Which agent-job marketplaces exist, and how big are they?
- Which live systems let one party pay an agent for a task with escrow or acceptance? Candidates to check (none verified yet):
  - ERC-8183 instances on any chain
  - agent commerce protocols linked to ERC-8183's authors
  - agent service marketplaces in the wider web3 space
- For each: chain, volume (jobs and value), number of active providers, how a job is described, how acceptance works.
- **Method:** official docs and dashboards first; on-chain reads where possible; blogs only as signal. Grade each fact like ground truth.

### Q2. Which job types are most common and most paid for?
- Group real jobs into types. Candidate types to test, as hypotheses only:
  - research reports
  - data collection or enrichment
  - content and media generation
  - code review, audit or bug fixing
  - trading and DeFi tasks
  - translation
  - monitoring and alerts
- For each type: share of jobs, typical price, typical turnaround, how the deliverable is checked.
- Which types have **repeat buyers**? That's a sign of real demand, not one-off tests.

### Q3. Which job types fit Czar's users and Czar's acceptance model?
- Czar's users are knowledge workers using agents (Claude Code first). Which job types match work they leave unfinished? Map them to the soul sections Drives and Friction.
- Which types can Czar's evaluator check automatically (delivery, structure, some correctness) and which need human review?
- Which types are better as an **ERC-8183 job** than as a chain of x402 calls? Signals to look for: quality matters more than price, the work is multi-step, a deliverable must pass review, or the work takes long.

### Q4. What does the Arc job data show? (with I-R-1, Q2)
- From Circle's testnet instance (~187k jobs): if descriptions are readable, which types appear? Are any patterns worth copying for the demo?

## 3. Expected output

- A ranked list of **5–10 job types** with evidence of demand (volume, price, repeat use), each graded.
- For the top 3–5: a **demo job template** that Czar could run with its own specialist agent:
  - job brief shape
  - deliverable format
  - acceptance checks
  - realistic price and turnaround
- A short note on which job types Czar's observer could realistically detect from Sam's work (input to I-F-4).
- Findings under `docs/research/evidence/`, dated, with sources.

## 4. Rules

- Primary sources (docs, dashboards, on-chain data) for anything graded CONFIRMED. Market blogs are at most STRONG or WEAK SIGNAL.
- Don't invent volumes. "GAP: not found" is a valid answer.
