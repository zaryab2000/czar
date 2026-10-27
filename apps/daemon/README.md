# Manual objective runbook

`czar objective` runs on macOS with an initialized daemon memory database and a paired
device. Start the daemon, then use `czar pair <code>` before submitting an objective.

From a Claude Code project directory, use the CLI source in a Czar checkout where
`pnpm install --frozen-lockfile` has completed. Keep the shell in the project
directory so result files are written there. Set `CZAR_LOCAL_CONFIG` to the
`env/local.toml` in that same checkout; the local HTTP origin guard requires this
exact path. The local stack serves Czar on port 3000:

```sh
export CZAR_CHECKOUT=/absolute/path/to/czar_v0
export CZAR_LOCAL_CONFIG="$CZAR_CHECKOUT/env/local.toml"
export CZAR_DAEMON_SERVER_ORIGIN=http://127.0.0.1:3000

fnm exec --using=22.22.0 node "$CZAR_CHECKOUT/apps/daemon/src/cli.ts" pair '<8-digit-code>'
fnm exec --using=22.22.0 node "$CZAR_CHECKOUT/apps/daemon/src/cli.ts" objective \
  "Find current prices" --subject Acme --field price
fnm exec --using=22.22.0 node "$CZAR_CHECKOUT/apps/daemon/src/cli.ts" result '<objectiveId>'
```

The workspace install does not provide a root `node_modules/.bin/czar` launcher;
the absolute CLI source path is the supported invocation from another project.

Install the local redaction sidecar from the repository root:

```sh
uv sync --project apps/redact-sidecar --frozen
```

The CLI starts that environment's `czar-redact` launcher on demand. Installed bundles
may provide `czar-redact` on `PATH`. If the sidecar is unavailable, the CLI shows the
redacted goal and requires an interactive `y` before submitting. Without a terminal,
it exits before sending anything.

At `awaiting-approval`, the command prints the plan ID and `/approve/<planId>` path,
then keeps polling until a terminal status. When that status has a `resultId`, it
writes the result in the project's `writeback.dir` (default `.czar/results/`),
acknowledges it, and prints the file path. `czar result <objectiveId>` resumes
polling an existing objective or repeats write-back for a final one.
