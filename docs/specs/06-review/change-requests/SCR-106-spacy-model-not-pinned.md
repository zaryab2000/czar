# SCR-106: The spaCy English model for the Presidio helper is not chosen, and the obvious choice breaks the memory budget

| Field | Value |
|---|---|
| ID | SCR-106 |
| Filed by | Czar builder (tier 1), 2026-10-19 |
| Spec and section | `docs/specs/04-components/local-observers-and-daemon.md` CZ-26 §3, §13, §15 |
| Status | Open |

## Problem
- CZ-26 §15 says the spaCy English model version is "pinned in the build plan". `build-plan.md` §2.2 pins Presidio 2.2.364 but no spaCy model.
- CZ-26 §13 caps the helper at "RSS ≤ 400 MB (spaCy model)". Presidio's default model, `en_core_web_lg`, does not fit.

## Evidence
- Measured on linux-x64, bundled CPython 3.13.14, Presidio 2.2.364, spaCy 3.8.16, after one `analyze_anonymize` call (2026-10-19):
  - `en_core_web_lg` 3.8.0: RSS 807,308 KB; bundle 837 MB.
  - `en_core_web_md` 3.8.0: RSS 406,740 KB (≈ 397 MiB, ≈ 416 MB); bundle 467 MB.
- Both models redacted the PII corpus in `apps/redact-sidecar/tests/` (names, emails, phones, a location).

## Proposed change
- Pin the model in `build-plan.md` §2.2. T-064 is built with `en_core_web_md` 3.8.0 (sha256 in `apps/redact-sidecar/uv.lock`).
- Either state the 400 MB cap in MiB, or raise it to 450 MB for `md`, or choose `en_core_web_sm` (smaller, weaker on names and places, the leaks D45 is about).

## Affected tasks
- T-064, T-066, T-069

## Decision
- 
