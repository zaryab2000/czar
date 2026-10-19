# Vendored gitleaks v8.30.1 (MIT)

- `gitleaks.toml`: `config/gitleaks.toml` at tag `v8.30.1`, 222 rules (C2-06). sha256 `e163e53b9e7e8a8511e77271e2b323ed057759542a6d988258afe3a1fa329caf`, checked by `scripts/compile-rules.ts` on every build.
- `corpus.json`: the true- and false-positive samples that gitleaks's own rule generator (`cmd/generate/config/rules/*.go`) validates each rule against, plus the secret gitleaks reports for each true positive. Samples are base64-encoded. Recorded with `tools/extract-gitleaks-corpus/` from the Go module `github.com/zricethezav/gitleaks/v8@v8.30.1` (verified by the Go checksum database).
  - 220 rules have samples. `dropbox-long-lived-api-token` and `dropbox-short-lived-api-token` have none upstream.
  - 5 path-gated rules use path samples and do not apply to plain text: `freemius-secret-key`, `hashicorp-tf-password`, `kubernetes-secret-yaml`, `nuget-config-password`, `pkcs12-file`.
- `LICENSE`: the gitleaks MIT licence.
- The fake secrets in this folder are excluded from the repository secret scan by `.gitleaks.toml`.
