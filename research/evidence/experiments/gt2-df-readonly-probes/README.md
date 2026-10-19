# gt2 D–F read-only probes (2026-10-18)

No wallets, no keys, no payments, no logins. Read-only HTTP calls and npm tarball reads only.

## What was run
1. **Circle Discovery API** (keyless, mainnet catalog), 2026-10-18T14:18Z and 14:27Z:
   - `GET https://api.circle.com/v2/x402/discovery/resources?limit=5` → `raw/discovery-limit5.{json,headers}` (cookie header removed)
   - Filter checks → `raw/discovery-status.txt` and `raw/discovery-*.json`
2. **GitHub API** (unauthenticated `curl`, and `gh api` with a non-owner personal token):
   - list stargazers, stargazer count, star history, list subscribers, GraphQL `stargazers`, repo events → `raw/gh-*`
3. **Circle CLI source diff**: `npm pack @circle-fin/cli@{1.2.0,1.2.1,1.2.2} --ignore-scripts`, then rebuilt sources from each tarball's `dist/index.js.map` (`sourcesContent`) with `unmap.py` (run as `python3 -I unmap.py <map> <outdir>`), then `diff -ru` → `raw/cli-1.2.0-to-1.2.2.diff`

## Results (short)
- Discovery: same fields as part 1; `category=DATA_ENRICHMENT` still 400; `scheme=upto` still 400; `sort` still ignored (same alphabetical order); `type=mcp` total 0; total 2,858.
- GitHub: list stargazers 401 unauthenticated and 404 for a non-owner token; GraphQL `stargazers.totalCount` = 0 while `stargazerCount` = 155; `/stargazers/count` and `/stargazers/history` work unauthenticated; repo events still show `WatchEvent` with actor login (57 of last 100 events on facebook/react).
- CLI 1.2.2 adds `upto` scheme and Permit2 payment support, `--payment-id`, per-offer inspect output, and switches the Arc testnet default RPC to `https://rpc.testnet.arc.io`. Policy commands still reject testnets.

## Transaction hashes
None (no transactions).
