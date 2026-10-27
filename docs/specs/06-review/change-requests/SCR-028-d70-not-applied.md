# SCR-028: D70 (everything runs locally on Zaryab's Mac with a local keystore) is only partly applied; hosting, keys, app origin and archive URLs still assume the cloud.

| Field | Value |
|---|---|
| ID | SCR-028 |
| Filed by | Independent reviewer (G0-01), 2026-10-19 |
| Spec and section | `phase-1-tasks.md` T-040 (lines 543–554), T-036 (lines 516–524); `build-plan.md` M2 exit (line 140), §8 (line 340); `gate-0-checks.md` G0-13 row (line 26); `builder-agent-rules.md` (line 34); spec 01 (lines 410, 455); CZ-22 (`docs/specs/04-components/app/app-and-notifications.md` lines 30, 260); CZ-27 (lines 342–348, 402, 508); `data-and-protocol.md` `archiveUri` (line 428) |
| Status | Accepted (D78), applied in CZ-27 §2–§5 and §15, `docs/specs/04-components/shared/cross-cutting.md` §3.2–§3.3, CZ-22 hosting rows, spec 01 §5, `openapi.yaml` servers, MCP config, `open-evidence-log.md` §11 and spec 02 §4.20 (host-free `czar-archive:<root>`), G0-13, build plan M2 exit and §8, builder rules, T-036, T-040 (rewritten), T-004, T-057, T-080, T-082, `stage-2-backlog.md` GC-9. |
| Review finding | RV-028 (High) in `docs/specs/06-review/2026-10-19-spec-review.md` |

## Problem
- Builders get cloud instructions that D70 replaced, and tests that cannot pass (there is no KMS audit log).
- Phase 1's WebAuthn RP ID is undefined. Passkeys are bound to it, so moving origin in stage 2 strands testnet owner credentials.
- `archiveUri` is anchored permanently in `OpenEvidenceLog`; a localhost URI anchored in Phase 1 can never be fixed.
- No spec says where the keystore lives or forbids the passphrase on a command line or in an environment variable (cross-cutting allows `CZAR_<SECTION>_<KEY>` env overlays).

## Evidence
- T-040: "Testnet hosting: server, indexer, merchants, Postgres, object store" … "after Zaryab approves accounts" … "finds no key material (only KMS ids)".
- G0-13 row: "agent, after Zaryab picks the KMS vendor and creates the account | none (cloud costs only)" (procedure at line 127 says it moved).
- T-036: "KMS audit log shows no call"; M2 exit: "the relayer gas key lives in KMS (D62)".
- Builder rules: "Keys live in the KMS (server) or the OS keychain (user machine)."
- CZ-22: "static build on a CDN; API at `api.<env>.czar.dev`; app origin `app.<env>.czar.dev` (the WebAuthn RP ID…)".
- D70: "the server, paying agent, indexer, Czar's merchants, Postgres (Docker) and the signer service run as local processes on Zaryab's Mac … No cloud cost"; keys in "a local software signer with an encrypted keystore. Its passphrase is held in the macOS keychain."
- Failure scenario:
  1. The T-040 agent asks for cloud accounts or provisions infrastructure; the T-036 agent cannot satisfy its test; G0-13's table row blocks T-035 waiting on a KMS vendor.

## Proposed change
- Run a D70 amendment pass: rewrite T-040 for local hosting, fix the G0-13 row, the M2 exit, §8, T-036, builder rules, spec 01 §5 and §7.2, CZ-22 §3 and CZ-27 §2/§3/§15.
- Decide the Phase 1 app origin and RP ID, and a stable public `archiveUri` host.
- Specify the keystore path (outside the repo or under an ignored path) and ban the passphrase in argv and env; add `signer.backend` to the parameter tables.

## Affected tasks
- T-004, T-035, T-036, T-040, T-057, T-080, T-082, G0-13 (Gate 0, M0, M2, M3, M4, M6)

## Decision
- Accepted under Zaryab's 2026-10-19 instruction to apply every review fix (D71–D81 record the decisions he approved for the items that needed one).
- Applied 2026-10-19 on branch `spec/review-fixes`: Accepted (D78), applied in CZ-27 §2–§5 and §15, `docs/specs/04-components/shared/cross-cutting.md` §3.2–§3.3, CZ-22 hosting rows, spec 01 §5, `openapi.yaml` servers, MCP config, `open-evidence-log.md` §11 and spec 02 §4.20 (host-free `czar-archive:<root>`), G0-13, build plan M2 exit and §8, builder rules, T-036, T-040 (rewritten), T-004, T-057, T-080, T-082, `stage-2-backlog.md` GC-9.
