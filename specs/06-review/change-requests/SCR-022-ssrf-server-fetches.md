# SCR-022: Only `czar-extract` blocks private addresses; planner probes, `createQuote` URLs and deliverable fetches have no SSRF guard.

| Field | Value |
|---|---|
| ID | SCR-022 |
| Filed by | Independent reviewer (G0-01), 2026-10-19 |
| Spec and section | `specs/04-components/server-supply-side.md` (line 134); CZ-13 (line 140); CZ-18 (line 637); CZ-16 (line 277) |
| Status | Accepted, applied in `cross-cutting.md` §2.1 (`safeFetch` in `@czar/x402`), CZ-13, CZ-15, CZ-16, CZ-20, `openapi.yaml` `QuoteRequest`; T-042. |
| Review finding | RV-022 (High) in `specs/06-review/2026-10-19-spec-review.md` |

## Problem
- Live 402 probes of catalog URLs, `createQuote` with a user-agent-supplied `resourceUrl`, and the ERC-8183 deliverable fetcher all fetch outside URLs with no stated guard.
- Under D70 the server, signer, Postgres and indexer run on the same Mac.

## Evidence
- The private-range block appears only for `czar-extract` (supply-side line 134).
- D70: "run as local processes on Zaryab's Mac".
- Failure scenario:
  1. A Circle catalog entry, an MCP `resourceUrl` or a job provider's host resolves to `127.0.0.1` or a LAN address.
  2. Czar's server sends requests to the local signer, Postgres admin or other local services.

## Proposed change
- Move the `czar-extract` guard into a shared fetcher in `@czar/x402`: https only, DNS pinned, private and link-local ranges blocked, redirects re-checked; use it for every outbound probe and fetch.

## Affected tasks
- T-042, T-045, T-055, T-071 (M3, M4, M5)

## Decision
- Accepted under Zaryab's 2026-10-19 instruction to apply every review fix (D71–D81 record the decisions he approved for the items that needed one).
- Applied 2026-10-19 on branch `spec/review-fixes`: Accepted, applied in `cross-cutting.md` §2.1 (`safeFetch` in `@czar/x402`), CZ-13, CZ-15, CZ-16, CZ-20, `openapi.yaml` `QuoteRequest`; T-042.
