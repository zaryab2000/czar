# SCR-102: The arc-foundry release digest is recorded only in truncated form

| Field | Value |
|---|---|
| ID | SCR-102 |
| Filed by | Czar builder (tier 1), 2026-10-19 |
| Spec and section | `docs/specs/00-ground-truth/part2.md` A9-13; `docs/specs/05-build-plan/phase-1-tasks.md` T-003 |
| Status | Accepted (2026-10-20, D88 triage) |

## Problem
- T-003 requires installing arc-foundry v0.8.0-2 "with its `.sha256` checked". A9-13 records the matched digest only as `90e3eefb…db87` and does not name the archive (target) it belongs to.
- Checking a download only against the `.sha256` file from the same release protects against corruption, not against a replaced release. A pinned full digest per target is needed for that.

## Evidence
- A9-13: "Installed into a temporary directory (sha256 `90e3eefb…db87` matched)".

## Proposed change
- Record the full sha256 of `arc-foundry-v0.8.0-2-x86_64-unknown-linux-gnu.tar.gz` and `arc-foundry-v0.8.0-2-aarch64-apple-darwin.tar.gz` in A9-13.
- Observed 2026-10-19 in CI (each matched the release `.sha256`): darwin `90e3eefbf7dd80652fd283a7562e9263301a48797bc2224cc21a3964e2d5db87` (matches the A9-13 fragment, so A9-13 was the macOS archive); linux x86_64 `088bdb96a84418b757f9825d491e702792f1d1d1e29a9145af305a6600a79556` (no independent record). Both are pinned in `scripts/arc-foundry.sha256`; please confirm the Linux digest against a second source.

## Affected tasks
- T-003, T-022, every CI job that installs Arc Foundry

## Decision
- **Accepted.** Both digests were confirmed by an independent download on 2026-10-20, from a different network than the CI run, and each matched its release `.sha256` file:
  - `arc-foundry-v0.8.0-2-x86_64-unknown-linux-gnu.tar.gz`: `088bdb96a84418b757f9825d491e702792f1d1d1e29a9145af305a6600a79556`
  - `arc-foundry-v0.8.0-2-aarch64-apple-darwin.tar.gz`: `90e3eefbf7dd80652fd283a7562e9263301a48797bc2224cc21a3964e2d5db87`
- The extracted Linux `forge --version` reports `1.7.1-dev`, commit `d497beea7096ff2a8e583c8b307941f24a61b06b`, the same commit A9-13 records for `anvil`.
- `scripts/arc-foundry.sha256` keeps both lines; its comment now records the second check. No change to A9-13's wording is needed beyond this record.
