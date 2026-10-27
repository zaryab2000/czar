# Manual objective runbook

`czar objective` runs on macOS with an initialized daemon memory database and a paired
device. Start the daemon, then use `czar pair <code>` before submitting an objective.

Install the local redaction sidecar from the repository root:

```sh
uv sync --project apps/redact-sidecar --frozen
```

The CLI starts that environment's `czar-redact` launcher on demand. Installed bundles
may provide `czar-redact` on `PATH`. If the sidecar is unavailable, the CLI shows the
redacted goal and requires an interactive `y` before submitting. Without a terminal,
it exits before sending anything.

```sh
czar objective "Find current prices" --subject Acme --field price
```

At `awaiting-approval`, the command prints the plan ID and `/approve/<planId>` path,
then keeps polling until a terminal status. When that status has a `resultId`, it
writes the result in the project's `writeback.dir` (default `.czar/results/`),
acknowledges it, and prints the file path. `czar result <objectiveId>` resumes
polling an existing objective or repeats write-back for a final one.
