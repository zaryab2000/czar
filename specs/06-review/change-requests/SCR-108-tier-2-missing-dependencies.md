# SCR-108: Tier 2 tasks depend on tasks outside tier 2 (T-006, T-026)

| Field | Value |
|---|---|
| ID | SCR-108 |
| Filed by | Czar builder (tier 2), 2026-10-19 |
| Spec and section | `specs/05-build-plan/phase-1-tasks.md` T-007, T-042 (Deps: T-006); T-035 (Deps and Inputs: T-026 `packages/vault-client`) |
| Status | Open |

## Problem
- T-007 and T-042 list T-006 (`@czar/schemas`) as a dependency. T-006 is not in tier 2, so both were built against the specs directly.
- T-035 takes `packages/vault-client` from T-026, which is tier 3. The signer instead declares the ABI fragments it encodes, mirrored from `contracts/src/interfaces`.

## Evidence
- `apps/signer/src/abi.ts` declares the vault, factory, job escrow, OEL, Gateway and USDC fragments.
- `apps/signer/test/abi-and-vectors.test.ts` fails if a state-changing `ICzarVault` function is missing, or if a factory function is not on the deny list.

## Proposed change
- Mark the T-006 dependency of T-007 and T-042 as "schema validation added when T-006 lands". T-047 already needs both.
- When T-026 lands, T-035 swaps `apps/signer/src/abi.ts` for the generated `@czar/vault-client` ABIs. The drift test stays.

## Affected tasks
- T-006, T-007, T-026, T-035, T-042

## Decision
- 
