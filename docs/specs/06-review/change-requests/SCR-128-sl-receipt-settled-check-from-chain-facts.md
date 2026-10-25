# SCR-128: `sl-receipt` settled-payment check reads indexer facts, not the server's own receipts

| Field | Value |
|---|---|
| ID | SCR-128 |
| Filed by | chief architect, 2026-10-25 (Track A replan, baseline `ce17dad`) |
| Spec and section | `docs/specs/04-components/server/server-autonomy-roi-keys.md` CZ-27 §5.2 `sl-receipt` row; `docs/specs/02-data-and-protocol/data-and-protocol.md` §6.3.3 (receipt attestation note at `:735`) |
| Status | Accepted (Zaryab, 2026-10-25); Applied (2026-10-25) |

## Problem
- CZ-27 requires the `sl-receipt` payment to be one "that the indexer has seen settled (`Settled` event, Gateway `completed`, or job `Completed`)" (`server-autonomy-roi-keys.md:402`).
- The production projection instead reads the server's `evidence_receipts` table (`apps/signer/src/postgres-projection.ts:299-306`). The server writes that table only after the signer returns (`apps/server/src/evidence/receipts.ts:56-70`, sole insert `:195`).
- So the first receipt for every payment is refused `payment-not-settled` (`apps/signer/src/policy.ts:411-416`).
- Tests hide it: the server test double returns `settledPayment: async () => true` (`apps/server/test/payer/test-signer.ts:58`).
- The signer cannot match against indexer facts as specified. The request carries only `paymentRefHash` (a keccak of JCS), while the indexer's `authorizations` table holds `(vault, nonce, amount, settled)` and no hash (`apps/indexer/ponder.schema.ts:48-76`). The hash cannot be inverted.

## Evidence
- File:line references above. `git log -S"payment-not-settled" -- apps/signer/src/policy.ts` in a git checkout at `ce17dad` returns only the introducing commit (snapshot pass; re-run it in a checkout, not an exported tree).

## Proposed change
- **CZ-27 §5.2 `sl-receipt` payload** becomes `{vault, receipt: SlReceipt, paymentRef: PaymentRef}`.
  - `PaymentRef` is the 02 §4.12 shape. The ★ fields may be present and are ignored for hashing.
- **Signer check, in order:**
  1. `keccak256(jcs(paymentRef without ★ fields)) == receipt.paymentRefHash`, through `@czar/hashing`; else deny `payment-ref-mismatch`.
  2. Rail binding:
     - `x402-exact`: `paymentRef.payer == vault`.
     - `gateway-batched`: `paymentRef.payer` is a pocket of `vault` in the indexer pockets mirror.
     - `erc8183-job`: `paymentRef.client == vault`.
     - Otherwise deny `payment-not-this-vault`.
  3. Settled fact from the indexer:
     - `x402-exact`: an `authorizations` row with `vault`, `nonce = paymentRef.nonce`, `amount = paymentRef.amount`, `settled = true`.
     - `gateway-batched`: a `gateway_transfers` row with `from = paymentRef.payer`, `nonce = paymentRef.nonce`, `to = paymentRef.payTo`, `amount = paymentRef.amount`, `status = completed`.
     - `erc8183-job`: the `jobs` mirror for `(contract, jobId)` in `Completed` with `provider = paymentRef.provider` and `budget = paymentRef.budget`.
     - Amount and payee binding on every rail was added during application (2026-10-25) so a receipt can never attest more than the settled fact.
     - Otherwise deny `payment-not-settled`. The denial code is unchanged.
- The signer no longer reads `evidence_receipts` for this check.
- **`sl-validation-report`** (`checksCommitExists`, `postgres-projection.ts:329-334`) also reads `evidence_receipts`. It is an evidence-track kind and is **not** changed here. Track B decides it together with the I-F-6/Flow 7 work.
- **02 §6.3.3:** add the sentence "The signer request carries the full `PaymentRef` so the signer can match it to indexer facts; only `paymentRefHash` enters the signed `Receipt`." The signed struct does not change.

## Affected tasks
- T-035/T-036 (signer policy, Lane 1), T-049 (receipt creation sends `paymentRef`, Lane 2).

## Decision
- Accepted by Zaryab on 2026-10-25 with the Track A replan (context and briefs in `docs/builder-prompts/track-a/`).

## Applied
- CZ-27 §5.2 `sl-receipt` row
- 02 §6.3.3 note
