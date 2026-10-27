# SCR-026: The public demand-proof leaf carries both the rotatable `userPseudonym` and the vault address, linking a user's soul-version history to all their payments.

| Field | Value |
|---|---|
| ID | SCR-026 |
| Filed by | Independent reviewer (G0-01), 2026-10-19 |
| Spec and section | `docs/specs/02-data-and-protocol/data-and-protocol.md` §4.17 (lines 403, 408), §4.x (line 271); `schemas/demand-proof-leaf.schema.json` (lines 127, 132); spec 01 §11.3 (lines 969, 971) |
| Status | Accepted with changes: applied in spec 02 §4.17 (`DemandProofLeaf` v2), §4.18, §5.2, §7.1; `schemas/demand-proof-leaf.v2.schema.json` (v1 kept, marked superseded); CZ-17 §5.1, §5.3, §5.4; `open-evidence-log.md` §11; spec 01 §11.3; T-057. Change: removing `userPseudonym` alone was not enough, because the leaf's bare `soulVersionHash` also appears in the public soul-version leaf; it is replaced by a per-envelope salted `soulVersionCommit`. |
| Review finding | RV-026 (High) in `docs/specs/06-review/2026-10-19-spec-review.md` |

## Problem
- Spec 01 §11.3's demand-proof leaf has no pseudonym; spec 02 and the schema add it, and require it.

## Evidence
- Spec 02 line 403: "`userPseudonym` … per-user rotating pseudonym"; line 408 `envelopeRef` = "`Caip10(vault)` + ":" + `envelopeId`" (public).
- Spec 01 line 971: "The soul-version leaf uses a per-user pseudonym that the user can rotate."
- Both fields are `required` in the schema.
- Failure scenario:
  1. Anyone reading the public evidence archive joins demand-proof leaves to soul-version leaves through `userPseudonym`.
  2. The user's soul update history is now tied to their vault and every payment; after a rotation, the next demand-proof leaf links the new pseudonym again.

## Proposed change
- Remove `userPseudonym` from `DemandProofLeaf`, or use a separate per-envelope salt that is never reused in soul-version leaves.

## Affected tasks
- T-007, T-057 (M0, M4)

## Decision
- Accepted under Zaryab's 2026-10-19 instruction to apply every review fix (D71–D81 record the decisions he approved for the items that needed one).
- Applied 2026-10-19 on branch `spec/review-fixes`: Accepted with changes: applied in spec 02 §4.17 (`DemandProofLeaf` v2), §4.18, §5.2, §7.1; `schemas/demand-proof-leaf.v2.schema.json` (v1 kept, marked superseded); CZ-17 §5.1, §5.3, §5.4; `open-evidence-log.md` §11; spec 01 §11.3; T-057. Change: removing `userPseudonym` alone was not enough, because the leaf's bare `soulVersionHash` also appears in the public soul-version leaf; it is replaced by a per-envelope salted `soulVersionCommit`.
