# SCR-101: The Arc testnet hardfork for the arc-anvil pin is not recorded and cannot be read from the build environment

| Field | Value |
|---|---|
| ID | SCR-101 |
| Filed by | Czar builder (tier 1), 2026-10-19 |
| Spec and section | `docs/specs/05-build-plan/phase-1-tasks.md` T-003 "Review fixes" (RV-058) |
| Status | Open (2026-10-20, D88 triage: needs Zaryab) |

## Problem
- T-003 says to pin `arc-anvil --hardfork` to "the hardfork Arc testnet runs (read from the chain at task time and recorded)". No spec records the value, and no spec says how to read it from the chain.
- Arc Foundry v0.8.0-2 accepts `arc:zero6`, `arc:zero7` and `arc:zero8` and defaults local chains to the newest (arc-foundry README, "Pinning a hardfork").
- The builder environment cannot reach `https://rpc.testnet.arc.io` (egress proxy refuses the connection), so the value cannot be read here.

## Evidence
- `curl https://rpc.testnet.arc.io` → `CONNECT tunnel failed, response 403` (2026-10-19).
- `grep -ri zero[678] docs/specs/` → no match.

## Proposed change
- Record the testnet hardfork as a ground-truth fact (for example A9-xx: "Arc testnet runs `arc:zero<n>` at block N, read by <method>") and name the method.
- T-003 then sets `hardfork = "arc:zero<n>"` in `contracts/foundry.toml` `[profile.arc]` and passes `--hardfork` to `arc-anvil` in CI.

## Affected tasks
- T-003 (pin only; the rest is built), T-010, T-021, T-022

## Decision
- **Still open; needs a testnet RPC call, which the build containers cannot make** (the 2026-10-20 attempt from the spec session was refused by the network proxy too).
- **Does not block contract code.** The 07 PRDs run under `FOUNDRY_PROFILE=arc` with Arc Foundry's default (newest) hardfork; the shared-libraries suite passes there, with the P-256 precompile live.
- **Action for Zaryab:** read the hardfork Arc testnet runs (record the method as a new A9 fact), then set `hardfork = "arc:zeroN"` in `[profile.arc]` and on CI's `arc-anvil` command. Needed before the M1 exit sign-off.
