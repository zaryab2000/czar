# SCR-161: Track A final hard stops; SCR-160 timing and one correction

| Field | Value |
|---|---|
| ID | SCR-161 |
| Filed by | chief architect, 2026-10-30, from the builder's final Track A report (PRs #171, #172, #173, #157) |
| Spec and section | SCR-159 §2 and §4; SCR-160 §4, §5.2; `openapi.yaml` `AppWalletConfig` |
| Status | Accepted (Zaryab's delegation; recorded by his merge) |

## 1. `build-v1` after #170 (SCR-160)
- `@czar/schemas` is regenerated in this PR. The code moves to `Plan` 1.3 (planner literal, fixtures, and the web `alternativeReason` cases `unrated` and `health-blocked`) and to `RankingDecision` 1.2 (interim producer literal).
- **`StepResult` stays 1.0 until package 4A-2.** Every producer is in the payer files that 4A-2 changes. SCR-160 §4 is final; the architect applies the 1.1 schema edit in the same window as 4A-2.

## 2. Signer nonce reuse window (builder hard stop 1, accepts the proposed text)
- SCR-159 §2 "signer nonce assignment" gains two rules:
  - the "last assigned + 1" value counts only while it was assigned less than `payer.txWaitSeconds` ago; after that, the RPC pending count alone decides
  - a caller that signs and then neither broadcasts nor saves the transaction hands the nonce back (`abandonTransaction`, also available to socket callers)
- **Not a Track A gate:** without it, a stalled K3 recovers on signer restart. No money is at risk. It's listed as an M8 item, to build before the first testnet payment.

## 3. Reverted `closeEnvelope` (builder hard stop 2, accepts the proposed text)
- After a reverted `closeEnvelope`, CZ-15 re-reads the envelope. When it's still `Open` with no open reservations, pockets or jobs, it signs the close **once** more.
- **M8 item, not a Track A gate:** the envelope's money is not at risk, because the owner can `forceCloseEnvelope`.

## 4. `AppWalletConfig.userOpReceiptTimeoutSeconds` (builder hard stop 3)
- `openapi.yaml` adds `userOpReceiptTimeoutSeconds` (integer ≥ 1) to `AppWalletConfig` as an **optional** field. The server fills it from `app.userOpReceiptTimeoutSeconds`. The web uses it when present and the registry default otherwise.
- It's optional, so the current server stays valid. **M8 item:** fill it, and drop the web's registry import.

## 5. SCR-160 correction: the observation row is written at `auth.signed`
- **Gap** (builder "found, not fixed"): a merchant that settles on chain and returns no response leaves no `call.result`, so SCR-160 §5.2 would write no `observations` row, and H1 could never fire for the worst case.
- **Rule** (amends SCR-160 §5.2):
  - For `x402-exact` and `gateway-batched`, CZ-15 writes the `observations` row at `auth.signed`, with `responded_at = NULL` and `delivered = NULL`.
  - `call.result` fills `responded_at` and `delivered`.
  - When the call ends with no response after `payer.callRetries` and the index settles, `delivered` becomes `0`, and H1 fires at `markSettled`.
- Jobs are unchanged (the row is written at `JobOpened`).

## 6. Recorded, not Track A
- These go into the exit report's backlog, with the owner noted:
  - **Re-planning** (builder "found, not fixed"): the dispatcher never calls re-plan, so `unpaid` and `delivery-failed` steps don't re-plan. Track B (planner work).
  - Two pending approvals can reuse one EntryPoint nonce (the first stays "Still waiting"). M8.
  - Two approval timing headers aren't in `openapi.yaml`. M8 (architect).
  - `dependency-missing` fails the step before reserve instead of per call (CZ-15 §5.2 step 4). Track B. No money at risk.
  - Rows saved before #173 can't resume. Upgrade with no in-flight steps. Phase 1 has no production rows.

## Decision
- Architect rulings under Zaryab's delegation. Recorded by his merge.
