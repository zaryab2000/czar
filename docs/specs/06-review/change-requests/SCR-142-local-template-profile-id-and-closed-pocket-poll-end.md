# SCR-142: `local-template-v1` profile ID producer, and the durable end of closed-pocket polling

| Field | Value |
|---|---|
| ID | SCR-142 |
| Filed by | chief architect, 2026-10-25, from PR #79 (T-124) and PR #80 (TA-08) final review |
| Spec and section | 02 §4.6.1 `local` row; CZ-16 `local-template-v1` (`server-acceptance-evidence-selection.md`); CZ-19 §5.6 quiet period (SCR-141 §2) |
| Status | Accepted (Zaryab's delegation for Track A integration rulings; recorded by his merge) |

## Problem
- 02 §4.6.1 sets a `local` step's `acceptanceProfileId` to "the profile id of `local-template-v1`". Profile IDs are content-addressed (`@czar/hashing` `profileId`, SCR-122). No spec defines the `local-template-v1` profile object, so no ID can be computed, and no component produces it.
- SCR-141 §2 defines when a `Closed` pocket's quiet period is met. It doesn't say how the indexer records that polling has ended, so the end isn't durable.

## Proposed change

### 1. Canonical `local-template-v1` profile (amends CZ-16; 02 §4.6.1)
- The profile object, before `profile_id` is computed, is exactly:

```
{
  "task_class": "local",
  "version": 1,
  "name": "local-template-v1",
  "checks": [
    {
      "name": "structural",
      "kind": "structural",
      "dimension": "structural",
      "spec": { "header": "inputTemplate.expectedKeys", "rows": "one-per-subject", "minFilledCells": 1 }
    }
  ]
}
```

- `profile_id = profileId(object)` through `@czar/hashing`. It is stable because the object is a constant.
- **Producer:** Lane 3 exports `localTemplateProfile()` from `apps/server/src/acceptance/profile.ts`, next to `dataJsonProfile`, with a test that pins the ID value.
- **Consumer:** Lane 2's planner `profiles` port returns that ID for every `local` step.
- **Out of scope:** the Mac assembler (CZ-11, Lane 4) still checks by the rule in CZ-11 §5.2a step 3. This SCR adds no daemon change.
- The planner must never invent, hard-code or leave empty a `local` step's profile ID.

### 2. Durable end of closed-pocket polling (amends CZ-19 §5.6; SCR-141 §2)
- `pocket_balances` gains the internal column `pollEndedAt` (RFC 3339, nullable).
- **Set:** when the SCR-141 §2 stop condition is met, `pollEndedAt = now`, in the same write that records the final reads.
- **Poll scope:** every poll query excludes rows with `pollEndedAt` set. The SCR-127 `closedPocketsWithBalance()` query is unchanged; such a pocket has all balances zero.
- **Never cleared automatically.** A `Closed` pocket can't reopen. Funds that arrive after the quiet period are an accepted risk, outside the 48 h margin SCR-127 chose.
- **Lost value:** if a reindex loses it, polling resumes, and it is set again after another quiet period. That's safe.
- **Not public:** never returned by any query or route.

## Affected tasks
- **TA-08 / T-122 (Lane 2, PR #80):**
  - May merge with local-step planning failing closed.
  - An objective that needs a `local` step must fail planning with a named error and a test.
  - No placeholder ID is allowed.
  - Wire the port when the Lane 3 producer lands.
- **Follow-up (Lane 3):** `localTemplateProfile()` and its pinned-ID test. Then Lane 2 removes the fail-closed branch.
- **T-124 (Lane 1, PR #79):** `pollEndedAt` and a scope test (an ended pocket is not polled; the value survives a restart).

## Decision
- Architect ruling under Zaryab's delegation. Recorded by his merge.
