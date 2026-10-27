# Re-recording the gitleaks corpus

Run only when the pinned gitleaks version changes (a spec change).

1. Copy the module source: `cp -r "$(go env GOMODCACHE)/github.com/zricethezav/gitleaks/v8@v8.30.1" /tmp/glx && chmod -R u+w /tmp/glx`.
2. Apply `validate.go.patch` to `cmd/generate/config/utils/validate.go`: `Validate` records each rule's samples and the secrets the single-rule detector reports.
3. Save `main.go.txt` as `cmd/extract/main.go` (it calls every rule constructor and prints the recordings as JSON).
4. `cd /tmp/glx && go run ./cmd/extract > corpus-raw.json`, then base64-encode each sample into `vendor/gitleaks-v8.30.1/corpus.json` (fields `rule`, `pathRule`, `truePositives[{text, secrets}]`, `falsePositives`).
