# 06 — Independent spec review (Gate 0, G0-01)

- **Date:** 2026-10-19
- **Verdict:** Go with fixes. M1 is blocked until the Critical findings and the M1-affecting High findings are closed.
- **Findings:** 5 Critical, 24 High, 26 Medium, 8 Low (63 total).

## Files

| File | What it is |
|---|---|
| `2026-10-19-spec-review.md` | The full review: verdict, findings table, each finding in detail, ground-truth and consistency samples, scope gaps, flags |
| `change-requests/` | One spec change request per Critical or High finding. **All 29 applied on 2026-10-19** (Accepted, or Accepted with changes where the file says why); Medium and Low findings applied in place |

## Change requests

| SCR | Finding | Severity | Milestone | Title |
|---|---|---|---|---|
| [`SCR-001`](change-requests/SCR-001-settle-never-finalizes.md) | RV-001 | Critical | M1, M3 | A reservation whose every index is settled can never become `Final`, so its envelope can never close. |
| [`SCR-002`](change-requests/SCR-002-step-cap-not-per-step.md) | RV-002 | Critical | M1, M3 | `stepCap` is checked per reservation or per job, not per step, so a hijacked agent key can spend a whole envelope on one step's payees. |
| [`SCR-003`](change-requests/SCR-003-pocket-address-unbound.md) | RV-003 | Critical | M1, M3, M4 | The agent key alone can register an EOA it controls as a pocket and move 25–50% of every open envelope there; the planner sets `pocketCapBps` 2500 even with no Gateway step. |
| [`SCR-004`](change-requests/SCR-004-pocket-funds-lost-on-close.md) | RV-004 | Critical | M1, M2, M4 | Pocket funds can be stranded for good: the pocket key is destroyed at `PocketClosed`, the slow-withdraw fallback cannot reach the vault, and leftover gas is never swept. |
| [`SCR-005`](change-requests/SCR-005-force-close-accounting.md) | RV-005 | Critical | M1 | `forceCloseEnvelope` accounting is undefined, and pocket/job calls that do not check the envelope state can then break INV-2 or lock funds. |
| [`SCR-006`](change-requests/SCR-006-freeze-gaps-fundjob-gas.md) | RV-006 | High | M1 | `fundJob` and `grantPocketGas` have no freeze or pause check in the function table. |
| [`SCR-007`](change-requests/SCR-007-freeze-does-not-stop-offvault.md) | RV-007 | High | M2, M4 | Freeze and guardian pause do not stop pocket nanopayments or evaluator payouts, yet the product and UI say freeze stops all spending. |
| [`SCR-008`](change-requests/SCR-008-inv9-autolimit-underflow.md) | RV-008 | High | M1 | Lowering `autoLimit` below `usedInPeriod` (which D60/D63 do on every freeze) breaks INV-9 and makes `openEnvelope` revert with an arithmetic panic. |
| [`SCR-009`](change-requests/SCR-009-syncjob-opened-and-refund.md) | RV-009 | High | M1, M4 | `syncJob` refuses `Opened` jobs, so an unfunded job blocks its envelope from closing; and its refund test cannot be checked on-chain. |
| [`SCR-010`](change-requests/SCR-010-record-manual-return-unbuildable.md) | RV-010 | High | M1, M4 | `recordManualReturn` cannot be built: it relies on a stored "last sync" balance that does not exist, and its caller is stated two ways. |
| [`SCR-011`](change-requests/SCR-011-free-balance-underflow.md) | RV-011 | High | M1 | `freeBalance()` can underflow, and a normal withdraw before a pullback or refund is confirmed breaks INV-2 until envelopes close. |
| [`SCR-012`](change-requests/SCR-012-pullback-fee-headroom.md) | RV-012 | High | Gate 0, M4 | The pullback asks to move the whole available balance, leaving nothing for Gateway's fee, so the drain likely fails. |
| [`SCR-013`](change-requests/SCR-013-sl-receipt-opaque-structhash.md) | RV-013 | High | M1, M2, M3 | `SL_RECEIPT` makes the vault sign any SelectionLayer-domain struct hash, and one agent signature validates for every vault. |
| [`SCR-014`](change-requests/SCR-014-oel-probe-recommit.md) | RV-014 | High | M1 | Re-committing a `PROBE_INTENT` root resets its status to 1, allowing a second reveal that swaps the probe batch after results are known. |
| [`SCR-015`](change-requests/SCR-015-factory-version-and-address.md) | RV-015 | High | M1, M6 | The factory's version register cannot work as described, its caller rules disagree, and predicted vault addresses change when untimelocked defaults change. |
| [`SCR-016`](change-requests/SCR-016-deploy-order-keys.md) | RV-016 | High | M1, M2 | The deployment order is circular: T-027 (M1) needs K3, K5 and K7 addresses that T-036 (M2) creates, and no task creates K6 or K20. |
| [`SCR-017`](change-requests/SCR-017-server-tx-gas-unfunded.md) | RV-017 | High | M2, M3 | Nothing funds gas for agent (K3), autonomy (K5) and evaluator (K7) transactions, which must come from those keys as `msg.sender`. |
| [`SCR-018`](change-requests/SCR-018-planner-stepresult-contradiction.md) | RV-018 | High | M3, M7, M8 | The specs contradict each other on whether the planner (P-03) receives merchant-derived `StepResult` text. |
| [`SCR-019`](change-requests/SCR-019-mcp-pay-spend-loop.md) | RV-019 | High | M1, M5, M8 | The MCP tools take URLs, amounts and free objects, and a coding agent can loop `pay` inside an open envelope with no further approval. |
| [`SCR-020`](change-requests/SCR-020-mcp-pay-api-shape.md) | RV-020 | High | M0, M5 | The MCP `pay` tool and the OpenAPI `createPayRequest` have incompatible request and response shapes. |
| [`SCR-021`](change-requests/SCR-021-pay-input-unredacted.md) | RV-021 | High | M5 | MCP `pay.input` sends arbitrary agent-supplied data to Czar's server and the merchant without redaction. |
| [`SCR-022`](change-requests/SCR-022-ssrf-server-fetches.md) | RV-022 | High | M3, M4, M5 | Only `czar-extract` blocks private addresses; planner probes, `createQuote` URLs and deliverable fetches have no SSRF guard. |
| [`SCR-023`](change-requests/SCR-023-screen-unavailable-rule.md) | RV-023 | High | M3 | The specs give opposite rules for what happens when the P-01 screen is unavailable. |
| [`SCR-024`](change-requests/SCR-024-deliverable-hash-mismatch.md) | RV-024 | High | M4 | T-055 rejects a job on a deliverable hash mismatch; the spec says `inconclusive`. |
| [`SCR-025`](change-requests/SCR-025-job-brief-undefined.md) | RV-025 | High | M0, M4 | The ERC-8183 job brief and `inputCommit` are never defined, so a real provider cannot learn the task and `descriptionHash` cannot be computed. |
| [`SCR-026`](change-requests/SCR-026-pseudonym-linked-to-vault.md) | RV-026 | High | M0, M4 | The public demand-proof leaf carries both the rotatable `userPseudonym` and the vault address, linking a user's soul-version history to all their payments. |
| [`SCR-027`](change-requests/SCR-027-objective-status-enum.md) | RV-027 | High | M0, M3, M5 | Objective status values differ between the CZ-12 state machine and the OpenAPI enum. |
| [`SCR-028`](change-requests/SCR-028-d70-not-applied.md) | RV-028 | High | Gate 0, M0, M2, M3, M4, M6 | D70 (everything runs locally on Zaryab's Mac with a local keystore) is only partly applied; hosting, keys, app origin and archive URLs still assume the cloud. |
| [`SCR-029`](change-requests/SCR-029-acceptance-scenario-numbers.md) | RV-029 | High | M4, M8 | The Phase 1 acceptance scenario cannot pass under the routing rules and vault invariants it is meant to test. |

### Later requests (not from G0-01)

| SCR | Source | Status | Milestone | Title |
|---|---|---|---|---|
| [`SCR-030`](change-requests/SCR-030-confirmed-demand-and-soul-v2-evidence.md) | D90 | Open, held for the Flow 7 review | M5, Flow 7 | Confirmed-demand objectives (`demandEvidence`, `czar-objective-v2`, demand-proof leaf v3) and versioned soul evidence (`czar-soul-v2`, soul leaf v2). |
| [`SCR-031`](change-requests/SCR-031-chat-export-formats.md) | D90 | Open (research) | stage 2 | Ground truth for ChatGPT and Claude export formats before any archive import. |
| [`SCR-032`](change-requests/SCR-032-embedding-model-and-gate.md) | D91 | Open, held (embeddings off until accepted) | M7 | Embedding model, its privacy impact, and the gate for turning embeddings on. |
| [`SCR-033`](change-requests/SCR-033-bazaar-coverage.md) | D91 | Open (research) | M4, M7 | How many real 402s declare `extensions.bazaar`. |
| [`SCR-139`](change-requests/SCR-139-interim-policy-input-reproducibility.md) | PR #66 final review | Draft, awaiting architect ruling | TA-06 | Persisted policy inputs needed to reproduce interim eligibility and exploration. |

## How to use

- Zaryab rules on each SCR (Accepted or Rejected) in its Decision section.
- An accepted SCR is applied to the named spec with a change-log line citing its ID. Per the build-plan template, applied SCRs may be moved to `docs/specs/05-build-plan/scr/`.
- Medium and Low findings have no SCR; they can be batched into one amendment pass.
