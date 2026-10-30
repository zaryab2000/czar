# SCR-158: Track A close-out review rulings (#166, #167)

| Field | Value |
|---|---|
| ID | SCR-158 |
| Filed by | chief architect, 2026-10-30, from the builder's close-out report (items 1–9) and the architect review of PR #166 and PR #167 |
| Spec and section | SCR-155 §2; SCR-157 §1–§3; CZ-15 §5.2; 02 §7.5; CZ-16 §5.5 decision cutoff; CZ-27 §5.5; SCR-125 RP ID; SCR-140 `AppWalletConfig` |
| Status | Accepted (Zaryab's delegation for Track A closure; recorded by his merge) |

## 1. Intermittent `BadTtl()` in `receipt-arc.test.ts` (builder item 1)
- **Analysis:**
  - The vault accepts a reservation only when `block.timestamp + MIN_RESERVATION_TTL (30) ≤ validBefore ≤ block.timestamp + MAX_RESERVATION_TTL (600)` (`ReservationLogic.sol:70`).
  - With `validBefore = latest.timestamp + payer.reservationTtlSeconds (600)`, the reserve fits whenever its mining block is less than 570 s after the latest block.
  - On a live chain this always holds: Arc targets 500 ms blocks, and nodes produce the next block after each one.
  - On an arc-anvil chain that mines only on demand, the "latest" block can be arbitrarily old, or moved by another test's time manipulation. That is the likely cause of the flake.
  - **Not** a defect in the SCR-155 §2 rule.
- **Ruling:**
  - The chain-time rule stands as built in #163 and #166. The server clock is not mixed in: `max(server, chain)` would overshoot `MAX_RESERVATION_TTL` whenever the server runs ahead.
  - **Every arc-anvil test suite that sends reserves runs with interval mining (`--block-time 1`)**, matching Arc's continuous block production. Suites that need exact time control keep using `evm_setNextBlockTimestamp` on top of it.
  - **Proof required before Track A closes:** the builder reproduces the flake on the current suite setup, then shows 10 consecutive full server-suite runs green with interval mining. Both results go in the PR body.
  - **M8 preflight item:** before the first testnet payment, check that the latest Arc block is less than 5 s old.

## 2. SCR-157 §1 wording (builder item 3)
- Amended: the vault finalizes only when `block.timestamp > validBefore` (`NotExpired` otherwise).
- The wait ends when the latest block's timestamp is **strictly greater than** `validBefore`, as #166 implements.

## 3. Resumed call after `validBefore` (builder item 4)
- Accepted as built in #166: the first re-send of a resumed call is allowed after `validBefore`.
- It carries the same `PAYMENT-SIGNATURE` and `payment-identifier`, so it can only fetch the seller's stored response for an authorization that already settled. It can't create a new payment, because USDC refuses the authorization once `block.timestamp ≥ validBefore`.
- Fresh retries stop at `validBefore` by chain time.

## 4. Job deadlines (the #166 scope, and builder item 5)
- **Accepted:** #166's move of the job expiry lead, the refund eligibility and `hasDecisionPending` to chain time follows the SCR-157 §1 rule ("every").
- **The CZ-16 evaluator decision cutoff** follows the same rule. The job path is off (`routing.jobEnabled = false`), so this is recorded as a **precondition for enabling the job path**, not a Track A item. It goes into the exit report under "before `routing.jobEnabled` is turned on", together with the missing arc-anvil job suite.

## 5. Signer metrics collection (builder item 6)
- **Phase 1:**
  - The counter stays in-process.
  - The text alert is the operator-facing signal.
  - **No new listener** on the key-holding process: no HTTP endpoint.
- Collection, with the counter exported to monitoring, arrives with stage 2 operations (Cloud KMS, D70).

## 6. Server RP ID (builder item 7)
- Phase 1 keeps the server's `rp_id = 'localhost'` check (SCR-125, migration `0007`), consistent with `webauthnRpId` = the host name of `app.origin` (`localhost`).
- A public origin needs its own SCR in stage 2. That SCR also makes the server derive the RP ID from `app.origin` and changes the CHECK.

## 7. Gas-low reason codes (builder item 8)
- Confirmed as named:
  - `below-min-after-refill`
  - `below-target-sum`
  - `key-unavailable`
  - `balance-read-failed`
  - `sign-failed`
  - `send-failed`
  - plus the log outcome `alert-failed`

## 8. The factory in `apps/server/src/app/reads.ts` (builder item 9)
- `reads.ts:588` reads `process.env.CZAR_VAULT_FACTORY_ADDRESS` with an empty fallback, outside `@czar/config`.
- **Ruling:** remove it. `reads.ts` takes the factory from the same deployment-manifest value the server already loads for `AppWalletConfig.vaultFactory`. The fix goes in #167.

## 9. The `openapi.yaml` commit in #167 (b7bbcc7)
- `CLAUDE.md` says tasks never edit `docs/specs/`. The architect's own instruction for #167 ordered the change, so the builder followed it.
- **Ruling:** the commit is adopted as the SCR-157 §3 spec edit. Its content matches SCR-157 §3: `vaultFactory` and `webauthnRpId`, both required.
- From now on, the architect makes spec edits in the SCR PR itself.

## Decision
- Architect rulings under Zaryab's delegation. Recorded by his merge.
