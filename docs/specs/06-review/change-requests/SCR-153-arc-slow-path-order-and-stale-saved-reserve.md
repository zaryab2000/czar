# SCR-153: On Arc the slow path withdraws first and returns last; a saved reserve that reverted `BadTtl()` gets a new attempt

| Field | Value |
|---|---|
| ID | SCR-153 |
| Filed by | chief architect, 2026-10-28, from the builder's local-execution findings G3 (blocking) and G2 |
| Spec and section | SCR-144 §1 (resume table and completion rule); SCR-152 §1–§2; SCR-141 (slow-withdraw value); SCR-145 predicates 4–7; CZ-15 §5.2 step 2 and the crash table `reserve.sent` row (`server-planning-and-payment.md`); cross-cutting §5.2 `reserve-failed`; `ReservationLogic.sol` `BadTtl` / `MIN_RESERVATION_TTL` (`CzarConstants.sol:57`) |
| Status | Accepted (Zaryab's delegation for Track A closure; recorded by his merge) |

## 1. G3: slow-path order on Arc

### Problem
- On Arc the pocket EOA always holds its gas grant (`payer.pocketGasUnits`). It needs that gas to send `initiate`, `withdraw` and the return.
- SCR-152 §2 makes that grant returnable. So SCR-144 §1 row 3 (`withdrawingBalance = 0` and EOA USDC > 0 → `pocket-return`) fires **before** `initiate`:
  - the gas goes back to the vault
  - the row goes terminal with `initiate_tx = null`
  - the Gateway funds stay stranded until the SCR-145 write-off
- Observed on pinned arc-anvil v0.8.0-2 (local branch `wip/run4-scr152-restore`, 183d674):
  - a closed dust pocket stranded 8,000
  - three funded pockets while the Gateway API was down stranded 400,000 in total

### Ruling: withdraw first, return last (the builder's Option A)
- **Gateway clear** for a row means either:
  - its `withdraw_tx` receipt is mined with status 1, or
  - `withdrawingBalance = 0`, no `initiate_tx` is in flight, and the Gateway available figure is 0. This is the same read SCR-141 uses for V: fresh, or last good where SCR-141 allows it.
- **Resume table.** It replaces SCR-144 §1 rows 3–5. Rows 1–2 are unchanged. CZ-15 re-derives it from the chain on every pass:

  | On-chain reads (by CZ-15) | Action |
  |---|---|
  | `withdrawingBalance > 0`, block < `withdrawalBlock` | wait (unchanged) |
  | `withdrawingBalance > 0`, block ≥ `withdrawalBlock` | K4 `withdraw` (unchanged) |
  | `withdrawingBalance = 0`, not Gateway clear, `initiate_tx` absent, dropped or reverted | K4 `initiate`, with V by SCR-141. On an SCR-141 denial (`gateway-figure-missing`, `slow-withdraw-value-mismatch`, `pocket-spend-after-observation`), wait. The row stays `pending`. |
  | Gateway clear, `returnable > 0` (SCR-152 §1), no mined `return_tx` | K4 `pocket-return` with `value = returnable` |
  | Gateway clear, `return_tx` mined with `Transfer(pocket → vault)` and EOA empty | terminal (below) |
  | Gateway clear, `returnable ≤ 0`, no `return_tx` | terminal with `returned_amount = 0` (nothing to send) |

- **Return mined but the pocket isn't empty (G5, amendment 2026-10-28).**
  - "Empty" is always SCR-152's `returnable ≤ 0`, never USDC balance = 0. The gas dust left after a return is expected and counts as empty.
  - If a `return_tx` is mined and a fresh read still shows `returnable > 0`, new money reached the EOA after the return (a late mint or a transfer in).
  - CZ-15 sends nothing automatically. The row stays `pending`. Completion (d) fails, and so does SCR-145 predicate 5, so the money is never written off.
  - It stays visible to the operator as a pending row past `payer.manualReturnHoldHours`.
  - Phase 1 has no automatic second return: a row stores one `return_tx`. A multi-return design is stage 2.
- **Never `pocket-return` while the row isn't Gateway clear.** A K4 `pocket-return` request for a row that isn't Gateway clear is a CZ-15 bug. The test below asserts that it never happens.
- **Completion rule.** It replaces SCR-144 §1 and SCR-152 §2. A row is terminal only when all of these hold:
  - (a) Gateway clear
  - (b) `withdrawingBalance = 0` on a fresh read
  - (c) either the `return_tx` receipt holds `Transfer(pocket → vault)`, with its block, log index and value stored, or `returnable ≤ 0` and no return was sent
  - (d) the EOA is empty (SCR-152 §2)
- **Terminal states:** unchanged from SCR-144. A closed-pocket row goes to `returned-to-vault`. A funded-pocket row goes to `manual-return-required` when a return was sent, and to `returned-to-vault` with `returned_amount = 0` when nothing was left to send.
- **No new config key.** The order keeps the gas grant in the EOA until the last transaction, so no gas reserve figure is needed. The builder's Option B is rejected: it needs a new key and a gas estimate per remaining step.

### The builder's three questions
1. **SCR-145 predicates 4–7: no change.**
   - Predicate 6 already requires audited `pocket-slow-withdraw` and `pocket-return` K4 rows. Under this order they occur withdraw first, return last.
   - Predicate 5 is "empty" per SCR-152.
   - A row stuck in `pending` behind an SCR-141 denial is still covered by the overdue write-off after `payer.manualReturnHoldHours`.
2. **Rows that are already wrong: no migration and no reopen rule.**
   - No such row exists outside local tests: Track A has not run on testnet (D92, M8).
   - Each local session gets a fresh schema (SCR-151), so old local rows never carry over.
   - The new completion rule stops new ones.
3. **Owner: the builder.**
   - Test first, as a build-v1 PR stacked on #137. It changes CZ-15 code, which is Lane 2's files.
   - Acceptance tests, on pinned arc-anvil `--network arc` with the real signer and preparer:
     - The closed dust pocket and the three API-down funded pockets end with Gateway available + withdrawing = 0, the funds in the vault (directly, or as a manual-return credit), and the EOA empty.
     - No K4 `pocket-return` audit row precedes a mined `withdraw_tx` for a row whose Gateway figure was > 0.
     - A crash and restart at each point (after `initiate_tx` is recorded, after it is mined, after `withdraw_tx` is recorded, after it is mined, after `return_tx` is recorded) resumes in this order and sends nothing twice.

## 2. G2: a saved reserve that reverted `BadTtl()`

### Problem
- After a crash, the CZ-15 crash table's `reserve.sent` row re-sends the saved signed `reserve`.
- If that transaction was mined after `validBefore − MIN_RESERVATION_TTL`, the vault reverted it with `BadTtl()`:
  - no reservation exists
  - the sender's account nonce is spent, so re-sending the same signed transaction can never succeed
  - the step is stuck

### Ruling: a new attempt with a fresh reserve (the builder's option b)
- **Trigger:** the saved `reserve.sent` transaction has a receipt with status 0, and the saved `validBefore < block.timestamp + MIN_RESERVATION_TTL` for the block that mined it. That is exactly the vault's `BadTtl()` condition.
  - Decide by this condition, using only the receipt and that block's header.
  - Don't decode the revert with `eth_call` and block overrides: the Arc testnet RPC may not support them.
  - A status-0 receipt where the condition doesn't hold is any other revert (below).
- **Action:**
  - CZ-15 writes `reserve.mined` for the old attempt with `BadTtl` as the outcome. This uses the existing phase; no new phase.
  - It then starts the step again from §5.2 step 1 (pre-check) as `attempt + 1` in `step_executions`, with a fresh `validBefore` computed by the step-2 formula and the nonces derived for the new reservation.
- **Why this is safe:**
  - The old reservation never existed on chain.
  - No `PaymentPayload` was signed against it: `auth.signed` comes after `reserve.mined`.
  - Nothing can double-reserve or double-pay.
- **Bound: no counter, no new key.**
  - The new attempt's reserve is sent live, so it can only hit `BadTtl()` again through another crash that outlasts the window.
  - If the step-2 formula can't produce a `validBefore ≥ now + MIN_RESERVATION_TTL`, because `envelope.expiresAt` is too close, the step ends `failed` with `StepError {code: "reserve-failed", message: "BadTtl", retryable: false}` (02 §4.16; cross-cutting §5.2). `StepError` has no `detail` field: the decoded error name goes in `message`, which never holds user text. The envelope then closes by the normal path.
- **Any other revert** of a saved reserve follows the existing `reserve-failed` path. This SCR doesn't change it.
- **Tests (run 5):**
  - Advance time past the window with `evm_increaseTime` or `anvil_setNextBlockTimestamp` before the resume.
  - The step makes exactly one new attempt with a new `reservationId`, pays once, and finalizes.
  - A second case with `envelope.expiresAt` inside the window ends `reserve-failed` with `message = "BadTtl"`, no reservation and no payment.
- **Owner:** the builder, in the same stacked PR as §1 or a separate build-v1 PR.

## 3. Signer block reads (G5 follow-up)
- The signer's on-chain reads (`postgres-projection.ts`, the block-number reads used for the withdraw and return predicates) must bypass viem's block cache (`getBlockNumber({ cacheTime: 0 })`), the same fix as `gateway-balances.ts` (#122) and the CZ-15 slow-path reader (#146).
- A cached block number can deny `withdraw` right after `withdrawalBlock`.
- Owner: the builder, as a small signer PR with a test that reads a block mined after the cached one.

## 4. Merge order (no ruling needed)
- #137 still sends `keyId: "K4:${pocket}"`. The signer accepts only `"K4"`, which #133 fixes.
- Order:
  1. Zaryab merges #133.
  2. The builder merges build-v1 into #137 and resolves `pullback.ts` to `"K4"`.
  3. Zaryab merges #137.
  4. Then the PR carrying §1 and §2 of this SCR.

## Decision
- Architect ruling under Zaryab's delegation for Track A closure. Recorded by his merge.
