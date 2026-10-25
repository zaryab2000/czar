# SCR-139: Reproduce interim eligibility from persisted policy inputs

| Field | Value |
|---|---|
| ID | SCR-139 |
| Filed by | TA-06 implementer, 2026-10-25, from the final review of PR #66 at head `5904639` |
| Spec and section | SCR-138 §3 reproduction rule; SCR-137 §1 metadata; CZ-18 §5.2 interim producer |
| Status | Draft — awaiting architect ruling; not applied |

## Problem

SCR-138 says `excluded[]`, `unverified[]`, and `exploration_slot` are reproducible from the stored snapshot and the decision's query. The producer also uses `chain.usdcAddress` to decide offer eligibility and `selection.unverifiedWithApproval` to decide whether to emit an exploration slot. The snapshot stores `policy_version`, which is a hash of a descriptor containing these values, but the hash cannot recover them. The snapshot does not otherwise retain them.

A reader with only `body_jcs` and the decision query therefore cannot determine whether an offer's asset matches the policy or whether an eligible set should produce an exploration slot. Looking up current configuration does not solve this for a historical snapshot after configuration changes.

## Proposed ruling

Define the canonical reproduction inputs so a stored snapshot and decision query are sufficient. The recommended option is to retain the exact policy descriptor used to compute `policy_version` with the snapshot. The architect may instead define another immutable lookup or revise the stated reproduction inputs. Decide the canonical representation and whether SCR-138 §3's guarantee remains based only on the stored snapshot and query.

No snapshot field name, storage contract, or alternate reproduction input is approved by this draft.

## Acceptance criteria

- A reader can reproduce offer eligibility and exploration behavior for a historical decision without consulting current configuration.
- `policy_version` remains bound to the exact policy rules and configuration that produced the decision.
- A reconstruction test reads the persisted JCS body and decision query, then reproduces exclusions, unverified candidates, and the exploration slot without a hardcoded asset or approval flag.
- The architect's ruling states any required snapshot, storage, or reproduction-input changes before implementation.

## Decision

- Pending architect ruling.

## Applied

- Not applied. TA-06 must not change snapshot storage or its contract until this draft is ruled on.
