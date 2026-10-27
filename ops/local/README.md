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
  `uv sync --project apps/redact-sidecar --frozen`. The daemon starts it on demand;
  it is not a compose service. If it is unavailable, `czar objective` requires an
  interactive confirmation of the redacted goal before submission.
- The local T-105 keychain entries and ignored `deployments/local-keys.json` must exist
  before stack startup. `deployments/local-keys.example.json` is a template, never a
  deployment input. Do not paste key creation output into a report or chat.

## Operator key creation

Zaryab runs these commands in his terminal, from the `local-v1` checkout, after the
local wiring is ready. The commands create local keystore entries and update the ignored
manifest. The macOS keychain controls the passphrase; never put it in an argument,
environment variable, log, or committed file.

Before the first command, Zaryab creates a password item in macOS Keychain Access:
item name `dev.czar.signer.keystore`, account `keystore`, and a passphrase he chooses
and keeps private. `create-keys.ts` reads this item through the keychain API; it does
not ask for a passphrase in the terminal. If the item is absent, it fails with
`keychain-missing` before writing keys.

```sh
fnm exec --using=22.22.0 node --disable-warning=ExperimentalWarning --experimental-strip-types apps/signer/scripts/create-keys.ts --local
fnm exec --using=22.22.0 node --disable-warning=ExperimentalWarning --experimental-strip-types apps/signer/scripts/create-merchant-keys.ts --local --service czar-search
```

The first command refuses to overwrite an existing manifest or existing Phase 1 keys.
The second command adds `K10:czar-search` and refuses to create it twice. If either
command fails, preserve the keystore and manifest for inspection; do not rerun it
blindly. Never commit `deployments/local-keys.json` or keystore contents.

## Start and readiness

For the clean chain, start the existing stack from the repository root:

```sh
process-compose -f ops/local/process-compose.yaml up
```

For the browser journey, start the fork overlay with the base process graph from the
repository root. The graph starts Arc Anvil, the local deployment, Postgres, the
stand-ins, indexer, signer, server, merchant, mock bundler, and web app. Keep this
terminal open while using the browser:

```sh
process-compose -f ops/local/process-compose.yaml -f ops/local/process-compose.fork.yaml up
```

The fork launcher checks Arc testnet chain ID, pins the first run at latest block minus
100, and checks nonempty code at that block for EntryPoint, the wallet's MSCA factory,
and USDC. It stores the pin and reason in ignored `deployments/.arc-fork-pin.json`.
Restarting reuses that pin while historical state remains available and those contracts
are unchanged. A new pin requires a recorded reason and a browser-flow rerun from
Part A. Copy the actual pin into this runbook after bring-up, and include it with the
`build-v1` SHA and `arc-anvil` version and checksum in every fork-flow report.

The fork funding helper accepts only loopback Arc Anvil with chain ID 5042002 and
`anvil_nodeInfo`. Use the owner smart account address returned by the browser before
vault creation. Resolve service addresses from the ignored key manifest locally; do
not copy full addresses into committed reports. Supply an existing fork USDC holder
with at least 10 USDC for the vault transfer. Each command applies a fixed amount:

```sh
node ops/local/fund-fork.mjs --owner-native '<owner-smart-account-address>'
node ops/local/fund-fork.mjs --service-native K3 --address '<K3-address>'
node ops/local/fund-fork.mjs --service-native K5 --address '<K5-address>'
node ops/local/fund-fork.mjs --service-native K6 --address '<K6-address>'
node ops/local/fund-fork.mjs --service-native K7 --address '<K7-address>'
node ops/local/fund-fork.mjs --service-native K20 --address '<K20-address>'
node ops/local/fund-fork.mjs --service-native relayer --address '<relayer-address>'
node ops/local/fund-fork.mjs --service-native K10:czar-search --address '<K10-address>'
node ops/local/fund-fork.mjs --vault-usdc '<vault-address>' --usdc-holder '<holder-address>'
```

The owner receives 1 native unit before vault creation, each service key receives
10 native units, and the vault receives 10 USDC. These changes affect fork state only.
Run the health gate after deployment and before browser acceptance:

```sh
bash ops/local/health.sh
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
Chrome. Use `localhost` for the passkey relying-party ID. The browser uses the Mac login
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
fnm exec --using=22.22.0 node "$CZAR_CHECKOUT/apps/daemon/src/cli.ts" pair '<8-digit-code>'
fnm exec --using=22.22.0 node "$CZAR_CHECKOUT/apps/daemon/src/cli.ts" objective '<goal>' \
  --capability web-search --kind table-fill --subject '<name>' --field '<field>'
fnm exec --using=22.22.0 node "$CZAR_CHECKOUT/apps/daemon/src/cli.ts" result '<objectiveId>'
```

Use the exact objective text and subjects in Part C of the demo flow. The absolute
CLI entry point and local overlay path were verified from another directory; real
pairing and submission wait for the healthy stack and browser flow.

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
