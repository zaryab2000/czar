# SCR-126: Signer process and server composition root, plan → pocket key link, `promptHash` rule

| Field | Value |
|---|---|
| ID | SCR-126 |
| Filed by | Architect (Claude), 2026-10-21, from the Lane 1 (T-036/T-037) and Lane 2 (T-046/T-048/T-049) task reports (SCR-L1-01, SCR-L1-02, the T-046 `promptHash` item) |
| Spec and section | CZ-27 §3, §4, §5.3; CZ-15 §3, §5.3; SCR-117; T-035, T-037, T-048, T-052 |
| Status | Accepted (Zaryab, 2026-10-21; architect ruling under his delegation) |

## Problem

- T-035 lists its output as a "separate process" and CZ-27 §3 describes a Unix-socket signer, but the code is a library with no entrypoint. Nothing starts the socket, the Postgres audit sink or the gas-refill job (SCR-L1-02).
- Nothing composes the server either. The acceptance checker's profile seeding, the injection boundary, the payer's boundary and receipt hooks and the signer client exist only as constructors (noted by the T-047 and T-048 reports).
- CZ-27 §4 says `createPocketKey(planId)` (D71), but nothing says where the plan → pocket key link is stored or how it is recovered after a restart (SCR-L1-01).
- SCR-117 says the proxy refuses when `promptHash` "does not match the file", but never says which bytes are hashed.

## Decision

### 1. Signer process (completes T-035's "separate process" output; Lane 1)

- **Entrypoint.** `apps/signer/src/main.ts`. It opens the local keystore with the passphrase from the keychain (D78), creates the signer with `postgresAudit` on the local Postgres `audit` table, and starts `startGasRefillJob`. It serves JSON requests on a Unix domain socket at `signer.socketPath`, with mode 0600, owned by the user. There is no TCP port.
- **Caller identity.** Each caller sends `{service, token}`. Tokens live in the macOS keychain under item `<signer.keychainService>.token.<service>`, one per calling service: `server`, `merchants`, `relayer-jobs`.
  - The signer reads them itself at start and compares in constant time.
  - A missing or unknown token is denied and audited.
  - Tokens are never in config, the environment or argv (D78).
- **Client.** `@czar/signer` exports `createSignerClient({socketPath, service})`, which reads its own token from the keychain and exposes the same `sign` and `createPocketKey` calls as the in-process signer.
- **Tests.**
  - An unknown token is denied.
  - The socket file mode is 0600.
  - A K3 `usdc-3009` round trip works over the socket.
  - The refill job starts with the process.

### 2. Server composition root (Lane 2, finishes Bundle A)

- **Entrypoint.** `apps/server/src/main.ts`, started in this order:
  1. Pool, then migrations.
  2. The acceptance checker (seeds its profile).
  3. The injection boundary.
  4. The signer client (§1).
  5. The receipt builder.
  6. The vault-direct payer with its boundary and receipt hooks.
  7. The HTTP app.
- **In the bundle.** Until the §1 process lands, Lane 2's tests construct the in-process T-035 signer. The root accepts either through the same interface.
- **Test.** The started root runs one vault-direct step end to end on `arc-anvil` (the T-048 acceptance test runs through it, not around it).

### 3. Plan → pocket key link (owner CZ-13 writes, CZ-15 reads; T-052)

- **Table.** The server table `plan_pocket_keys (plan_id PK, pocket_address, created_at)`.
- **Write.** CZ-13 calls `createPocketKey` when a plan has a Gateway step and writes the row in the same transaction that stores the plan. The address is the kind-4 payee leaf (D71).
- **Read.** CZ-15 reads the row to register, fund and pay. After a restart, the pocket key is found by `K4:<pocket_address>` in the keystore.
- **Signer interface.** It stays `createPocketKey(caller)`. The `planId` association lives only in the server table.

### 4. `promptHash` rule (SCR-117, AM-02)

- `promptHash = keccak256(UTF-8 bytes of models/<id>.md exactly as committed)`, as a lowercase `0x` hex string. No normalisation and no trimming, the same rule as the T-047 `code_hash`.
- The daemon and the server compute it the same way. The proxy refuses with `503 upstream-unavailable` on a mismatch.

## Affected tasks

- T-035 (process completion, Lane 1)
- T-048 / T-049 (composition root, Lane 2 Bundle A)
- T-045 and T-052 (pocket key link)
- T-046, T-040, T-065 (`promptHash`)
