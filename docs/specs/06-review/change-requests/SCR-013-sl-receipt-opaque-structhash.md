# SCR-013: `SL_RECEIPT` makes the vault sign any SelectionLayer-domain struct hash, and one agent signature validates for every vault.

| Field | Value |
|---|---|
| ID | SCR-013 |
| Filed by | Independent reviewer (G0-01), 2026-10-19 |
| Spec and section | docs/specs/03-smart-contracts/czar-vault.md §6.3 (line 241); INV-11 (line 428); `docs/specs/02-data-and-protocol/data-and-protocol.md` §6.3.3 (line 539) and §6.3.5 (lines 551–552); CZ-27 `sl-receipt` policy (line 392) |
| Status | Accepted with changes: applied in `czar-vault.md` §3, §6.3; spec 02 §6.2, §6.3 (tag `.v2`), §6.3.3, §6.3.5, §6.4; `ICzarVault.SlReceipt`; vectors regenerated (`ReceiptAttestation`, `receiptAttestation_5042002`); CZ-27 `sl-receipt`. Change: both the full fix and the binding, using a vault-domain `ReceiptAttestation` wrapper (ERC-7739-style) because the SL `Receipt` type has no payer field to compare with `address(this)`. |
| Review finding | RV-013 (High) in `docs/specs/06-review/2026-10-19-spec-review.md` |

## Problem
- The vault and signer accept an opaque `structHash`, so the agent key can make every vault attest any SL type, not only `Receipt` (for example `Correction`, `ServiceClaim`, `DeliveryAttestation`).
- All vaults share one `agentSigner` (factory defaults), and nothing binds the message to this vault, so a signature made for vault A is valid for vault B.

## Evidence
- Vault: "Decode `(kind, structHash, agentSig)`. Checks: `digest == toTypedDataHash(SL_DOMAIN_SEPARATOR, structHash)`; `_agentSigned`".
- Spec 02 line 539: "It does not decode receipt fields".
- CZ-27 line 392: request "`{structHash}` plus the receipt object for logging by hash | digest under the SelectionLayer domain only".
- Spec 02 §6.3.5 line 551: "The vault always recomputes the digest for the claimed kind from fields it controls".
- INV-11: "never returns `MAGIC` for a digest that is not the recomputation of a registered kind".
- `docs/architecture/selection-layer-architecture.md` lines 413–434 define other SL types under the same domain.
- Failure scenario:
  1. A hijacked CZ-17 submits struct hashes of fake `Receipt`s for payments that never happened.
  2. Every Czar vault returns MAGIC for them via ERC-1271.
  3. Rankers that trust vault-attested receipts count forged proof-of-demand; a published `Correction` for one vault replays as valid for all.

## Proposed change
- Carry the receipt fields in the signature blob and recompute with `RECEIPT_TYPEHASH` in the vault; at minimum check the type hash.
- Bind the vault: require the receipt's payer/`paymentRef` to be `address(this)`, or use an ERC-7739-style nested domain.
- Make the signer rebuild the `Receipt` hash from fields and check it against a settled payment in the projection. Align spec 02 §6.3.3/§6.3.5 and INV-11.

## Affected tasks
- T-016, T-035, T-049 (M1, M2, M3)

## Decision
- Accepted under Zaryab's 2026-10-19 instruction to apply every review fix (D71–D81 record the decisions he approved for the items that needed one).
- Applied 2026-10-19 on branch `spec/review-fixes`: Accepted with changes: applied in `czar-vault.md` §3, §6.3; spec 02 §6.2, §6.3 (tag `.v2`), §6.3.3, §6.3.5, §6.4; `ICzarVault.SlReceipt`; vectors regenerated (`ReceiptAttestation`, `receiptAttestation_5042002`); CZ-27 `sl-receipt`. Change: both the full fix and the binding, using a vault-domain `ReceiptAttestation` wrapper (ERC-7739-style) because the SL `Receipt` type has no payer field to compare with `address(this)`.
