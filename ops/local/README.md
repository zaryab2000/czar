# Local stack

This runbook is for `local-v1`. It keeps local chain, mock bundler, stand-in, and web
configuration off `build-v1`. Product fixes discovered here go to a fresh `build-v1` PR
first; after Zaryab merges that PR, merge `build-v1` back into `local-v1`. Never merge
`local-v1` into `build-v1`. Label local wiring PRs `local-only` and product fixes
`promote-to-build-v1`.

For every product finding, record its finding ID, date, symptom, root-cause `file:line`,
local-v1 PR if any, build-v1 PR, build-v1 merge SHA, local-v1 merge SHA, and re-run
result in the relevant flow report. Do not mark a finding resolved before the re-run.

The clean chain serves the six SCR-146 §3.3 Track A exit runs. The fork serves the
browser journey in `docs-internal/demo_tests/track-a-exit-flow.md`. That internal file
is gitignored; use the copy in the primary checkout when working from another worktree.
The fork reads Arc testnet state through `https://rpc.testnet.arc.io`.
Every transaction is sent only to `http://127.0.0.1:8545`.
Neither mode authorizes testnet transactions, Circle accounts,
or live model calls. Keep `routing.gatewayEnabled` and `routing.jobEnabled` false.

## Before starting

- Use Node 22.22.0 (`.nvmrc`), pnpm 10.28.0, pinned `arc-anvil`, `arc-cast`, and
  `arc-forge`, `process-compose`, `uv`, and a running OrbStack/Docker engine.
- From the `local-v1` checkout, install the workspace with
  `pnpm install --frozen-lockfile`.
- Install the daemon's local redaction sidecar with
  `uv sync --project apps/redact-sidecar --frozen`. It needs Python 3.13 (`uv` fetches
  it) and pulls the pinned spaCy `en_core_web_md` model from `pyproject.toml`. The CLI
  launches `apps/redact-sidecar/.venv/bin/czar-redact` on demand (`apps/daemon/src/cli.ts`
  `sidecarCommand`); it is not a compose service. If it is unavailable, `czar objective`
  requires an interactive confirmation of the redacted goal before submission.
- The local T-105 keychain entries and ignored `deployments/local-keys.json` must exist
  before stack startup. `deployments/local-keys.example.json` is a template, never a
  deployment input. Do not paste key creation output into a report or chat.

## Operator key creation

Zaryab runs these commands in his own terminal, from the `local-v1` checkout, after the
local wiring is ready. They create local keystore entries and write the ignored manifest.
The passphrase lives only in the macOS keychain: never put it in an argument,
environment variable, log, chat, or committed file.

**Step 1: check what already exists. Do not rerun creation if anything below says
`exists`.** These checks never print a secret (no `-w` on the lookup):

```sh
security find-generic-password -s dev.czar.signer.keystore -a keystore >/dev/null 2>&1 \
  && echo "keychain item: exists" || echo "keychain item: absent"
test -e deployments/local-keys.json && echo "manifest: exists" || echo "manifest: absent"
test -d "$HOME/Library/Application Support/Czar/signer/keystore" \
  && echo "keystore dir: exists" || echo "keystore dir: absent"
```

- Manifest or keystore `exists` → stop and report it; the scripts refuse to create a
  second key set (`apps/signer/scripts/create-keys.ts:132-142`).
- Keychain item `exists` but manifest `absent` → report before continuing; the item is
  reused as the keystore passphrase.

**Step 2: create the keychain item (only if absent).** Service `dev.czar.signer.keystore`
(`signer.keychainService`), account `keystore` (`apps/signer/src/passphrase.ts:49`).
`security` prompts for the passphrase because `-w` is the last option with no value:

```sh
security add-generic-password -s dev.czar.signer.keystore -a keystore -w
```

**Step 3: create the keys.** `create-keys.ts` reads the keychain item itself and never
asks in the terminal; if the item is absent it fails with `keychain-missing` before
writing anything.

```sh
fnm exec --using=22.22.0 node --disable-warning=ExperimentalWarning --experimental-strip-types apps/signer/scripts/create-keys.ts --local
fnm exec --using=22.22.0 node --disable-warning=ExperimentalWarning --experimental-strip-types apps/signer/scripts/create-merchant-keys.ts --local --service czar-search
```

