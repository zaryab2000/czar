# 01 Payment-path dependency map (Track A)

- **Target:** the smallest runnable path, end to end:
  - a person's objective → plan → owner approval → `EnvelopeOpened`
  - → reserve → x402 payment to a running `czar-search` → settle → finalize
  - → receipt and acceptance report → stored result → objective event
- **Rail:** vault-direct `x402-exact` only. Pockets (Gateway) and jobs follow in phase A2; pay requests and the evaluator in Track B.
- **Where it runs:** on local `arc-anvil` with the D92 stand-ins (SCR-130). The same code runs on testnet in M8 with the stand-ins swapped for the defaults.
- **Without K18:** the money path completes and every step is quarantined (D76). The objective ends `failed` with `result-quarantined` (SCR-132 §4). Nothing is faked.
- Owners follow SCR-136. Briefs are in this folder (`lane-1-briefs.md`, `lane-2-briefs.md`, `lane-3-and-5-briefs.md`).

## 1. Hop-by-hop chain

| # | Hop | Producer (owner) | Consumer (owner) | Status at `ce17dad` | Unblocked by |
|---|---|---|---|---|---|
| 0 | Objective stored, `objective.received` | `submitObjective` (Lane 2) | planner loop | IMPLEMENTED | — |
| 1 | Planner loop claims and plans | `processNextReceived` (Lane 2) | `plans`/`steps`, `plan.ready` | UNWIRED; no loop, no keys | TA-08 (SCR-132 §3) |
| 1a | Candidates and ranking | interim CZ-18 producer (Lane 3) | planner `ports.ranking`, `ports.directory` | GAP | TA-06 (SCR-131) |
| 1b | Other planner ports | `allowance` (vault `getLimits` via TA-10; error → `"0"`); `agentHosts` = `false` until `ingestReport` (Track B); `pocketKeys` = signer `createPocketKey`; `profiles` and `prober` exist | planner | MISSING-PRODUCER | TA-10, TA-08 |
| 2 | Owner approves, UserOp submitted | app (Lane 5) | `notifySubmitted` → objective `opening`, plan `approved` | IMPLEMENTED | — |
| 3 | `EnvelopeOpened` matched by `planHash` | indexer `GET /envelopes/by-plan-hash/{planHash}` (Lane 1) | opening watcher → `executing`, `envelope_ref`, `plan.approved` (Lane 2) | GAP | TA-07, TA-08 (SCR-132 §2) |
| 3a | Late match and "Approval sent" state | opening watcher (Lane 2) | approvals list (Lane 5) | GAP | TA-08, TA-16 |
| 4 | Dispatch steps under a lease | dispatcher (Lane 2) | `executeVaultDirectStep` | GAP | TA-09 (SCR-132 §3) |
| 5 | 402 from `czar-search` | composed merchant, `payTo` from the signer (Lane 3) | payer | UNWIRED + MISSING-PRODUCER (`payTo`) | TA-02, TA-05 (SCR-129, SCR-130) |
| 5a | Facilitator verify/settle on local chain | D92 stand-in (Lane 1) | merchant facilitator client | GAP | TA-04 (SCR-130) |
| 6 | Reserve, `usdc-3009`, `vault-call` signatures | signer K3 (Lane 1 service) via `createSignerClient` (Lane 2 caller) | payer | UNWIRED; local vault roles ≠ signer keys | TA-03 (SCR-136), TA-08 |
| 7 | Settle, finalize | payer and chain adapter (Lane 2) | vault | UNWIRED (`viem-chain.ts` untested) | TA-09 |
| 8 | Boundary and acceptance report | `runBoundary` (Lane 2) + checker (Lane 3) | `acceptance_reports` | UNWIRED; `AcceptancePorts` missing; `modelClient` required by code | TA-06 (ports), TA-08 (optional model) |
| 9 | Receipt `sl-receipt` | `createPaymentReceipt` (Lane 2) + signer check (Lane 1) | `evidence_receipts` | MISSING-PRODUCER; signer self-block | TA-01 (SCR-128), TA-09 |
| 10 | Close envelope, store result, objective event | completion (Lane 2) | `results`, `objectives.result_id`, `objective.delivered/failed` | GAP | TA-09 (SCR-132 §4) |
| 11 | App shows receipt | `listReceipts` (Lane 5) via indexer | person | IMPLEMENTED in code; local config missing | TA-08 (`CZAR_INDEXER_URL`, app read options) |

## 2. Missing producer → contract → consumer table

