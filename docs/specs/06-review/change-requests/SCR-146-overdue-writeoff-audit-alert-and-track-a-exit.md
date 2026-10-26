# SCR-146: Audit digest and alert for the overdue write-off, and the Track A exit gate

| Field | Value |
|---|---|
| ID | SCR-146 |
| Filed by | chief architect, 2026-10-26, from Lane 1's SCR-145 implementation pause and the Lane Orchestrator's Track A closure questions |
| Spec and section | SCR-145 (audit, alert); CZ-27 §5.2, §8 audit rows (`server-autonomy-roi-keys.md`); D94; D92; SCR-136 |
| Status | Accepted (Zaryab's delegation for Track A integration rulings; recorded by his merge) |

## 1. Audit digest for transaction-signing requests
- **What is hashed:** the transaction the signer actually signs. Not the caller request `{vault, pocket}`. The signer rebuilds the calldata itself, so the transaction is the canonical object.
- **The preimage:** the unsigned EIP-1559 transaction the signer passes to `backend.signTransaction`, after the `prepared-transaction-mismatch` check. It contains `chainId`, `nonce`, `maxPriorityFeePerGas`, `maxFeePerGas`, `gas`, `to` (the vault), `value` (0), `data` (`writeOffPocket(pocket)` encoded by the signer) and `accessList`.
- **The hash:** `keccak256(serializeTransaction(tx))` with viem's `serializeTransaction` and `keccak256`. This is the EIP-1559 signing hash, so the signature itself binds the key.
  - Chain binding comes from `chainId`, vault binding from `to`, call binding from `data`.
  - The caller and key are already columns of the audit row (`actor_key_id`, `keyRef`).
  - There is no separate Czar hash rule; no `@czar/hashing` helper applies.
- **Scope:** populate `AuditRow.digest` with this value on the signed row of **every** transaction kind (`vault-call`, `relayer-tx`, `gas-refill`, `pocket-*`), not just this rule. Denied rows keep it absent unless a transaction was prepared.
- **The rule on signed rows:** a signed row for the SCR-145 exception carries `rule = "writeoff-manual-return-overdue"`. Normal write-offs and every other signed row leave `rule` absent, as today.

## 2. Alert `writeoff-overdue-stale-gateway`
- **Durable record:** the signed audit row from §1 (`rule = "writeoff-manual-return-overdue"`). It is written before the signed transaction is returned, so the event is never lost.
- **Delivery:** a signer-level alert port. Generalise the existing `alert(message)` callback used by gas refill (`apps/signer/src/gas-refill.ts:29`, `runtime-adapters.ts:64`) into one port on the signer service, and pass it to both paths. Local mode keeps `process.emitWarning`. No new infrastructure.
- **Trigger:** successful signing under the exception. The signer cannot see mining. Whether the write-off mined is CZ-15's row state (`expired` only after mining, SCR-145).
- **Fixed payload:** `writeoff-overdue-stale-gateway vault=<vault> pocket=<pocket> apiObservedAt=<RFC 3339 or none> digest=<§1 digest>`.
  - Addresses and the digest are public on-chain identifiers.
  - Nothing else: no amounts, no payloads, no error bodies.
- **Failure handling:** delivery is best-effort after the audit write. A delivery failure never blocks or reverses the signature and is not retried. It is recorded in the signer's own log as `signer_alert_delivery_failed` with the alert name only. The audit row stays the source of truth for ops.

## 3. Track A exit gate (applies D94 to Track A as a whole)
Track A is complete only when **all** of the following hold.

### 3.1 Code
- Every Track A task's PR is merged into `build-v1`. The one remaining item is Lane 1's SCR-145 signer rule with §1–§2 of this SCR.
- `routing.gatewayEnabled` and `routing.jobEnabled` stay `false`. Enabling them is not part of Track A.

### 3.2 Operator steps (Zaryab)
- Approve running the local acceptance listed in §3.3. This lifts D94's deferral for these local runs only.
- Create the local keys (T-105 local mode, G0-13).
- Neither step involves testnet, funds or live services.

### 3.3 Local acceptance runs (required)
Each run is on pinned `arc-anvil --network arc` with the D92 stand-ins, with commands and results recorded:

| # | Run | Covers | Owner |
|---|---|---|---|
| 1 | T-050a thin slice, every acceptance line in `phase-1-tasks.md` T-050a | TA-03 deploy with local keys, TA-04 stand-ins on a running chain, TA-05 stand-in round trip, TA-08/TA-09 process run | Lane 3 (exception) + Lane 2 review |
| 2 | `CZAR_LOCAL_CHAIN` signer suite | TA-01, and SCR-145 against real chain reads | Lane 1 |
| 3 | Gateway projection local-chain run: `pocket_balances` from the stand-in, closed-pocket quiet period and `pollEndedAt` | TA-20 | Lane 1 |
| 4 | Pocket path local-chain scenario: freeze/pause halt drain, late-funds recovery, slow-path resume (SCR-144 restart cases), manual-return record and overdue write-off | TA-21, TA-22a/b, SCR-145 | Lane 2 |
| 5 | Crash/restart matrix: kill and resume at `reserve.sent`, `call.sent`, before `settle`, between `/v1/transfer` and `gatewayMint`, and after an expired lease, with no double reserve, payment or mint | TA-09, TA-21 | Lane 2 |
| 6 | Manual-return UI against the local server (no passkey UserOp on testnet) | TA-22c | Lane 5 |

- Runs 4 and 5 drive the pocket executor directly. Gateway routing stays off.
- Model calls stay off (K18/G0-16 not approved). An objective ending `failed` with `result-quarantined` is a pass for T-050a.

### 3.4 Explicitly outside Track A (M8, D92)
- T-050b
- T-043 (c)
- G0-05 live Gateway behaviour
- the T-085 testnet check (TA-12)
- a real passkey UserOp on testnet (TA-22c)
- any live Circle or model call
- any real device

These do not block the Track A exit.

### 3.5 Report and sign-off
- **One report, `reports/track-a-exit.md`, compiled by the Lane Orchestrator.** It contains:
  - the `build-v1` SHA
  - the pinned `arc-anvil` version and checksum
  - for each Track A task: PR, merge SHA, every acceptance line marked `PASS` (command and result) or `M8 (D92)` with the §3.4 reason
  - links to `reports/m3-local-thin-slice.md` and the run logs
  - no keys, secrets or payloads
- **Senior verification:**
  - the designated senior reviewer (the final Codex reviewer Zaryab designates) checks the evidence against the runs
  - the architect checks it against the SCRs
- **Recorded acceptance:** Zaryab's merge of the report PR. That merge is the Track A exit and opens Track B.

## Affected tasks
- Lane 1: SCR-145 signer rule with §1 digest, §2 alert port, and run 3.3 #2–#3.
- Lane 2: runs 3.3 #4–#5. Lane 3: run 3.3 #1. Lane 5: run 3.3 #6.
- Lane Orchestrator: `reports/track-a-exit.md`.

## Decision
- Architect ruling under Zaryab's delegation. Recorded by his merge.