- The first command creates K3, K5, K6, K7, K8, relayer and K20
  (`create-keys.ts:28-36`) and writes `deployments/local-keys.json` (gitignored).
- The second adds `K10:czar-search` to the keystore and manifest and refuses to create
  it twice (`create-merchant-keys.ts:42-62`).
- `create-keys.ts` prints full addresses on stdout (`create-keys.ts:169-171`). Do not
  copy that output anywhere.
- If either command fails, keep the keystore and manifest as they are for inspection;
  do not rerun it.

**Report back only:** each command's exit code; `manifest written: yes/no`; the role
names present, checked with the command below (role names only, never addresses, refs,
tokens or passphrase).

```sh
node -e 'const m=require("./deployments/local-keys.json");console.log(Object.keys(m).filter(k=>m[k]&&m[k].address).join(","))'
```

Expected: `K3,K5,K6,K7,K8,relayer,K20,K10:czar-search`.

## Start and readiness

For the clean chain, start the existing stack from the repository root:

```sh
fnm exec --using=22.22.0 process-compose -f ops/local/process-compose.yaml up
```

For the browser journey, start the fork overlay with the base process graph from the
repository root. The graph starts Arc Anvil, the local deployment, Postgres, the
stand-ins, indexer, signer, server, merchant, mock bundler, and web app. Keep this
terminal open while using the browser:

```sh
CZAR_LOCAL_MODE=fork fnm exec --using=22.22.0 process-compose \
  -f ops/local/process-compose.yaml -f ops/local/process-compose.fork.yaml up
```

`CZAR_LOCAL_MODE=fork` is required for the fork overlay. The clean command above needs no
mode (the default is `clean`). The chain-session launcher refuses a mismatch: clean mode on
a fork node, or fork mode on a clean node, stops before anything starts.

### Chain sessions (SCR-151)

Both local chains are ephemeral: every `arc-anvil` start is a new chain. The indexer,
server, signer and merchants therefore start through `ops/local/chain-session.mjs`, which:

- checks the local node before writing or starting anything: loopback RPC,
  `anvil_nodeInfo`, chain ID 5042002, and in fork mode the pin file
  `deployments/.arc-fork-pin.json` (decimal strings; `forkBlock` must equal the node's fork
  block; `indexerStartBlock` must be after `forkBlock` and not past the head);
- starts the indexer at block 0 in clean mode, and in fork mode at `indexerStartBlock`:
  the first successful Czar deployment receipt block, recorded by `ops/local/deploy.sh`
  through `ops/local/record-start-block.mjs` (SCR-151 amendment A1);
- derives the session key `S` from the first 8 hex characters of that block's hash, and
  routes all four processes to database `czar_<mode>_<S>`. Ponder uses the same name as its
  schema (`DATABASE_SCHEMA`). The database is created only when absent and is never dropped;
- records the session in ignored `deployments/.arc-chain-session.json`. The indexer starts
  first and records it; the server, signer and merchants refuse to start if the live node
  gives a different `S` (amendment A2).

Restarting one process on the same running chain reuses its session database. A fresh
chain, or a new fork pin, gets a new `S` and new databases; earlier ones stay until you
remove them yourself.

**Cleanup (operator only, never automatic).** List the session databases, then drop the
ones you no longer need **by explicit name**, never by pattern:

```sh
docker compose -f ops/local/compose.yaml exec -T postgres \
  psql -U postgres -Atc "SELECT datname FROM pg_database WHERE datname LIKE 'czar\_%' ORDER BY datname"
docker compose -f ops/local/compose.yaml exec -T postgres dropdb -U postgres czar_fork_<S>
```

Do not drop the session database of a stack that is running.

The fork launcher checks Arc testnet chain ID, pins the first run at latest block minus
100, and checks nonempty code at that block for EntryPoint, the wallet's MSCA factory,
and USDC. It stores the pin and reason in ignored `deployments/.arc-fork-pin.json`.
Restarting reuses that pin while historical state remains available and those contracts
are unchanged. A new pin requires a recorded reason and a browser-flow rerun from
Part A. The launcher logic is `ops/local/fork-anvil.mjs` (`FORK_BLOCK_OFFSET = 100n`;
checked addresses in `FORK_CODE_ADDRESSES`: EntryPoint
`0x0000000071727De22E5E9d8BAf0edAc6f37da032`, Circle MSCA factory
`0x0000000DF7E6c9Dc387cAFc5eCBfa6c3a6179AdD`, USDC
`0x3600000000000000000000000000000000000000`).

