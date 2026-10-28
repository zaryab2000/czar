# SCR-151: Local indexer start block, fork pin contract, and per-chain-session state

| Field | Value |
|---|---|
| ID | SCR-151 |
| Filed by | chief architect, 2026-10-28, from the local bring-up blocker (Ponder never ready in FORK mode) |
| Spec and section | CZ-19 indexer (`server-acceptance-evidence-selection.md`); `apps/indexer/ponder.config.ts:46`; `ops/local/fork-anvil.mjs:99-121`; `ops/local/process-compose*.yaml`; `ops/local/health.sh:177-210`; SCR-146 §3; D92 |
| Status | Accepted (Zaryab's delegation for Track A closure; recorded by his merge) |

## Problem
- `ponder.config.ts:46` reads `Number(process.env.CZAR_INDEXER_START_BLOCK ?? "0")`, and no process sets it.
  - In FORK mode the chain head is near the testnet pin (millions of blocks), so Ponder backfills from block 0 through the fork's remote history and never becomes ready.
  - A malformed value silently becomes `NaN`.
- Both local chains are ephemeral. `--mnemonic-random`, with no state load or dump, means every `arc-anvil` start is a new chain.
  - Server and Ponder state from an earlier start refers to a chain that no longer exists, yet today every mode and every start shares one database.

## Change

### 1. The pin file is the authoritative source (local-v1)
- **File:** `deployments/.arc-fork-pin.json` (gitignored, mode 0600), written atomically by `fork-anvil.mjs`. Exact format, all numbers as decimal strings:
  ```json
  {"chainId":"5042002","forkBlock":"<n>","pinReason":"<reason>","indexerStartBlock":"<m>"}
  ```
- `indexerStartBlock` is added by the FORK deploy step. Just before sending the first Czar deployment transaction, it reads `eth_blockNumber` from `127.0.0.1:8545` and writes the value back atomically.
- **Indexing starts at the Czar deployment block, not the pin.** No Czar contract, vault or pocket can emit an event before deployment, and the USDC and Gateway events the indexer cares about involve Czar addresses, which only exist after deployment.
- **CLEAN mode:** no pin file; the start block is `0`.

### 2. Launcher `ops/local/chain-session.mjs` (local-v1)
- The indexer, server and merchants processes start **through** this launcher, which then runs the real command.
- **It sets:**
  - `CZAR_INDEXER_START_BLOCK`: the pin file's `indexerStartBlock` in FORK, `0` in CLEAN.
  - **Session key** `S`: the first 8 hex characters of the hash of block `CZAR_INDEXER_START_BLOCK`, read from the local node. A fresh chain always has different hashes, so `S` identifies one chain session.
  - Ponder schema `czar_<mode>_<S>`, through Ponder's schema option.
  - Database `czar_<mode>_<S>` in `CZAR_DATABASE_URL` / `DATABASE_URL`, created if absent (`CREATE DATABASE` guarded by a `pg_database` existence check).
- **Fail fast:** non-zero exit, before any process starts or any write happens, if any of these hold:
  - FORK mode and the pin file is missing or unreadable
  - any field missing, non-decimal or negative
  - `chainId` ≠ `5042002`, or the node's `eth_chainId` ≠ `5042002`
  - `forkBlock` ≠ the running node's fork block (from `anvil_nodeInfo`)
  - `indexerStartBlock` ≤ `forkBlock`, or > the node head
  - the node isn't loopback, or doesn't answer `anvil_nodeInfo`
  - the block hash for `S` can't be read

  The error names the field. It never prints keys or URLs with credentials.
- **Restart behaviour:**
  - Restarting the indexer, server or merchants on the **same** running chain reuses `czar_<mode>_<S>` and resumes. Ponder resumes from its checkpoint.
  - A new chain, or a changed pin, gets a new `S`, so new names. Nothing is wiped.
- **Old sessions are never deleted automatically.** `ops/local/README.md` documents an operator-run cleanup. It lists `czar_clean_*` and `czar_fork_*` databases with `psql -Atc "SELECT datname FROM pg_database WHERE datname LIKE 'czar\_%'"`, then drops named ones with `dropdb <name>`, never by wildcard.
- **Data expectations:** nothing local survives a new chain session, because the chain itself doesn't. Within a session, all state persists across process restarts.

### 3. Strict parsing in the indexer (build-v1, then synced)
- `ponder.config.ts`:
  - `CZAR_INDEXER_START_BLOCK` absent → `0` (unchanged)
  - present → must match `^\d+$` and be a safe integer
  - otherwise throw, naming the variable
- This is the only product change.
- **Note (M8):** the testnet deployment must set an explicit start block. Tracked with T-121; not part of this SCR.

### 4. Health
`ops/local/health.sh` gains these lines (FORK and CLEAN):
- `chain session: mode=<fork|clean> S=<8hex> startBlock=<n>`
- `indexer start: <n>`, which must equal the launcher's value, read from the indexer status or config echo
- `indexer lag: head - checkpoint ≤ indexer.maxLagBlocks (120)` (existing check, kept)
- `database: czar_<mode>_<S> reachable`

## Acceptance (tests run on the Mac, recorded on the PRs)
- **Launcher unit tests** (mocked RPC):
  - each fail-fast condition above exits non-zero before spawning
  - FORK sets the start block to `indexerStartBlock`; CLEAN sets `0`
  - the same chain gives the same names twice
  - a new block hash gives new names
  - no DROP is ever issued
- **Indexer:** an invalid `CZAR_INDEXER_START_BLOCK` (`abc`, `-1`, `1.5`) → config throws; absent → `0`.
- **Bring-up (FORK, on the Mac):**
  - the health check is all OK
  - indexer checkpoint ≥ head − 120 within 2 minutes of the indexer starting
  - restarting only the indexer keeps the same `S`, and it is ready again
  - restarting `arc-anvil` with the same pin gives a new `S` (fresh chain), and it is ready
- **CLEAN:** `process-compose -f ops/local/process-compose.yaml up` still reaches all OK, with start `0` and a `czar_clean_<S>` database.

## Owners
- **Lane 1:**
  - §3 as a small build-v1 PR (label `promote-to-build-v1`), then a sync into local-v1
  - §1, §2 and §4 as one local-v1 PR (label `local-only`)
- **Review:** the designated reviewer at the current heads; the architect checks against this SCR.
- **Operator check afterwards** (one line, in the local-v1 checkout, FORK profile running):
  `fnm exec --using=22.22.0 bash ops/local/health.sh`. Every line `OK`, including the new session, start and lag lines.

## Decision
- Architect ruling under Zaryab's delegation. Recorded by his merge.
