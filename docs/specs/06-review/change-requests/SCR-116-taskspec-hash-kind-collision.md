# SCR-116: `taskSpecHash` preimage collides on `kind`

| Field | Value |
|---|---|
| ID | SCR-116 |
| Filed by | T-041 builder, 2026-10-21 |
| Spec and section | `docs/specs/02-data-and-protocol/data-and-protocol.md` §4.3.1 invariant, §5.2 `taskSpecHash` |
| Status | Accepted (Zaryab, 2026-10-21); applied to 02 §4.3.1 and §5.2 |

## Problem

- §5.2 defined `taskSpecHash = H({hashRule:"czar-hash-v1", kind:"task-spec", …TaskSpec})`.
- `TaskSpec` has a required field `kind` (`table-fill`, …). Spreading it into the preimage puts two `kind` keys in one object: either `TaskSpec.kind` overwrites the `"task-spec"` discriminator, or the discriminator hides `TaskSpec.kind` from the hash. Both break the hash: the first loses domain separation, the second lets a changed task kind keep the same hash.

## Evidence

- `schemas/task-spec.schema.json` requires `kind`.
- No code, example or vector computed `taskSpecHash` before this change (`grep` over `apps/`, `packages/`, `vectors/`, `examples/`), so no stored hash changes.

## Decision

- 2026-10-21: **Accepted.** Nest the object: `taskSpecHash = H({hashRule:"czar-hash-v1", kind:"task-spec", taskSpec})`, with `taskSpec` the whole `TaskSpec` (absent optional fields omitted, §5.1 normalization). Applied to 02 §4.3.1 and the §5.2 table.
- `objectiveHash` and `planHash` keep including `taskSpecHash` unchanged.

## Affected tasks

- T-041 (`@czar/hashing` step 0, `submitObjective`); T-045 (`planHash`, S1-P7).