**Pin: recorded at first bring-up in `reports/local-flow-<date>.md`; not yet observed.**
Every fork-flow report records the pin with the `build-v1` and `local-v1` SHAs and the
`arc-anvil` version and checksum. This runbook never carries a block number.

The fork funding helper accepts only loopback Arc Anvil with chain ID 5042002 and
`anvil_nodeInfo`. Use the owner smart account address returned by the browser before
vault creation. Resolve service addresses from the ignored key manifest locally; do
not copy full addresses into committed reports. Supply an existing fork USDC holder
with at least 10 USDC for the vault transfer. Each command applies a fixed amount:

```sh
fnm exec --using=22.22.0 node ops/local/fund-fork.mjs --owner-native '<owner-smart-account-address>'
# Service keys (manual loop; reads the ignored manifest locally and never echoes addresses).
# Roles accepted by fund-fork.mjs: K3 K5 K6 K7 K20 relayer K10:czar-search (fund-fork.mjs:7).
for role in K3 K5 K6 K7 K20 relayer K10:czar-search; do
  addr=$(node -e 'const m=require("./deployments/local-keys.json");process.stdout.write(m[process.argv[1]].address)' "$role")
  fnm exec --using=22.22.0 node ops/local/fund-fork.mjs --service-native "$role" --address "$addr"
done
fnm exec --using=22.22.0 node ops/local/fund-fork.mjs --vault-usdc '<vault-address>' \
  --usdc-holder '<holder-address>'
```

The owner receives 1 native unit before vault creation, each service key receives
10 native units, and the vault receives 10 USDC (`fund-fork.mjs:4-6`). These changes
affect fork state only.

Choosing the USDC holder is manual: no script selects one. Pick an address with at least
10 USDC on the fork from recent USDC transfers (pin block minus a range), then confirm its
balance before funding:

```sh
arc-cast logs --rpc-url http://127.0.0.1:8545 --from-block <pin-minus-2000> --to-block <pin> \
  --address 0x3600000000000000000000000000000000000000 'Transfer(address indexed from,address indexed to,uint256 value)'
arc-cast call --rpc-url http://127.0.0.1:8545 0x3600000000000000000000000000000000000000 \
  'balanceOf(address)(uint256)' '<candidate>'
```
Run the health gate after deployment and before browser acceptance. `health.sh` is the
**fork-mode** gate: it checks the fork pin, mock bundler and web app, so in clean mode
those lines report `FAIL` by design. In clean mode use the process-compose readiness
probes (`ops/local/process-compose.yaml`) plus `curl --fail http://127.0.0.1:3000/health`
and `curl --fail http://127.0.0.1:8787/health`.

