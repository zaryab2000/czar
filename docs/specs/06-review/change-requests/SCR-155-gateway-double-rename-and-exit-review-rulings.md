# SCR-155: Gateway doubles' initializer rename; rulings on the Track A exit-report items; local testing ends

| Field | Value |
|---|---|
| ID | SCR-155 |
| Filed by | chief architect, 2026-10-30, from the builder's draft SCR-155 (PR #155) and the exit report's architect items (PR #157) |
| Spec and section | SCR-150 §1 step 3; SCR-153 §2; CZ-15 §5.2 step 2 (`validBefore`); signer gas refill (CZ-27 / SCR-152) |
| Status | Accepted (Zaryab's delegation for Track A closure; recorded by his merge) |

## 1. Rename `testInitialize` to `initializeDouble`
- Forge collects any function whose name starts with `test`. It deploys `MockGatewayMinter`, which has a no-argument constructor, and fuzzes `testInitialize(address)`, which fails on the zero address.
- **Ruling:** SCR-150 §1 step 3's one-time initializer on both doubles is named `initializeDouble(address)`. Behaviour is unchanged. PR #155 implements it.
- The other test controls keep their names (`testBurn`, `testSetWithdrawalDelay`, `testMarkTransferSpecHashUsed`). They pass under fuzzing, and they are test-only and never deployed outside CLEAN mode.

## 2. Stale-reserve attempt: bound it and use chain time
- **Problem:** SCR-153 §2 assumed a live reserve can only hit `BadTtl()` after a crash. That fails when the chain's clock runs ahead of the server's by more than the TTL margin: every new attempt reverts by the same condition, with no limit.
- **Ruling:**
  - "now" in CZ-15 §5.2 step 2 (`validBefore = min(now + …, envelope.expiresAt)`) and in the SCR-153 trigger is the **latest block timestamp** from a fresh read. It is never the server clock.
  - **At most one new attempt per step for `BadTtl`.** If the attempt made under SCR-153 §2 also reverts with the trigger condition true, the step ends `failed`. It uses `StepError {code: "reserve-failed", message: "BadTtl", retryable: false}`.
  - No config key: the bound is structural, one attempt.
- **Mislabelled revert:** when the timing condition holds, a status-0 receipt is treated as `BadTtl` even if an earlier vault check reverted first.
  - Accepted: the cost is at most the one bounded new attempt above.
  - That attempt reverts again for the real cause and ends the step `reserve-failed`.
- Tests:
  - a chain clock 400 s ahead of the server gives exactly one new attempt, using chain time, and it succeeds
  - a forced second revert ends the step `reserve-failed` with no third attempt

## 3. Signer gas refill
- **First pass at start:** the signer runs one gas-refill pass when it starts, then on its existing interval. This replaces the 5-minute wait before the first refill, which made run 1's first payment attempt expire.
- **One key's failure never skips the others:** the refill pass evaluates each key on its own. A balance-read or send fault on one key is logged under the allowlist (key id and outcome only), and the pass continues with the rest.
- No new config key.
- Tests:
  - a fresh signer refills a key with no gas within one pass of starting
  - an injected fault on the first key still refills the second

## 4. Dust units off Arc
- Accepted as is for Phase 1: Czar runs only on Arc, where gas is USDC. SCR-152's "empty" is defined there.
- Before any non-Arc network is enabled, a new SCR must define dust in that chain's native units. Recorded as an M8 / stage-2 item, not a Track A blocker.

## Owner and exit impact
- The builder owns §2 and §3, as build-v1 PRs, tests first.
- §1 is PR #155.
- The six SCR-146 runs need no re-run for §1 and §4.
- §2 and §3 are proven by their automated tests (unit tests plus the arc-anvil test suites). No manual local re-runs (§5).

## 5. Exit gate change: local chain testing ends (Zaryab, 2026-10-30)
- **Decision:** Zaryab ends manual testing on local chains (FORK and CLEAN).
  - From now on, every manual test runs on Arc testnet (`eip155:5042002`).
  - Each testnet step that needs funds, a sign-up or a real device still needs his explicit approval (CLAUDE.md).
- **Amends SCR-146 §3 (Track A exit gate):**
  - The FORK browser flow is removed from the gate. The real-passkey owner flow moves to the first Arc testnet run (M8, D92), and the exit report lists it as an M8 item.
  - The six CLEAN runs already recorded in the exit report (runs 1–6 on merged `build-v1` and `local-v1`) stand as the run evidence. No new local runs are required.
  - The gate is now:
    1. the code items in §2 and §3 of this SCR merged, each with its tests passing
    2. #155 merged
    3. the exit report (`reports/track-a-exit.md`) updated to this gate
    4. senior reviewer
    5. architect check
    6. Zaryab's merge
- **`local-v1`:** frozen. No new local-only PRs. `build-v1` no longer syncs into it. The branch is kept as history.
- **Arc-anvil in automated tests:** unchanged. Contract and chain tests still run on pinned `arc-anvil --network arc` (CLAUDE.md). This decision ends manual local-stack testing, not automated tests.

## Decision
- Architect rulings under Zaryab's delegation. Recorded by his merge.
