# SCR-005: `forceCloseEnvelope` accounting is undefined, and pocket/job calls that do not check the envelope state can then break INV-2 or lock funds.

| Field | Value |
|---|---|
| ID | SCR-005 |
| Filed by | Independent reviewer (G0-01), 2026-10-19 |
| Spec and section | specs/03-smart-contracts/czar-vault.md §5.2 `forceCloseEnvelope` (line 120); §5.4 `grantPocketGas`, `requestPullback`, `confirmPullback` (lines 141, 143, 144); §5.5 `fundJob` (line 161), job refunds (line 165) |
| Status | Open |
| Review finding | RV-005 (Critical) in `specs/06-review/2026-10-19-spec-review.md` |

## Problem
- It is not stated whether `pocketOutstanding` is zeroed, what state the pockets move to, or what happens to `Opened` (unfunded) jobs.
- `fundJob`, `grantPocketGas` and `requestPullback` do not require the envelope to be `Open`. Job refunds have a closed-envelope branch (line 165); pullbacks do not.
- The vault has no per-envelope pocket list (line 90: "No arrays indexed by user input"), so it cannot write off pockets in a loop.

## Evidence
- `forceCloseEnvelope`: "pockets may be open (written off: `spent += pocketOutstanding`); jobs may be open (stay tracked by `jobKey`; their refunds credit free balance later)"; state changes: "as above plus write-offs".
- "As above" = `closeEnvelope`: "`released = cap − spent − pocketOutstanding − jobEscrowed` (the last two are 0 here); `committedTotal −= released`".
- `confirmPullback`: "`envelope.pocketOutstanding −= same`; `committedTotal += same`" with no envelope-state branch.
- Reviewers tried the literal reading and the "zeroed" reading; each fails somewhere (below).
- Failure scenario:
  1. Literal reading: cap 100, spent 10, pocketOutstanding 20. Force-close sets spent to 30 but leaves `pocketOutstanding` at 20. `released = 100 − 30 − 20 = 50`, so 20 stays in `committedTotal` forever.
  2. Zeroed reading: the pocket stays `Funded`. The agent calls `requestPullback` (allowed); the mint lands; `confirmPullback` underflows `envelope.pocketOutstanding` (stuck forever) or, if guarded, adds 20 to `committedTotal` for a closed envelope (locked forever).
  3. An `Opened` job's `reservedCap` is released to free balance at force-close. The agent then calls `fundJob`, which does `committedTotal −= b` and sends `b` out. The same money was released and spent; other envelopes are now under-backed (INV-2 broken).

## Proposed change
- Define force-close completely: zero `pocketOutstanding`, mark each affected pocket `Closed` (or track by a per-envelope counter), cancel the accounting for `Opened` jobs.
- Require envelope `Open` in `fundJob`, `grantPocketGas`, `requestPullback`, or define a closed-envelope branch for each.
- Credit pullbacks and manual returns on a closed envelope to free balance, as job refunds already do.
- Add invariant tests that exercise force-close with open pockets and unfunded jobs.

## Affected tasks
- T-014, T-017, T-018, T-021 (M1)

## Decision
- <filled in by Zaryab: accepted or rejected, and why>