The health output includes the SCR-151 lines `chain session: mode=<m> S=<8hex>
startBlock=<n>`, `indexer start: <n>` (it must equal the session and, in fork mode, the
pin's `indexerStartBlock`), `database: czar_<mode>_<S> reachable`, and the indexer lag
against `indexer.maxLagBlocks` (120). The session and database lines also apply in clean
mode.

```sh
fnm exec --using=22.22.0 bash ops/local/health.sh
```

Record the binary identity used for a run with `arc-anvil --version` and
`shasum -a 256 "$(command -v arc-anvil)"`. If it differs from the version and checksum
recorded in earlier evidence, record the change explicitly before comparing runs.

Do not begin a browser flow until every `ops/local/health.sh` check reports `OK`. The
check must cover Postgres, server migrations, chain ID and fork block, deployment
manifest and fork contract code, stand-ins, mock bundler, signer K3, merchant K10,
indexer lag, `/v1/app/wallet-config`, and the web page. A server that has not finished
migrations or merchant K10 lookup is not ready.

The existing compose graph waits for Postgres before the server, and the server's
`/health` follows migrations. Before the merchant listens, `merchant-k10-ready`
resolves `K10:czar-search` through the signer socket. An absent K10 is a startup
failure, not a reason to bypass that check.

After health passes in fork mode, open `http://localhost:3001/onboarding` in Safari or
Chrome. Use `localhost`, never `127.0.0.1`, because the passkey relying-party ID is `localhost`. On the Mac mini (no Touch ID) the browser uses the Mac login
password with Safari/iCloud Keychain or the Chrome profile PIN. The app receives its
wallet configuration from `GET /v1/app/wallet-config`; the local values point to the
mock bundler at `127.0.0.1:4337`, Arc Anvil at `127.0.0.1:8545`, and the server at
`127.0.0.1:3000`.

For the Claude Code portion, install the workspace in the `local-v1` checkout first.
Then stay in the Claude Code project directory so the daemon writes its result file
there. Point the CLI and local overlay to the same checkout:

```sh
export CZAR_CHECKOUT=/Users/zar/.codex/worktrees/build-v1-local/czar_v0
export CZAR_LOCAL_CONFIG="$CZAR_CHECKOUT/env/local.toml"
export CZAR_DAEMON_SERVER_ORIGIN=http://127.0.0.1:3000
# Once, in a separate terminal kept open: start the daemon so its memory database and
# keychain key exist (cli.ts `daemon`; pairing fails with "Czar memory is not initialized"
# otherwise, cli.ts:80).
fnm exec --using=22.22.0 node "$CZAR_CHECKOUT/apps/daemon/src/cli.ts" daemon
# Then, from the Claude Code project directory:
fnm exec --using=22.22.0 node "$CZAR_CHECKOUT/apps/daemon/src/cli.ts" pair '<8-digit-code>'
fnm exec --using=22.22.0 node "$CZAR_CHECKOUT/apps/daemon/src/cli.ts" objective '<goal>' \
  --capability web-search --kind table-fill --subject '<name>' --field '<field>'
fnm exec --using=22.22.0 node "$CZAR_CHECKOUT/apps/daemon/src/cli.ts" result '<objectiveId>'
```

Use the exact objective text and subjects in Part C of the demo flow. The absolute
CLI entry point and local overlay path were verified from another directory; real
pairing and submission wait for the healthy stack and browser flow.

## Command sources

| Step | Source checked on `local-v1` + `build-v1` 984be3f |
|---|---|
| Key creation flags and refusals | `apps/signer/scripts/create-keys.ts`, `create-merchant-keys.ts` |
| Keychain service and account | `packages/config/src/registry.ts` `signer.keychainService`; `apps/signer/src/passphrase.ts:49` |
| Clean and fork process graphs | `ops/local/process-compose.yaml`, `ops/local/process-compose.fork.yaml` |
| Chain session, database routing, indexer start block | `ops/local/chain-session.mjs`, `ops/local/record-start-block.mjs`, `ops/local/deploy.sh` |
| Fork pin and contract checks | `ops/local/fork-anvil.mjs` |
| Funding | `ops/local/fund-fork.mjs` |
| Health gate (fork) | `ops/local/health.sh` |
| Mock bundler origins | `process-compose.fork.yaml` `CZAR_MOCK_BUNDLER_CORS_ORIGINS` |
| CLI commands and env | `apps/daemon/src/cli.ts`, `apps/daemon/src/server-origin.ts`, `apps/daemon/README.md` |
| Pairing code format | 8 digits (`apps/daemon/src/pairing/pair-device.ts:62`) |
| Sidecar | `apps/redact-sidecar/pyproject.toml`, `apps/daemon/src/cli.ts` `sidecarCommand` |

## Evidence, logs, and stop

The fork browser journey is the exact Parts A–G and P1–P10 sequence in
`docs-internal/demo_tests/track-a-exit-flow.md`. The six clean runs are listed in
SCR-146 §3.3. Put each exact one-line command, PASS or FAIL, log link, base SHA,
`arc-anvil` version and checksum, mode, and date in its run report. Do not treat
hosted Actions billing failures as passes.

Keep key addresses truncated in committed logs and reports. Exclude keystore paths,
passphrases, device tokens, goal text, and merchant payloads. For the fork flow, record
transaction hashes, screenshots, CLI status, and the full health output without those
secrets. The daemon writes results in the Claude Code project under `.czar/results/`;
the web app shows receipt, envelope, and balance, not result content.

Stop the stack with `process-compose`'s normal shutdown, then stop local Docker
services with `docker compose -f ops/local/compose.yaml down`. Do not remove the
keystore, ignored manifest, deployment manifest, or evidence while investigating a
failed run.
