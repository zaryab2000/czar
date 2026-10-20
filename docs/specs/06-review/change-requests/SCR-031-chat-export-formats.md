# SCR-031: Ground truth for ChatGPT and Claude export formats before any archive import

| Field | Value |
|---|---|
| ID | SCR-031 |
| Filed by | Architect (Claude), 2026-10-20, from D90 item 8 |
| Spec and section | `docs/specs/02-data-and-protocol/data-and-protocol.md` §15.3; `docs/specs/04-components/local-observers-and-daemon.md` CZ-02 §5.6 (source intake); `docs/specs/05-build-plan/stage-2-backlog.md` P2-21 |
| Status | Open (research request) |
| Plan | `I-F-1_soul-inputs-technical-plan.md` §14, first row |

## Problem
- The requirement asks for importing saved memory and conversation archives from ChatGPT and Claude. No fact in `docs/specs/00-ground-truth/` or `docs/research/evidence/` describes either export.
- Without it, a parser would invent file names, fields and threading rules (builder rule: never invent a field).

## Evidence
- Plan §14: searched `00-ground-truth/` and `research/evidence/` for "ChatGPT export", "Claude export", "conversation archive", "custom instructions", "saved memory"; nothing found.

## Proposed change
- Research, for each app, from official current sources with URL and date: container type, file names, JSON or HTML schema and field names, conversation threading, attachments, whether saved memory and custom instructions are included, deletion behaviour, version markers and size limits. Add a sanitized fixture.
- Then a follow-up SCR specifies the parser (local only, bounded, layer 1 before storage, proposals only) and its privacy tests.
- Phase 1 keeps paste-only import (`POST /local/soul/import-text`).

## Affected tasks
- None in Phase 1; P2-21.

## Decision
- Pending.
