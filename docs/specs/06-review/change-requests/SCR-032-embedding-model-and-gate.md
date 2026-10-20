# SCR-032: Embedding model, its privacy impact, and the gate for turning embeddings on

| Field | Value |
|---|---|
| ID | SCR-032 |
| Filed by | Architect (Claude), 2026-10-20, from D91 item 3 |
| Spec and section | `docs/specs/04-components/server-acceptance-evidence-selection.md` CZ-18 §5.1 (C3), §5.3c, §5.6 `selection.retrievalMode`, `selection.embedding.*`; `docs/specs/01-system-architecture/system-architecture.md` §7.2 K18, §11.1; `docs/specs/04-components/cross-cutting.md` §6, §7 |
| Status | Open, **held**: embeddings stay off until this is accepted and the match-set gate passes. Phase 1 retrieval is tags plus BM25. |

## Problem
- D91 brings meaning-based retrieval forward in stages. The embedding step needs a model, a vendor and a privacy decision that the specs do not yet contain.
- The only embedding facts on file are OpenAI prices and dimensions (C1-01). There is no Anthropic embedding model. A hosted model would receive card text (seller data) and query text built from `TaskSpec` (redacted user data), which makes it a new data processor.

## Evidence
- Ground truth part 2 C1-01 (OpenAI only), C1-12 (`sqlite-vec`), C1-13 (`pgvector` 0.8.7, ≤ 2,000 indexable dims).
- CZ-18 §5.1: "BM25 + embeddings (≤ 1,024 dims, C1-13)" planned for Phase 2.

## Proposed change (after the research request in the D91 hand-off)
- Choose between a hosted model (vendor, model id, dims ≤ 1,024, price, data-retention terms, region) and a self-hosted open model on Czar's server (model id, licence, dims, CPU latency).
- Query side: embed only the code-built query (`TaskSpec` kind, topic, field names, tags), never the free `goal` text.
- Store vectors only for Czar cards, in `pgvector`, with the model id per vector; never for Circle text (D91 item 2).
- Gate: enable when, on the labelled match set (`selection.matchEval.minNeeds` needs), recall@10 rises by at least `selection.matchEval.minRecallGain` over tags+BM25 and precision@5 falls by no more than `selection.matchEval.maxPrecisionLoss`. Fusion by RRF as in SL-C3.
- Add the model to cross-cutting §7 pins and K18 notes.

## Affected tasks
- T-117 (embedding part only).

## Decision
- Pending.
