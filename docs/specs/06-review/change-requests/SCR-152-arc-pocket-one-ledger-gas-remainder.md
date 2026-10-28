# SCR-152: The pocket's USDC and its gas are one balance on Arc; returnable amount and "empty"

| Field | Value |
|---|---|
| ID | SCR-152 |
| Filed by | chief architect, 2026-10-28, from finding G1 of the local execution report (runs 2 and 4) |
| Spec and section | SCR-144 §1 (resume table, completion rule); SCR-145 predicate 5; CZ-27 §5.2 `pocket-return`, §5.3 retirement rule (`server-autonomy-roi-keys.md:442`); CZ-15 slow path; `apps/server/src/payer/pullback.ts:268-271,431-468`; `apps/signer/src/policy.ts` `pocketReturn`; `security-and-testing.md:76` |
| Status | Accepted (Zaryab's delegation for Track A closure; recorded by his merge) |

## Problem
- On Arc, gas is paid in USDC: the native balance and the USDC ERC-20 balance are one ledger (A1-05; `security-and-testing.md:76`).
- A pocket EOA that sends any transaction pays its gas out of the same USDC it holds. So:
  - **"Return the whole live EOA balance" always reverts.** The `pocket-return` transfer plus its own fee exceeds the balance. Local tx `0x2327…990a` sent 19,944 base units and reverted, so the slow path never completes.
  - **"Pocket EOA USDC = 0" never holds.** It appears in the SCR-144 completion rule, SCR-145 predicate 5 and the CZ-27 §5.3 retirement rule, but a gas remainder always stays behind.

## Change

### 1. Returnable amount (replaces "amount = live EOA balance" everywhere)
- **`returnable = balanceOf(USDC, pocket) − gasReserve`**, where `gasReserve = ceil(gas × maxFeePerGas / 10^12)`.
  - `gas` and `maxFeePerGas` are the values of the exact transaction the signer is about to sign: the prepared `pocket-return` transfer, whose gas comes from `eth_estimateGas`.
  - `10^12` converts 18-decimal native units to USDC's 6-decimal ERC-20 units (A1-05).
- **CZ-15** requests `pocket-return` with `value = returnable` computed this way, from fresh reads.
- **The signer recomputes it** from its own chain read and its prepared transaction, and signs only if `value == returnable` and `returnable > 0`. Otherwise it denies:
  - `pocket-return-value-mismatch` when the values differ
  - `pocket-empty` when `returnable ≤ 0`
- If preparing the transaction yields a different `gas` or fee than CZ-15 assumed, the signer's value governs. CZ-15 re-reads and retries on `pocket-return-value-mismatch`, on the existing schedule.

### 2. "Empty" means nothing is returnable (replaces "EOA USDC = 0" and, on Arc, "native below `signer.pocketDustAtomic`")
- A pocket EOA counts as **empty** when `returnable ≤ 0` at the current fee. Then moving its remainder would cost at least what it moves.
- **Applies to:**
  - **SCR-144 completion rule:** a row is terminal when the `return_tx` receipt holds the `Transfer(pocket → vault)` log, `withdrawingBalance = 0`, and the EOA is empty.
  - **SCR-145 predicate 5:** "pocket EOA USDC = 0" becomes "the EOA is empty".
  - **CZ-27 §5.3 retirement:** "the pocket EOA's USDC balance" being zero and "native balance below `signer.pocketDustAtomic`" are one check on Arc: the EOA is empty.
- `signer.pocketDustAtomic` stays as the floor for non-Arc networks and is unchanged.

### 3. The gas remainder
- It is never swept: by definition, sweeping it would cost at least what it moves.
- It stays in the pocket EOA when K4 is retired. It counts as spent through the existing write-off or closure accounting. No new event or ledger row.
- **Accepted loss:** at most one transfer fee per pocket.

### 4. Tests (owners per SCR-150 §5)
- **Signer:**
  - `pocket-return` signs only for `value == balance − gasReserve`
  - `+1` → `pocket-return-value-mismatch`
  - `returnable ≤ 0` → `pocket-empty`
  - on a real local chain, the signed return mines and leaves a remainder ≤ `gasReserve`
- **Run 4:** restore the three G1-blocked cases using the new rules:
  - SCR-144 restart cases (completion with an empty EOA)
  - manual return recorded, including the same-block lower-`logIndex` case
  - SCR-145 overdue write-off with all eight predicates holding and no zeroing workaround
- **Run 2:** remove the "zero the pocket's USDC" step; predicate 5 is "empty".
- **Retirement:** `retirePocketKey` is allowed with a remainder that's empty, and denied when `returnable > 0`.

## Not changed
- Contracts.
- The pullback, `writeOffPocket` balance-above-fee rule (SCR-127) and slow-withdraw rules (SCR-141).
- Config keys: no new key.

## Decision
- Architect ruling under Zaryab's delegation. Recorded by his merge.
