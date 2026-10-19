# SCR-102: The arc-foundry release digest is recorded only in truncated form

| Field | Value |
|---|---|
| ID | SCR-102 |
| Filed by | Czar builder (tier 1), 2026-10-19 |
| Spec and section | `specs/00-ground-truth/part2.md` A9-13; `specs/05-build-plan/phase-1-tasks.md` T-003 |
| Status | Open |

## Problem
- T-003 requires installing arc-foundry v0.8.0-2 "with its `.sha256` checked". A9-13 records the matched digest only as `90e3eefb…db87` and does not name the archive (target) it belongs to.
- Checking a download only against the `.sha256` file from the same release protects against corruption, not against a replaced release. A pinned full digest per target is needed for that.

## Evidence
- A9-13: "Installed into a temporary directory (sha256 `90e3eefb…db87` matched)".

## Proposed change
- Record the full sha256 of `arc-foundry-v0.8.0-2-x86_64-unknown-linux-gnu.tar.gz` and `arc-foundry-v0.8.0-2-aarch64-apple-darwin.tar.gz` in A9-13.
- Until then, `scripts/install-arc-foundry.sh` pins the digests in `scripts/arc-foundry.sha256` as first observed by CI, and the builder checks the Linux digest against the `90e3eefb…db87` fragment.

## Affected tasks
- T-003, T-022, every CI job that installs Arc Foundry

## Decision
- 
