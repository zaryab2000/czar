# 02 — Data and protocol

- **Status:** draft written 2026-10-18 together with `docs/specs/03-smart-contracts/`. Awaiting Zaryab's review of the open decisions in `data-and-protocol.md` §15.2.
- **Rule:** every shared type, hash rule, id format, EIP-712 type and signature encoding is defined **here once**; spec 03 references them by section.

## Files

| Path | What it is |
|---|---|
| `data-and-protocol.md` | The main spec: conventions, privacy classes, 20 data objects, canonical hashing and Merkle rules, EIP-712 types with computed hashes, ids and nonces, observer mappings, APIs, MCP tools, x402 handling, discovery-index shape, soul exports, cross-reference to spec 03, assumptions, open decisions, gaps, flags |
| `schemas/*.schema.json` | 19 JSON Schema 2020-12 files, one per object, with `x-privacyClass` on every field; `schemas/README.md` records the validation run |
| `api/openapi.yaml` | OpenAPI 3.1 for daemon ↔ server, app ↔ server, the public index and the Phase 2 claim server (36 paths) |
| `api/local-openapi.yaml` | OpenAPI 3.1 for the daemon's loopback viewer routes (local-only, AM-16) |
| `mcp/czar-mcp-tools.md` | The five local MCP tools, annotations, URL-mode elicitation, dual-era handling, push payloads (stage 2, D69) |
| `vectors/compute-eip712-vectors.mjs`, `vectors/eip712-vectors.json` | The script and recorded output (viem 2.57.2) for every type hash, domain separator and test digest |

## Summary

- Money is always a 6-decimal atomic-unit integer string; ids are prefixed ULIDs or on-chain counters; timestamps are RFC 3339 UTC.
- Five privacy classes with a `[[R:<layer>:<type>]]` redaction-marker format; Cursor's `user_email` and similar fields are dropped at intake.
- One canonical hash rule (RFC 8785 JCS + keccak256) and one Merkle rule (double-hashed tagged leaves, sorted-pair nodes) serve demand proofs, soul versions, plans and `payeeRoot`.
- The vault's ERC-1271 signature carries a kind tag and the fields needed to recompute the digest; a 65-byte fallback exists for the untested Facilitator case.
- Nonces derive from `(vault, reservationId, index)`, which is what makes batch reservations safe; payment ids follow the x402 `payment-identifier` extension and are the retry key.
- APIs: device-token and session auth, idempotency keys, RFC 9457 errors, cursor pagination, rate limits; MCP over stdio with URL-mode elicitation for anything that spends.

## Change log

| Date | Id | Change |
|---|---|---|
| 2026-10-18 | AM-01 to AM-18, D51, D54 | Amendments from spec 04 applied; new `api/local-openapi.yaml` (AM-16) for the daemon's loopback viewer routes. |
| 2026-10-19 | D69 | Push payloads tagged stage 2 in the file table. |
