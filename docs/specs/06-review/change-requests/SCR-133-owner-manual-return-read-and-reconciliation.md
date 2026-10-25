# SCR-133: Owner manual return — app read, owner UserOp, and completion reconciliation

| Field | Value |
|---|---|
| ID | SCR-133 |
| Filed by | chief architect, 2026-10-25 (Track A replan, baseline `ce17dad`) |
| Spec and section | `docs/specs/02-data-and-protocol/data-and-protocol.md` §9.2 app table; `docs/specs/02-data-and-protocol/api/openapi.yaml`; `docs/specs/04-components/app/app-and-notifications.md` CZ-22 §4 (`:41`), §5.1 (`:59`), §12; `docs/specs/04-components/server/server-acceptance-evidence-selection.md` CZ-19 §5.4; `docs/specs/04-components/server/server-planning-and-payment.md` CZ-15 (`:380`); `packages/vault-client` |
| Status | Accepted (Zaryab, 2026-10-25); Applied (2026-10-25) |

## Problem
- CZ-15 says "the app asks the owner to `recordManualReturn` (D41)" (`server-planning-and-payment.md:380`), and CZ-27 says "the owner then credits it" (`server-autonomy-roi-keys.md:443`).
- No route, schema, screen or wording exists for it. CZ-22 §4's owner UserOp list omits `recordManualReturn` (`app-and-notifications.md:41`), and `openapi.yaml` has no manual-return operation.
- Lane 2 persists only `state = manual-return-required` (`apps/server/migrations/0009-payer-pullback-api-failures.sql:8`). The returned amount and transaction live only in `step_executions` payloads (`apps/server/src/payer/pullback.ts:265-300`).
- Nothing reconciles `ManualReturnRecorded`:
  - The indexer stores the event name and refreshes the pocket mirror (`apps/indexer/src/handlers.ts:545-549`). It does not store `credit`.
  - `rg ManualReturn apps/server/src` finds nothing.
- `@czar/vault-client` has no `encodeRecordManualReturn` (`packages/vault-client/src/encoders.ts`), so the app cannot encode the call under the "vault calls only through `@czar/vault-client`" rule.

## Evidence
- Verification report DE §1; the file:line references above. Contract facts: `recordManualReturn` is owner-only and credits `min(amount, outstanding − pendingPullback, freeBalance())`. It requires the pocket to be `Funded`/`Draining` and the envelope `Open`, and it emits `ManualReturnRecorded(pocket, credit)` (`contracts/src/vault/logic/PocketLogic.sol:236-261`).

## Proposed change
- **Owner path:** a direct MSCA UserOp from the app (the freeze/limits pattern, CZ-22 §4). Not the D30 `executeOwnerAction` fallback (code 10), which stays reserved for an AR-2 failure. K3/K4 never sign it (unchanged).
- **`@czar/vault-client`:** add `encodeRecordManualReturn(pocket, amount)`.
- **Server persistence (Lane 2 migration):**
  - Widen the `payer_pullback_gateway_failures.state` CHECK to `pending | manual-return-required | recorded | expired`.
  - Add `returned_amount numeric(78,0)`, `return_tx text`, `return_block bigint`, `return_log_index integer`, `recorded_credit numeric(78,0)`, `recorded_tx text`, `recorded_at timestamptz`.
  - When the slow path reaches `manual-return-required`, the existing `pocket-return` result fills `returned_amount` and `return_tx`.
- **CZ-19 §5.4 query:** `manualReturnsForVault(vault)`, consumed by CZ-15. It returns `ManualReturnRecorded` events of the vault's pockets as `{pocket, credit, txHash, block}`. The indexer stores `pocket` and `credit` from the event, replacing today's name-only row.
- **Reconciliation (CZ-15):** every `payer.gatewayRecoveryPollSeconds` (SCR-127), for each `manual-return-required` row:
  - A matching `ManualReturnRecorded` for the pocket ordered after `return_tx` by `(block, logIndex)` → `recorded`, with the credit and transaction stored.
  - The pocket became `Closed` first → `expired`. The contract can no longer credit it, and the USDC already sits in the vault as free balance.
- **Write-off hold, with an end:**
  - CZ-15 holds `writeOffPocket` for a pocket whose row is `manual-return-required`, for at most `payer.manualReturnHoldHours` (new key, default 72; reason: gives the owner three days to record the return before the envelope's committed room is released).
  - There is no automatic Phase 1 path that closes a held pocket. `closeEnvelope` reverts while pockets are open (`contracts/src/vault/logic/EnvelopeLogic.sol:96-98`), and owner `forceCloseEnvelope` (`:106-136`) is a later-phase screen (CZ-22 `:59`).
  - After the hold, CZ-15 writes the pocket off as usual. The returned USDC is already in the vault (`pocket-return`), so no money is lost; it is booked as `spent` rather than credited back. The row becomes `expired`, with the expired wording below.
- **App read route (02 §9.2, OpenAPI, AppSession):**
  - `GET /v1/pockets/manual-returns`, operation `listManualReturns`.
  - Returns `{items: [{envelopeRef, vault, pocket, returnedAmount: Amount6, returnTx: Hash32, state: "manual-return-required" | "recorded" | "expired", recordedCredit?: Amount6, recordedTx?: Hash32}]}`.
  - Scoped to the session user through `plan_id → plans → objectives → users`.
  - The shape is the OpenAPI component `ManualReturn` (like `FreezeIntent`), object `x-privacyClass: public`; payments are public on-chain (p1-G10).
  - No submit route: the app encodes the call itself through `@czar/vault-client`, as onboarding limits already do (`apps/web/app/onboarding/limits/page.tsx:46-50`). The contract bounds the credit, so a client-side amount cannot over-credit.
- **CZ-22:**
  - §4: add `ICzarVault.recordManualReturn(pocket, amount)` to the owner UserOp list.
  - §5.1: the Envelope detail screen shows a "Money to record" section when the envelope has `manual-return-required` items. Home shows a one-line notice with the count.
  - §12 wording:
    - Section title: "Money to record"
    - Row: "{returnedAmount} came back from a pocket wallet by the slow 7-day route. Record it so your vault's books match."
    - Button: "Record {returnedAmount}"
    - After: "Recorded {recordedCredit}"
    - Expired: "This pocket closed before the return was recorded. The money is already in your vault."
    - Home notice: "{count} pocket returns to record"
  - The amount submitted is `returnedAmount`. The UI shows `recordedCredit` from the event, which may be lower (contract bound).

## Affected tasks
- T-053 (Lane 2), T-086 (Lane 5), T-026 (vault-client), T-032 (indexer).
- Builder briefs TA-22a/b/c (task T-125) in the Track A plan. Depends on SCR-127 (the slow path must be reachable first).

## Decision
- Accepted by Zaryab on 2026-10-25 with the Track A replan (context and briefs in `docs/builder-prompts/track-a/`).

## Applied
- CZ-15 manual-return bullet
- CZ-19 `manual_returns` table and `manualReturnsForVault`
- CZ-22 §4 UserOp list, §5.1 Envelopes row, §12 wording
- 02 §9.2 row and `api/openapi.yaml` `listManualReturns` with the `ManualReturn` component (an OpenAPI component like `FreezeIntent`, not a new file under `schemas/`)
- `@czar/config`: `payer.manualReturnHoldHours`
- Task T-125
