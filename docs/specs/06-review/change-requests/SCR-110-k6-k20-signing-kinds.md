# SCR-110: K6 and K20 have no signing kind in the CZ-27 interface

| Field | Value |
|---|---|
| ID | SCR-110 |
| Filed by | Czar builder (tier 2), 2026-10-19 |
| Spec and section | `docs/specs/04-components/server-autonomy-roi-keys.md` CZ-27 §4 (kind list), §5.1 (K6, K20 rows), §5.2 "Dual control" |
| Status | Open, narrowed (2026-10-20, D88 triage) |

## Problem
- §5.1 lets K6 sign `pause`/`unpause`, and K20 sign `queueGuardian`, `queueDefaults` and ownership transfers. The §4 `kind` enumeration has no kind for any of these.
- §5.2 requires an interactive CLI confirmation for every K6/K20 request (D80). The CLI's command shape, and whether it uses the same `sign()` path, is not specified.

## Evidence
- `apps/signer/src/kinds.ts`: `KEY_KINDS.K6 = []`, `KEY_KINDS.K20 = []`. The service refuses both keys with `interactive-only` (`apps/signer/test/service.test.ts`).

## Proposed change
- Add the kinds `guardian-call` (K6: `pause`, `unpause` on the factory) and `factory-admin-call` (K20: `queueGuardian`, `applyGuardian`, `queueDefaults`, `applyDefaults`, Ownable2Step transfer).
- Make both reachable only from a `czar-signer confirm` CLI on a TTY that asks for the action and the target address, and add that command to T-035 or T-036.

## Affected tasks
- T-035, T-036, T-027 (deployment uses K20)

## Decision
- **Narrowed by D88.** The factory constructor now sets the admin with `Ownable(admin_)` (`czar-vault-factory.md` §3), so deployment (T-027) needs no K20 signature and is **not blocked**.
- **Still open:** the pause drill (K6 `pause`/`unpause`) and any later K20 call (`queueGuardian`, `applyGuardian`, `queueDefaults`, `applyDefaults`, `cancelChange`, ownership transfer) need signing kinds. The proposed `guardian-call` and `factory-admin-call` kinds, reachable only from a TTY `czar-signer confirm` CLI, stand; decide them with T-035/T-036 before the pause drill.