| Missing producer | Contract or decision needed | Consumer | Owner | Task / SCR | Unblocks |
|---|---|---|---|---|---|
| Started composition root (SCR-126 §2 order + planner loop, opening watcher, dispatcher, selection producer) | SCR-132 §6 (amends SCR-126 §2), §3 keys | the running server | Lane 2 | TA-08 → T-122 | hops 1–4, 8, 11 |
| `envelopeByPlanHash` route | SCR-132 §2 | opening watcher | Lane 1 | TA-07 | hop 3 |
| Vault limits reader | SCR-132 (allowance in TA-08) | planner `allowance` | Lane 1 | TA-10 | hop 1b |
| Dispatcher, completion, results, events | SCR-132 §3–§4 | objective lifecycle; app; later Track B consumers | Lane 2 | TA-09 → T-122 | hops 4, 7, 10 |
| Interim `RankingDecision` and directory | SCR-131 (list key, recrawl key, N1 vs `unknown_policy`, P-03 fallback text, tie-break) | planner | Lane 3 | TA-06 → T-123 | hop 1a |
| `AcceptancePorts` | SCR-122 (specified) + SCR-129 (K7) | acceptance checker | Lane 3 | TA-06 | hop 8 |
| Public K10/K7/K3 addresses | SCR-129 `keyAddress` | merchant `payTo` and seller proof; validator identity | Lane 1 | TA-02 | hops 5, 8 |
| Composed merchant | SCR-129, SCR-130; T-043 reopened, G0-04 moved (SCR-136) | payer | Lane 3 | TA-05 | hop 5 |
| Facilitator and Gateway stand-ins; local-only guard; stand-in safeFetch exception | SCR-130 | merchant, server, indexer | Lane 1 | TA-04 | hop 5a; phase A2 locally |
| Local vault roles equal signer keys | SCR-136 §2 (T-105 local mode) | deploy, signer | Lane 1 | TA-03 | hop 6 |
| `settlement.isSettled` (by `PaymentRef`), `receiptInput`, `PaymentRef` in the request | SCR-128 | `createPaymentReceipt` | Lane 2 | TA-09 | hop 9 |
| Signer settled check from indexer facts | SCR-128 | `sl-receipt` | Lane 1 | TA-01 | hop 9 |
| Model provider | G0-16/K18 (Zaryab) | boundary, P-03 | Lane 2 composes after approval | — | delivered (not quarantined) results |

## 3. Phase A2 (Lanes 1, 2, 5 completeness; still no I-F-6/I-F-7)

| Missing producer | Contract | Consumer | Owner | Task / SCR | Unblocks |
|---|---|---|---|---|---|
| Gateway balance, slow-withdrawal state, closed-pocket scope | SCR-127 §1–§3, §6 | signer K3/K4 policy; pullback; halt drain | Lane 1 | TA-20 → T-124 | write-off, `pocket-return`, retirement, pullback value |
| Halt drain inputs, late-funds recovery, write-off at or below the fee, slow value | SCR-127 §3–§5 | payer runtime | Lane 2 | TA-21 → T-053 | automatic drain on freeze; late funds; no dust deadlock |
| Manual-return encoder and indexer; persistence, reconciliation and hold; route and UI | SCR-133 | owner | Lanes 1, 2, 5 | TA-22a → TA-22b → TA-22c (T-125) | D41 owner credit |
| Device management | SCR-134 | owner | Lane 5 | TA-15 | `/settings/devices` |
| Wallet production config | SCR-135 | app | Lane 5 | TA-13 | no test defaults in production |

## 4. Waves
- **Wave 1 (each starts when its gate is Accepted):**
  - TA-01 (L1, SCR-128)
  - TA-02 (L1, SCR-129)
  - TA-03 (L1, SCR-136)
  - TA-04 (L1, SCR-130)
  - TA-06 (L3, SCR-131; the K7 port after TA-02)
  - TA-07 (L1, SCR-132)
  - TA-10 (L1, SCR-132)
  - TA-11 (L1, no gate)
  - TA-14 (L5, no gate)
  - TA-16 (L5, SCR-132)
- **Wave 2:**
  - TA-05 (L3; after TA-02, TA-04)
  - TA-08 (L2; after TA-02, TA-06, TA-07, TA-10)
- **Wave 3:**
  - TA-09 (L2; after TA-08, TA-01)
  - TA-12 (L2; after TA-08; SCR-136)
- **Phase A2:**
  - TA-20 (L1) → TA-21 (L2) → TA-22a (L1) → TA-22b (L2) → TA-22c (L5)
  - TA-13 and TA-15 (L5) when their SCRs are accepted
- **Load:** Lane 1 carries seven Wave-1 briefs. All are small and independent, and Lane 1 has review priority (`docs/builder-coordination.md`).
- **Validation after Wave 3:** T-050a (local thin slice) is the first deferred acceptance run. It needs Zaryab's local key creation (an operator step, T-105 local mode, G0-13).
