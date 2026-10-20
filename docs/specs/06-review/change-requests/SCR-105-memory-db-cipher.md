# SCR-105: The memory.db cipher is described as the binding's default, but the default is not SQLCipher AES-256

| Field | Value |
|---|---|
| ID | SCR-105 |
| Filed by | Czar builder (tier 1), 2026-10-19 |
| Spec and section | `docs/specs/04-components/local-observers-and-daemon.md` CZ-02 §5.3 (DB file line); B6-11 |
| Status | Open |

## Problem
- CZ-02 §5.3 says: "cipher: the binding's default SQLCipher-compatible AES-256 (B6-11)".
- In `better-sqlite3-multiple-ciphers` 13.0.3 the default cipher is ChaCha20-Poly1305 (`sqleet`), not SQLCipher. The two halves of the sentence cannot both hold.

## Evidence
- A fresh database keyed with `PRAGMA key` and no cipher pragma reports `PRAGMA cipher` = `chacha20` (run 2026-10-19, Node 22.22.0, linux-x64 prebuild).

## Proposed change
- State the cipher explicitly: "`PRAGMA cipher = 'sqlcipher'` (SQLCipher v4 scheme, AES-256-CBC with HMAC-SHA512) before `PRAGMA key`". T-060 is built this way; switching to ChaCha20 is a one-line change before any user data exists.

## Affected tasks
- T-060 (built with `sqlcipher`), T-063

## Decision
- 
