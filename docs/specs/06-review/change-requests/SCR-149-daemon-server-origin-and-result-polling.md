# SCR-149: Daemon server origin, and polling through to the final state for write-back

| Field | Value |
|---|---|
| ID | SCR-149 |
| Filed by | chief architect, 2026-10-27, from the review of PR #108 (head `20cf440`) |
| Spec and section | SCR-147 (amended, with erratum PR #110); CZ-02 daemon (`local-observers-and-daemon.md`); SCR-130 local-only rule; `@czar/config` |
| Status | Accepted (Zaryab's delegation for Track A closure; recorded by his merge) |

## Problem
- The daemon hard-codes `SERVER_ORIGIN = "http://localhost"` (port 80) in `apps/daemon/src/pairing/pair-device.ts:5` (merged) and in #108's `objective-http.ts:5`. The local server listens on `127.0.0.1:3000`, and no config key names the server for the daemon. So `czar pair`, `czar objective` and `czar result` can't reach any real server.
- SCR-147 stops polling at `awaiting-approval`. After approval nothing waits for the final state, so the result write-back is never triggered.

## Change

### 1. New key `daemon.serverOrigin`
- **Type:** string (URL origin). **Default:** none (`noDefault`). Each environment sets it; there is no hosted production origin yet.
- **Local value:** `env/local.toml` on `local-v1`: `"daemon.serverOrigin" = "http://127.0.0.1:3000"`.
- **Read only by commands that contact the server:** `czar pair`, `czar objective`, `czar result`. If it is unset, those commands exit non-zero naming the env var (`CZAR_DAEMON_SERVER_ORIGIN`). Daemon startup and tests that don't contact the server never read it.
- **Validation, same rule as SCR-130:**
  - An origin only (scheme, host, port), with no path.
  - Must be `https://`, except a loopback origin (`http://127.0.0.1:<port>` or `http://localhost:<port>`), which is accepted only when the config was loaded with the local overlay `env/local.toml`.
  - Anything else exits before any request.
  - The daemon does not run the Arc Anvil probe; it holds no RPC.
- **Both call sites use it:** `pair-device.ts` and `objective-http.ts`. The hard-coded constant is removed.

### 2. Polling through to the final state (amends SCR-147 "After submitting")
- `czar objective` keeps polling after `awaiting-approval`, at `daemon.objectivePollSeconds`. It prints each status change until a final status: `delivered`, `failed`, or any other terminal value of `ObjectiveStatusValue`.
- At the final status, if `resultId` is present, it runs the write-back (SCR-147 as corrected by #110) and the ack (SCR-148 §1).
- **`czar result <objectiveId>`:**
  - if the objective is not final yet, it polls the same way until it is, then writes back
  - if it is already final, it writes back idempotently
- **Interrupting (Ctrl-C)** during polling is safe. Nothing is half-written: the write-back is atomic, and the ack key was persisted before the first send. `czar result` resumes.
- The command never polls past the server's own terminal state. Plan and envelope expiry are enforced server-side and end in a terminal status.

### 3. Lockfile exception for #108
- The lockfile change in #108 is bundled in commit `7f3bab4` and can't be split without rewriting a pushed commit.
- An exception is granted: the reviewer records that the lockfile diff is limited to the `apps/daemon` importer's two workspace links. No other lockfile edits are allowed.

## Tests (Lane 4, in #108)
- `daemon.serverOrigin`:
  - unset → named error
  - an `https` origin is accepted
  - loopback with the local overlay is accepted
  - loopback without the local overlay is refused
  - a value with a path is refused
  - both `czar pair` and `czar objective` use it (no constant left)
- Polling continues past `awaiting-approval` to a final status, then writes back once and acks once.
- `czar result` on a non-final objective polls, then writes back. On a final one it's idempotent.
- Interrupt after the key is persisted, then `czar result` → the same key is reused (SCR-148 §1 client test 5).

## Decision
- Architect ruling under Zaryab's delegation. Recorded by his merge.
