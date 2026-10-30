# SCR-159: Track A independent review: resume skips the pre-check, safe re-send, partial steps, owner operations wait for inclusion

| Field | Value |
|---|---|
| ID | SCR-159 |
| Filed by | chief architect, 2026-10-30, from the independent money-path review of `build-v1` with #166 and #167 (findings verified by the architect against the code) |
| Spec and section | CZ-15 §5.2 steps 1–8 and the crash table (`server-planning-and-payment.md:337-370`); cross-cutting §5.2 `StepError` codes; CZ-22 onboarding (FAC-1); SCR-153 §2; SCR-157 §3 |
| Status | Accepted (Zaryab's delegation for Track A closure; recorded by his merge) |

## 1. A resumed step never re-runs the pre-check (critical)
- **Defect:**
  - `executeStep` (`apps/server/src/payer/vault-direct.ts:285`) always runs `precheckCalls`, which sends a fresh unpaid probe to the merchant, before it reads the saved trace.
  - On a resume after `reserve.sent` or `reserve.mined` (a crash, a lease loss, or the normal `pending` return while a receipt waits for the indexer), a merchant 5xx, a price change or a new payee calls `markStepFailed`.
  - The reservation is then never settled or finalized. `openReservations > 0` keeps the objective open forever, and reserved USDC stays committed.
- **Rule:**
  - The pre-check (CZ-15 §5.2 step 1) runs only for an attempt with no `reserve.sent` row.
  - An attempt that has one resumes from its last saved phase, as the crash table says, and always reaches `finalize`.
- **Tests:**
  - After `reserve.mined`, a merchant 5xx on the probe doesn't fail the step. The step resumes, and the reservation is finalized.
  - The same holds after `auth.signed`, and on the `pending` return.

## 2. Saved transactions: re-send only while they can still land; any revert ends the step (critical)
- **Defects:**
  - **Non-BadTtl revert:** when the saved `reserve` reverted for a reason other than `BadTtl` (`Paused`, `FrozenVault`, `CapExceeded`, …), the code re-broadcasts the same bytes. The node rejects them because the nonce is spent, and the step retries forever (`vault-direct.ts:557-584`, `submitReserveOrStale`).
  - **Never landed:** when a broadcast never landed and the sender's next transaction took the same nonce, the saved bytes can never land and the step is wedged.
- **Rules (CZ-15 crash table, `reserve.sent` row, made precise):**
  1. **Receipt with status 0, `BadTtl` condition true:** SCR-153 §2, unchanged.
  2. **Receipt with status 0, `BadTtl` condition false:**
     - Write `reserve.mined` with outcome `reverted`, and end the step `failed` with `StepError {code: "reserve-failed", message: "reverted", retryable: false}`. No reservation exists and nothing was signed against it.
     - The envelope continues by the normal path: re-plan or close.
  3. **No receipt, and the sender's account nonce (`getTransactionCount(sender, "latest")`) ≤ the saved transaction's nonce:** re-broadcast the same bytes. They can still land.
  4. **No receipt, and the account nonce > the saved nonce:** the bytes can never land.
     - Sign a new transaction with the **same arguments**. `validBefore` is recomputed by the SCR-155 §2 / SCR-157 §1 rules when the old one no longer clears `MIN_RESERVATION_TTL`.
     - Record a new `reserve.sent`.
     - Since the old transaction can never be mined, no duplicate reservation can exist.
- **Same rule for every saved transaction CZ-15 re-sends:** pocket register, gas and fund (`pocket.ts`), `settle`, `finalize`, `closeEnvelope` (`completion.ts`). Each one follows rules 2–4 with its own failure code. Settle and finalize keep their existing error codes.
- **Signer nonce assignment:** the signer assigns nonces per key under an in-process lock: `nonce = max(pending count from the RPC, last nonce it assigned to that key + 1)`. Two concurrent requests for one key (the dispatcher and the freeze handler's `lowerAutoLimit`, both K3) never get the same nonce.
- **Tests:**
  - A reserve that reverted `Paused` ends `reserve-failed` with no retry loop.
  - A saved reserve whose nonce another K3 transaction took is re-signed once and lands.
  - Two concurrent K3 sign requests get consecutive nonces.
  - The same two transaction cases for `finalize` and `closeEnvelope`.

## 3. A step with some paid calls is done with those results (major)
- **Defect:**
  - When any index of a reservation is unpaid, `vault-direct.ts:893` ends the whole step `failed` (`unpaid-index`).
  - Paid indices keep only `step.result.prepared`, so their results are never delivered, although the owner paid for them.
- **Rule:**
  - After `finalize`, a step with at least one paid and accepted call ends **`done`** with the results of those calls.
  - Each unpaid index is recorded per call as `unpaid`, beside the existing per-call `dependency-missing`.
  - A step with **zero** paid calls ends `failed` with `unpaid` (cross-cutting §5.2, re-plan).
  - A call whose merchant settled and then returned no usable body is recorded per call as `delivery-failed`, with its settlement evidence (receipt row) kept.
- **Tests:**
  - 3 calls with one merchant 5xx: the step is `done` with 2 results, and the objective delivers.
  - 3 calls all 5xx: the step is `failed` / `unpaid`.

## 4. Owner operations wait for inclusion before the next one (major)
- **Defect:**
  - `sendOwnerUserOperation` (`apps/web/packages/wallet.ts`) returns once a bundler **accepts** the UserOperation.
  - `setUpVault` (`vault-setup.ts`) then builds `setPasskey` with the same EntryPoint nonce while `createVault` is pending. The bundler rejects it as a replacement ("The network is busy" after a successful create), or a fallback bundler lands it first against an address with no code.
- **Rule:**
  - `sendOwnerUserOperation` gains an option `waitForInclusion`. When set, it waits for the UserOperation receipt (`waitForUserOperationReceipt` on the bundler that accepted it), bounded by the config key `app.userOpReceiptTimeoutSeconds` (default 120, reason "Arc finality is sub-second; covers bundler queueing"), and fails clearly when the receipt shows a revert.
  - `setUpVault` uses it for `createVault` before sending `setPasskey`.
  - Any other owner flow that sends two UserOperations in a row uses it too.
- **Tests:**
  - `setPasskey` is never sent before the `createVault` receipt exists.
  - A reverted `createVault` receipt surfaces as an error, not as "network is busy".

## 5. Recorded, not Track A
- **Before `routing.gatewayEnabled` is turned on**, added to that list in the exit report:
  - nothing in production drains or closes a funded pocket after its Gateway steps (`executePullback` and `closePocket` are never called)
  - `prepareDelegate` reads its trace at step index 0 (`pocket.ts:440`)
  - the exact-match `pocket-return` value check can keep refusing when `maxFeePerGas` moves between the server's and the signer's preparation
- **Throughput:** `waitForAuthorization` and `waitUntilValidBefore` block the single dispatcher for up to `validBefore + payer.reconcileGraceSeconds`. This is acceptable for one owner in Phase 1 and recorded for stage 2.

## Owner and exit impact
- **Owner:** the builder, test first, as build-v1 PRs:
  - §1 + §2 (server and signer)
  - §3 (server)
  - §4 (web)
- **Exit gate:** these PRs join the SCR-155 §5 gate list. After they merge, the six recorded runs stand. The fixes are proven by their automated tests, which include runs 4 and 5 on arc-anvil.

## Decision
- Architect rulings under Zaryab's delegation. Recorded by his merge.
