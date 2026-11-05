# SCR-180: The signer counts its own signatures the indexer has not seen yet

| Field | Value |
|---|---|
| ID | SCR-180 |
| Filed by | chief architect, 2026-11-05, from the PM-024 signer projection audit (findings F1 and F2) |
| Spec and section | CZ-27 signer policy: `gateway-nano` step and pocket caps; the expected-calls check |
| Status | Accepted by Zaryab's merge of the PR that adds this file |

## 1. The defect

- The signer decides whether a payment fits its caps by reading what has already been spent from the **indexer**:
  - `nanoSpent(pocket, payTo)` feeds the `gateway-nano` step cap and the pocket's funded amount (`apps/signer/src/policy.ts`, `gatewayNano`)
  - `envelope.usedCalls` feeds `expected-calls-used`
- The indexer lags. Gateway transfers arrive on a poll of about 30 seconds.
- So the signer can sign several payments inside one lag window, each checked against a total that does not yet include the others. Together they can **exceed the step cap**, or the expected call count.
- Real loss is bounded by the pocket's funded amount, which the chain enforces. But the step cap is the owner's approved limit for that step, and the signer is meant to hold it exactly.

## 2. The rule

- **Spent = what the indexer has seen + what this signer has signed that the indexer has not seen yet.**
- A signature counts as **pending** while all of these hold:
  - this signer issued it (its audit row has outcome `signed`)
  - its payment has not appeared in the indexer: for `gateway-nano`, no indexed transfer with the same EIP-3009 `nonce`
  - it can still be used: `now < validBefore`. Once `validBefore` passes, the authorization is dead on chain and stops counting.
- **The checks become:**
  - `gateway-nano`:
    - `indexed.step + pending.step + amount ≤ stepCap`
    - `indexed.pocket + pending.pocket + amount ≤ funded`
  - expected calls: `indexed.usedCalls + pending calls for that step < expectedCalls`
- **The audit row records what is needed to compute pending**, at sign time, in its existing columns:
  - `object_ids` carries `pocket`, `payTo`, `nonce`, `validBefore`, and the envelope and step
  - `amount_atomic` carries the amount
  - No new table and no migration.

## 3. Serialised per pocket

- Reading pending and recording the new signature must not interleave. Two concurrent requests for one pocket could otherwise each pass the check on the same total.
- The signer therefore serialises the read–check–record sequence **per pocket**. The audit row is written before the signature is returned.
- One signer process runs (SCR-170 §1), so an in-process per-pocket lock is enough. A Postgres advisory lock is also acceptable.
- **Fail closed:** if pending cannot be computed (audit read fails, indexer read fails), the request is refused with `backend-error` and nothing is signed.

## 4. Out of scope

- PM-024's F3, F4, F5 and F6 are not changed here. F4 is already safe, because the contract reverts on a stale root. F5 is by design. F3 and F6 delay a result rather than letting money exceed a limit.
- An indexer-lag limit (refusing when the indexer is too far behind) is **not** added. It would not fix this: the gap exists even with a healthy indexer, for the length of one poll.

## 5. Tests (the builder writes these first)

1. Three `gateway-nano` signatures inside one lag window, each within the step cap alone but over it together: the third is refused with `step-cap`. The same for the pocket's funded amount.
2. Once the indexer shows a transfer, its signature stops counting as pending and is not counted twice.
3. A signature whose `validBefore` has passed without settling stops counting.
4. Two concurrent requests for one pocket, each fitting alone but not together: exactly one signs.
5. The audit read failing refuses the request with `backend-error`.
6. All of these under both backends, local keystore and Cloud KMS.

## Affected tasks

- PM-024 (findings F1, F2); CZ-27.

## Decision

- Accepted by Zaryab's merge of the PR that adds this file.
