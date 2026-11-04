# Czar parallel production plan: the 6 November start

- **From:** chief architect, for Zaryab, the production manager and the Codex Lane Orchestrator
- **Answers:** "Request to the senior architect: the parallel production plan" (4 November 2026)
- **Delivered:** with SCR-170 (`docs/specs/06-review/change-requests/SCR-170-public-alpha-cloud-deployment.md`) and 20 builder prompts (`docs/production/builder-prompts/`)
- **Builders start:** 6 November 2026, 12:00 IST, once Zaryab merges this PR at the 10:00 review

---

## Summary

- **20 builder tasks (21 tracker items) can start on 6 November in five lanes,** without touching any file the agent social network reserves, any contract, the payer, the planner or selection.
- **The candidate list was wrong in five material places:**
  1. The signer read model is already built.
  2. There is no testnet deployment recorded in the repository.
  3. The plugin has nothing to feed, because the daemon's observation pipeline is unbuilt.
  4. The MCP server depends on routes that must mount in a reserved file.
  5. Most of the house supply, including the "bad" merchants, is already specified and needs no AI.
- **SCR-170 settles the cloud shape now:**
  - one VM, every process on loopback, Caddy as the only public listener
  - secrets only as files
  - new entry files, so the local launchers stay untouched
  - the shared-file rules for the parallel window
- **What you must do by 6 November, 10:00 IST:**
  - merge this PR, which accepts SCR-170 and records PM-001
  - send the testnet deployment record (§5)
  - ask the collaborator to push `social/integration` so overlap checks can run

---

## Section 1: verification summary

### 1.1 Heads read (4 November 2026, about 15:00 IST)

| Branch | Head | Note |
|---|---|---|
| `build-v1` | `d9fb168` (merge of #188, Flow 4A completion report) | unchanged since 31 October |
| `social/integration` | **does not exist on `origin`** | no fork exists either; the collaborator works locally or has not pushed |
| `docs/social-network-handoff` (PR #190) | `7579fcf`, **open, not merged** | the collaborator's brief, and its two delegations, are not yet recorded on `build-v1` |

### 1.2 What the social work has touched

- **Nothing visible.** No branch, PR or fork exists on GitHub.
- **Consequence:** this plan protects every path in your §3.1, plus spec-change numbers SCR-164 to SCR-169 and migrations `0023` to `0029` (SCR-170 §7).
- **Check rule:** before merging any production PR into `prod/integration`, the orchestrator runs:

  ```sh
  git ls-remote origin refs/heads/social/integration
  # if it exists:
  git fetch origin social/integration
  git diff --name-only origin/build-v1...origin/social/integration > /tmp/social-files
  git diff --name-only origin/prod/integration...HEAD | grep -Fxf /tmp/social-files
  ```

  - Any output means stop: that PR moves to "wait".

### 1.3 Corrections to the facts in your §2

| Your statement | What the code says | Effect on the plan |
|---|---|---|
| "The signer Projection interface has no implementer; the indexer has no frozen, guardianPaused or limits projections" | **Wrong.** `apps/signer/src/postgres-projection.ts` implements every `Projection` method. `freezeState` reads `frozen()` and `guardianPaused()` and the limits straight from the vault on chain. It is wired in `apps/signer/src/local-main.ts:60`. No indexer projection is needed | PM-024 shrinks to a half-day cloud audit (start list) |
| "The testnet contracts are already deployed" | **Not recorded in the repo.** `deployments/` holds only `local-keys.example.json`, and `contracts/broadcast` is git-ignored. The only chain-5042002 broadcast runs in my workspace are local arc-anvil runs (the local chain reuses chain id 5042002) | PM-010 needs your broadcast file; it also checks the deployed bytecode against today's build |
| "The server binds to `127.0.0.1`; make the listen address configurable" | True, but changing it is the wrong fix. Loopback plus a reverse proxy on the same host is the safer shape | **PM-015 is closed as not needed** (SCR-170 §1) |
| (implied) the stack can be containerised as-is | **No production entry point exists.** Server, signer, indexer and merchants each start only through `start:local`. `local-main.ts` refuses a non-localhost `app.origin`, and the signer `main.ts` refuses any backend but `local-keystore`. Both are deliberate | New task **PM-059**: cloud entry files, without touching the local launchers |
| "The plugin uses the daemon's existing hook and command interfaces" | The hook server exists, but its event handler only counts events (`apps/daemon/src/daemon.ts:84`); nothing maps, stores or acts on them. Mapping (T-063), soul compiler (T-066), drives (T-068) and publisher (T-069) are unbuilt. The plugin task T-062 is also gated on host checks G0-11 and G0-17, which are not recorded | **PM-032 waits.** The host checks start now (new PM-060). The alpha's demand entry is `czar objective` plus the browser "New task" path (SCR-179) |
| "The MCP server folder is empty, so it is safe" | It depends on T-071 (`createQuote`, `reportOutcome`, `createPayRequest`), new server routes that mount in `app.ts` (reserved). Its `pay` tool is a money path. SCR-132 moved both into the evidence and social replan | **PM-033 waits** for the social merge |
| "Only Czar Search exists; build Page Reader, Vulnerability Lookup, Chain Data, Explainer, Budget Explainer" | CZ-20 already specifies `czar-spot` and `czar-extract` (T-051), six lab merchants with deliberate behaviour profiles (T-106), and the job test provider (T-108). The lab's flaky, slow, schema-breaking, drifting and payee-swapping merchants are the "bad merchants", and they need no AI | PM-042 and PM-043 are re-scoped to the specified services. The AI merchants and Vulnerability Lookup wait for SCR-178 and a model |
| "Treasury drip and sweep-back: no change to payment code" | The drip needs a key that sends USDC: a new signer key kind and policy. Czar-service refunds send USDC from K10, while CZ-27 lets K10 sign only seller proofs and sweep burn intents, and the refund spec still writes "posterior" rows that Flow 4A removed | **PM-047 is design-only** (SCR-177) |
| "Job specialists, tested against local doubles" | Their keys K21a and K21b, and the `provider-call` policy, are specified in CZ-27 but **not implemented** in `apps/signer/src/kinds.ts` | New task **PM-058** (signer) before PM-046's integration test |
| "Signer KMS backend" | `gcp-kms` is already the reserved backend name (`apps/signer/src/backend.ts:7`) and the stage-2 spec (GC-2). There is no Google SDK in the lockfile | PM-017 calls Cloud KMS over REST with metadata-server tokens: no new dependency, no lockfile conflict |
| "Add production keys in one contiguous block in `registry.ts`" | Workable, but a separate file is cleaner. The spec-coverage test checks spec → registry only, so new keys need no spec edit | New file `registry-production.ts`, spread into `PARAMETERS` with a two-line edit (SCR-170 §7). Built first, as PM-061 |
| "Passkey RP ID hard-coded" | True (`apps/server/src/app/auth.ts:23`). `auth.ts` already receives `config` and `origin`. The RP ID derived from the default `app.origin = http://localhost` is `localhost` | PM-016 needs no new key and no `app.ts` edit, but it does need migration `0030`: `app_passkeys.rp_id` has `CHECK (rp_id = 'localhost')` (`0007-app-passkeys.sql:21`). Local behaviour is identical |
| Migration range "0030+" | Safe. `migrate.ts` applies by filename and tolerates gaps | Production uses `0030` to `0049`. Only PM-016 needs one (`0030`) |

---

### 1.4 Independent review applied

- A fresh reviewer checked this plan, SCR-170 and every prompt against the code on 4 November. All of its findings are fixed in this version. The main ones:
  - **Security:** with host networking, every container could reach the metadata server and sign with any KMS key directly. SCR-170 §4 now limits metadata access to the signer's user and root, gives the signer its own user, and adds a group-access socket option that is off by default.
  - **Would have blocked builders:**
    - the key name `deploy.secretsDir` is refused by the loader's secret-name rule (renamed `deploy.credentialFilesDir`)
    - the passkey table pins `rp_id = 'localhost'` (PM-016 now owns migration `0030`)
    - the indexer always runs the local-only guard (an additive cloud branch is now ruled)
    - `ponder start` needs an explicit schema (`public`)
    - `validateCloudConfig` cannot see the chain id from config (it now takes `chainId` and `rpcUrls`)
    - the new `deploy` section trips the spec-coverage test (PM-061 adds `deploy.sh` to `NON_PARAMETERS`)
  - **Behaviour and correctness:**
    - lab and provider routes would have started in the local merchant process, because `merchants.lab.enabled` and `merchants.provider.enabled` default to `true`. They are now registered only by the cloud entry and tests.
    - socket tokens are keychain-only (file identity ruled)
    - KMS pocket keys were lost on restart (recovery added)
    - the VM needs the `cloud-platform` scope
    - the gas-low alert used a log field the allowlist drops (`keyId` now)
    - the compose start order was wrong
    - the deployment-file shape was wrong
    - PM-021's request mapping was wrong
- **Not verified by the reviewer:** the server's 606-test baseline (no Postgres in its sandbox; I measured 606 on `ca106fd`; `d9fb168` adds only a report and a change to an excluded chain test), and the model id `claude-haiku-5-5` (needs a live call).

## Section 2: the start list for 6 November, 12:00 IST

### 2.1 Lanes at a glance

| Lane | Area | Tasks, in order (parallel where noted) |
|---|---|---|
| **A** | Cloud operations (`ops/cloud/**`, `deployments/`) | PM-061 first (shared foundation, owned by lane A), then **PM-011/012 ∥ PM-013 ∥ PM-010**, then PM-014, then PM-052 ∥ PM-051 |
| **B** | Signer | PM-017, then PM-058, then PM-024 |
| **C** | Server (non-reserved files only) | PM-016 ∥ PM-021, then PM-059 |
| **D** | Daemon and host checks | PM-037 ∥ PM-060, then PM-035, then PM-034 |
| **E** | House supply (`apps/merchants`) | PM-042, then PM-043; PM-046 in parallel with a second builder |

- **PM-061 merges first.**
  - It is half a day of work, with no behaviour change.
  - Every task that adds a config key rebases on it, so the five lanes never edit `registry.ts` again.
  - Until it merges, the other lanes write tests and code that need no new keys.

### 2.2 Task rows

| ID | Title | Lane | Scope | Files and folders | Shared-file touches | Conflict risk | Depends on | Acceptance tests | Done when | Days |
|---|---|---|---|---|---|---|---|---|---|---|
| **PM-061** (new, Phase 1) | Config foundations for production | A (first) | `registry-production.ts` with every SCR-170 §8 key; `validateCloudConfig`; `env/cloud.example.toml` | `packages/config/src/registry-production.ts`, `packages/config/src/cloud-only.ts`, `packages/config/test/cloud-only.test.ts`, `env/cloud.example.toml` | `registry.ts`: import + spread (2 lines, top of file); `index.ts`: 1 export line; `non-parameters.ts`: `deploy.sh` entry; dump snapshot regenerated | low: the social work adds keys inside `PARAMETERS`, far from line 7 | SCR-170 merged | `cloud-only.test.ts` (each refusal rule); `loader.test.ts` snapshot; config suite 66+ green; typecheck, lint | Every SCR-170 key loads with its default and `validateCloudConfig` refuses each bad case | 0.5 |
| **PM-011 + PM-012** | Cloud machine, firewall, secrets unit and Caddy, as code (no deploy) | A | `gcloud` provisioning script (dry run by default); cloud-init; firewall; `czar-secrets.service`; Caddyfile for `app.` and `merchants.` | `ops/cloud/provision/*`, `ops/cloud/caddy/Caddyfile`, `ops/cloud/systemd/*`, `ops/cloud/README.md`, `ops/cloud/test/*` | none | low: new folder | SCR-170, PM-061 | `provision.test` (dry run prints exactly the expected commands); `caddy validate`; `shellcheck`; secrets-unit test (fake metadata server, files written 0400) | `ops/cloud/provision/create.sh --dry-run` prints the full, reviewed command list and nothing runs without `--apply` | 2 |
| **PM-013** | Container images for server, signer, indexer, merchants, web | A ∥ | One Dockerfile per app; non-root; pinned base digest; no secrets; healthcheck | `ops/cloud/docker/*.Dockerfile`, `.dockerignore` (new, repo root) | none | low | PM-061 | each image builds; `check-no-secret-files` over each image's file list; container runs as non-root; healthcheck command exits 0 against a started process | Five images build reproducibly and contain no secret-pattern files | 1.5 |
| **PM-010** | Record the testnet deployment and verify its bytecode | A ∥ | `deployments/arc-testnet.json` from Zaryab's broadcast record; read-only check that each address's code matches today's build (immutables masked) | `deployments/arc-testnet.json`, `ops/cloud/verify-deployment.ts`, `ops/cloud/test/verify-deployment.test.ts` | none | low | **Zaryab sends the broadcast file** (§5, item 2) | verify script against a local arc-anvil deploy (match) and a modified build (mismatch); one read-only run against `rpc.testnet.arc.io` with the output pasted | The file is committed and the verifier reports match or mismatch per contract on testnet (read-only) | 1 |
| **PM-014** | Cloud stack startup (docker compose) | A | Compose file with host networking, healthchecks, secrets mounts, start order postgres → indexer → server → signer → merchants (as `ops/local/process-compose.yaml`) | `ops/cloud/compose.yaml`, `ops/cloud/compose.smoke.yaml`, `ops/cloud/test/compose.test.ts` | none | low | PM-013, PM-059, PM-017 | `docker compose config` valid; the smoke profile starts Postgres + server cloud entry against a local arc-anvil and `/health` answers | `compose.smoke.yaml` brings the server up healthy locally with cloud config | 2 |
| **PM-052** | Nightly database backup and restore drill | A ∥ | `pg_dump` to Cloud Storage with metadata token; systemd timer; restore-drill script | `ops/cloud/backup/*` | none | low | PM-011/012 | drill test: migrate a fresh DB, insert rows, dump, restore into a new DB, row counts equal; upload tested against a fake storage endpoint | A local drill passes end to end and the timer unit validates | 1 |
| **PM-051** | Uptime, resource and low-gas alerts | A ∥ | GCP uptime checks for `app.` and `merchants.` `/health`; Ops Agent config; log-based alert on the signer's `signer_gas_low` log event; one email channel | `ops/cloud/monitoring/*` | none | low | PM-011/012, PM-017 (log event) | dry-run script prints exact `gcloud monitoring` commands; a log-filter test matches the signer's real log line | Alert definitions are code, reviewed, and apply with one command after approval | 1 |
| **PM-017** | Signer `gcp-kms` backend and signer cloud entry | B | `SignerBackend` over Cloud KMS REST (sign digest, sign transaction, address, create and destroy K4); restart recovery of K4 pocket keys; metadata-token auth; file-based socket identity and the group-access socket option (`signer.socketGroupGid`, unset = today); `cloud-main.ts`; gas-low alert as a structured log event with `keyId` | `apps/signer/src/gcp-kms-backend.ts`, `apps/signer/src/gcp-auth.ts`, `apps/signer/src/cloud-main.ts`, `apps/signer/test/gcp-kms-backend.test.ts`, `apps/signer/test/cloud-main.test.ts` | keys already in PM-061 (`signer.kms.*`) | low: signer is not in flight | PM-061 | fake-KMS tests (low-s, v, recovery, tx sender, 4xx/5xx/timeout → nothing signed); the full signer policy suite re-run against the KMS backend; run 2 (`test/local-chain.test.ts`) 20/20 | The signer signs every existing kind through the KMS backend in tests with identical policy outcomes | 3 |
| **PM-058** (new, Phase 4) | Signer: K21a/K21b test-provider keys and the `provider-call` policy | B | Key ids K21a, K21b; kind `provider-call` exactly per CZ-27 (`setBudget`, `submit`, `brief-request`, `deliverable-upload`; own jobs; evaluator K7 only) | `apps/signer/src/kinds.ts`, `policy.ts`, `service.ts` (as needed), `apps/signer/test/provider-call.test.ts` | none | low | PM-017 merged (same package) | tests first: each allowed action signs; wrong escrow, other provider, non-K7 evaluator, `submit` without an accepted upload hash → `kms_denied`; run 2 green | `provider-call` behaves exactly as CZ-27's table says, under both backends | 2 |
| **PM-024** (re-scoped) | Signer projection: cloud audit | B | Confirm every `Projection` method has a fresh-enough source in the cloud shape; DB grants for the signer role on indexer tables; fail-closed tests where missing | `apps/signer/test/*` (tests only), audit note in the PR body | none | low | PM-017 | missing fail-closed tests added and green | Audit note lists each method, its source and freshness, with no gaps | 0.5 |
| **PM-016** | Passkey RP ID from `app.origin` | C ∥ | Replace the `RP_ID` constant with the host of `app.origin`, the same function as `wallet-config.ts` | `apps/server/src/app/auth.ts`, `apps/server/src/app/wallet-config.ts` (export the helper), `apps/server/test/app-auth*.test.ts`, `apps/server/migrations/0030-passkey-rp-id-host.sql` | migration `0030` (production range) | low: not reserved, and not in `app.ts` | none | tests first: origin `https://app.example.com` → challenge, registration and session use RP ID `app.example.com` and reject `localhost` authenticator data; default config → `localhost` exactly as today; server suite and web unit suite green (the passkey e2e needs an external chain, an M8 item) | With default config every existing auth test passes unchanged; with a cloud origin the RP ID follows it | 1 |
| **PM-021** | Anthropic `ModelClient` adapter (not wired) | C ∥ | `fetch`-based Messages API adapter implementing `ModelClient`; prompt-size guard; timeout and abort; usage mapping | `apps/server/src/models/anthropic.ts`, `apps/server/test/models/anthropic.test.ts` | keys in PM-061 (`models.provider`, `models.anthropic.*`) | low: new file; no call site changes | PM-061 | fake HTTP server tests: success, 4xx, 5xx → `upstream-unavailable`, timeout, abort, oversize prompt refused before any request, no key → refuses; key read from file, never logged | The adapter passes its tests and nothing in the server imports it except tests | 1.5 |
| **PM-059** (new, Phase 1) | Production entry points: server, merchants, indexer | C | `apps/server/src/cloud-main.ts`; `apps/merchants/src/cloud-main.ts`; the additive `ponder.config.ts` branch; DB password from file; model adapter injected only when `models.provider = anthropic` | the three files + tests in each app's `test/` | none | medium: imports `main.ts` (not reserved; must not edit it) | PM-016, PM-021, PM-061, PM-017 (file socket identity), PM-042 (merchant composition function) | `cloud-main` refuses every `validateCloudConfig` failure; starts against a local Postgres + arc-anvil with a cloud-shaped config (https origins faked by an allowlist test override) and `/health` answers; the local launchers' tests unchanged | Each app starts from its cloud entry in tests with no change to any local entry | 3 |
| **PM-037** | Uninstall keeps K14 when memory is kept | D ∥ | Delete the memory key only with `deleteMemory`; device token and hook token still removed | `apps/daemon/src/install.ts`, `apps/daemon/test/install.test.ts` | none | low | none | tests first: `deleteMemory=false` keeps K14 and the memory folder; `true` removes both; K15/K16 removed in both cases | Reinstall after keep-memory uninstall opens the old memory database | 0.5 |
| **PM-060** (new, Phase 3) | Host checks G0-11 and G0-17 | D ∥ | Run the two recorded gate checks; write their result files | `docs/specs/05-build-plan/gate-0-results/G0-11.md`, `G0-17.md` (new files only) | new files under `gate-0-results/` (allowed by SCR-170 §7) | low | none | each check's pass condition from `gate-0-checks.md`, with commands and output pasted | Both results recorded as confirmed or changed, with date and source | 0.5 |
| **PM-035** | Daemon on Linux (systemd user service) | D | `systemd.ts` beside `launchd.ts`; platform dispatch in `install.ts`; XDG paths on Linux; macOS path byte-identical | `apps/daemon/src/systemd.ts`, `apps/daemon/src/install.ts`, `apps/daemon/src/paths.ts`, tests | none | low | PM-037 (same file) | tests first: Linux install writes the unit, `systemctl --user` calls in order; uninstall reverses; macOS tests unchanged; keychain-unavailable on headless Linux → plain message, daemon Locked | `czar install` works on Linux in a test container with a Secret Service, and macOS behaviour is unchanged | 2 |
| **PM-034** | Daemon npm package build (no publish) | D | Bundle the CLI to JavaScript; publishable package manifest generated into `dist/`; native modules external; `npm pack` | `apps/daemon/scripts/build-npm.mjs`, `apps/daemon/npm/*` (template), `apps/daemon/package.json` (one script + one dev dependency) | `pnpm-lock.yaml` (esbuild, pinned) under the lockfile rule | medium: lockfile | PM-035 | `npm pack` tarball installs into a temp prefix on macOS and Linux; `czar --version` and `czar status` run; tarball has no `.ts` source, no secret-pattern file | A tarball built from a clean checkout installs and runs on both systems | 2 |
| **PM-042** (re-scoped to T-051 part A) | Merchants `czar-spot` and `czar-extract` (vanilla x402) | E | Both handlers and routes per CZ-20 §5.1; spot source per the PM-041 ruling with synthetic fallback; extract through `safeFetch` (D84); index entries | `apps/merchants/src/spot/*`, `apps/merchants/src/extract/*`, merchants runtime registration, tests | `merchants.spot*` / `merchants.extract*` keys exist; new spot-source keys in PM-061's lane E section | low: `apps/merchants` not in flight | PM-061 | T-051's vanilla tests: valid 402s; `source` always present; private ranges refused; any public https page fetched; index items validate (02 §12.2) | Both services sell correctly behind x402 in the merchant test suite | 2.5 |
| **PM-043** (re-scoped to T-106) | Test-merchant lab: six behaviour profiles | E | The six CZ-20 §5.8a services under `/lab/<service>/`; seeded profiles; sources per PM-041; index entries flagged `czar-test-merchant` | `apps/merchants/src/lab/*`, `apps/merchants/src/lab/corpus/*`, tests | `merchants.lab.<service>.*` keys in lane E section | low | PM-042 | T-106's five acceptance tests | All six profiles hit their seeded rates and never vary by buyer | 3 |
| **PM-046** (re-scoped to T-108, minus testnet) | Job test provider `czar-provider` (two instances) | E ∥ (second builder) | CZ-20 §5.11 loop; all seven behaviour modes; one deterministic placeholder work mode; signer client injected | `apps/merchants/src/provider/*`, tests (unit + arc-anvil against `MockCzarJobEscrow`/`MockCircleAgenticCommerce`) | `merchants.provider.*` keys in lane E section | low | PM-061; PM-058 for the signing integration test | T-108's tests that run on the mock, (the ratings-model listing check moves to PM-045); a dummy work mode added by a test touches only `provider/` | Each behaviour mode produces its effect on the mock, signed through the real `provider-call` policy | 3 |

### 2.3 Rulings made inside this plan (recorded here, folded into SCRs later)

- **PM-041: the free public data sources.** `merchants.labSources = ["czar-fixture-search-corpus", "czar-public-domain-pages", "coinbase-public-spot"]`.
  - **`czar-spot`** (D49):
    - The public source is Coinbase's keyless public spot endpoint `GET https://api.coinbase.com/v2/prices/{BASE}-{QUOTE}/spot`, cached `merchants.spotRefreshSeconds` (300).
    - The fallback is the deterministic synthetic series with `source: "synthetic-testnet"`.
    - The builder confirms at build time that the endpoint is keyless and its terms allow this use. If not, use Kraken's public `GET https://api.kraken.com/0/public/Ticker`, and record which.
    - Confidence: moderate.
  - **Lab search services:** the existing Czar-hosted fixture corpus (`apps/merchants/src/search/index-data.ts`). No network.
  - **Lab extract services:** a new bundled corpus of 20 short pre-1929 public-domain texts and US-government pages, saved as fixtures in `apps/merchants/src/lab/corpus/`. No live fetching.
  - **`lab-spot-payee-swap`:** the `czar-spot` cache.
- **OD-41 for the alpha (partial):** PM-046 ships only the deterministic placeholder work mode that T-108 already allows. The AI work modes (Fix-It, Research Brief) are SCR-178.
- **T-108 acceptance under the ratings model:**
  - "After seeding, both instances have `n_eff(delivery) ≥ 5` and appear in `ranked[]`" is replaced by: "with no ratings, both instances appear in `RankingDecision.unverified[]` with reason `unrated`; seeded honest jobs produce settled observations with `delivered = 1`."
  - Flow 4A removed `n_eff` ranking.
  - This check needs the server, payer and indexer together, which `apps/merchants` tests do not have, so it runs in PM-045 (job path on testnet), not PM-046.

---

## Section 3: the wait list

| ID | Task | Unblocked by |
|---|---|---|
| PM-015 | Server listen address from config | **Closed: not needed** (SCR-170 §1) |
| PM-018 | Create the robot keys in KMS and register them | PM-007 (Google Cloud project) + PM-017 merged + **Zaryab's approval for key creation** |
| PM-019 | Real Circle testnet services | PM-008 (Circle Developer Console) + PM-059 merged; Gateway parts also SCR-177 |
| PM-020 | Background app talks to the cloud server | First deployment (approval) + PM-016 + PM-059 |
| PM-022 | Exit test: full loop from Zaryab's Mac against the cloud | PM-018 + PM-019 + PM-020 + testnet funds (approval) |
| PM-023 | Fix the shared payment robot key | SCR-171 accepted (due 8 Nov) + PM-002 decision; contract change and testnet redeploy (approval) |
| PM-025 to PM-028 | Isolation audit, rate limits, invite gate, global caps, kill switch | SCR-172 accepted (due 9 Nov) + **the social PR merged** (these add middleware and routes in `app.ts`) |
| PM-029 | Narrower passkey owner powers | SCR-173 (with SCR-171, due 8 Nov); contract part ships in the PM-023 redeploy |
| PM-030 | Privacy wording in product copy | SCR-174 accepted (due 7 Nov); web copy after the social merge |
| PM-031 | Emergency-pause and factory-admin keys off the Mac, two approvers | PM-018 + approval |
| PM-032 | Claude Code plugin | PM-060 results + SCR-179 accepted (due 10 Nov) + the observation chain T-063 (a feature, not production) |
| PM-033 | Local MCP tool server | **The social PR merged** + T-071 server routes (SCR-132 replan); a money path, tests first |
| PM-036 | Python redaction helper packaging | SCR-175 accepted (due 8 Nov) |
| PM-038 | Codex plugin | PM-032 done |
| PM-039 | Browser-only "New task" | PM-005 decision + SCR-176 accepted (due 9 Nov) + **the social PR merged** (web and objectives routes) |
| PM-040 | Exit test: a friend installs in 10 minutes | PM-034 + PM-035 + a published package (npm account approval) |
| PM-043 (AI part) | Explainer and Budget Explainer AI merchants | SCR-178 accepted (due 8 Nov) + PM-021 + model approval |
| PM-044 | Gateway nano merchant routes; Gateway path on testnet | SCR-177 (sweeps, K10 policy) + PM-042 + deployment |
| PM-045 | Job path on testnet, including the T-108 ratings-model listing check (§2.3) | PM-046 + PM-058 + deployment (GC-9a public host) + K21 gas (approval) |
| PM-047 | Treasury drip and sweep-back | SCR-177 accepted (due 8 Nov), then a signer key kind and a new service |
| PM-049, PM-050 | Public feed, house seed representatives | **The social PR merged** |
| PM-053 | "How to try Czar" guide | PM-034, PM-039 and SCR-176 settled (draft due 12 Nov) |
| PM-054 | "What data leaves your machine" note | SCR-174 (draft due 8 Nov) |
| PM-055, PM-056 | Final two-person test; open sign-ups | Everything above, plus PM-023 |

---

## Section 4: design-only work (spec change requests)

| SCR | Decision it records | Tracker | Ready |
|---|---|---|---|
| **SCR-170** | Cloud deployment shape; production entry points; secrets as files; DB roles and backups; model provider adapter; parallel-window rules (numbers, migrations, registry file, lockfile, batching) | PM-001, PM-011–017, PM-021, PM-051, PM-052, PM-059, PM-061 | **Delivered with this plan** |
| SCR-171 | Shared agent signer → options: one K3 per vault (factory issues per-vault signer, signer derives key per vault) vs on-chain limits on agent-opened envelopes (payee-root binding to an owner-signed policy); recommendation; testnet redeploy and migration plan | PM-002, PM-023 | 8 Nov |
| SCR-172 | Public-alpha safety: per-user isolation audit method, rate-limit buckets, invite codes, global spend caps, one kill switch | PM-025–028 | 9 Nov |
| SCR-173 | Passkey owner powers: which `executeOwnerAction` calls need a second confirmation or a delay; contract part rides the SCR-171 redeploy | PM-029 | 8 Nov (with SCR-171) |
| SCR-174 | Privacy wording now that the operator sees TaskSpec subjects and up to 2,000 characters of context; exact copy for onboarding, daemon and the tester note | PM-030, PM-054 | 7 Nov |
| SCR-175 | Python redaction helper: bundle with `uv` (T-064), optional add-on, or container; the regex-only fallback and its forced review | PM-036 | 8 Nov |
| SCR-176 | Browser "New task": TaskSpec entry in the web app, what is redacted where, and how it differs from daemon objectives (D82) | PM-039 | 9 Nov |
| SCR-177 | Treasury: the drip key kind and caps; Gateway sweep destination; Czar-service refunds under the ratings model (remove posterior rows); the K10 send policy | PM-047, PM-044, T-051 part B | 8 Nov |
| SCR-178 | Supply beyond CZ-20: Explainer, Budget Explainer, Vulnerability Lookup; job work modes Fix-It and Research Brief (OD-41) | PM-043 (AI), PM-046 (work modes) | 8 Nov |
| SCR-179 | The observation chain (T-063, T-066, T-068, T-069, T-062) as a feature track; the alpha ships with `czar objective` and browser "New task" as its demand entry | PM-032, PM-038 | 10 Nov |

- All production SCRs use numbers 170 to 189 (SCR-170 §7).
- Edits that SCRs order to the spec documents are applied in one docs PR after the social PR merges.

---

## Section 5: Zaryab's approvals and inputs

| # | What | Latest date | Blocks |
|---|---|---|---|
| 1 | Merge this PR (accepts SCR-170, which is PM-001) | **6 Nov, 10:00 IST** | every start-list task |
| 2 | Send the testnet deployment record: `contracts/broadcast/Deploy.s.sol/5042002/run-latest.json` from the machine that deployed, or the addresses plus the deploy commit | **6 Nov, 12:00 IST** | PM-010 |
| 3 | Ask the collaborator to push `social/integration` (no merge needed) | **6 Nov, 12:00 IST** | the overlap check in §1.2 |
| 4 | Merge PR #190 (the social brief) or confirm its two delegations in writing | 6 Nov | the collaborator's spec and merge authority |
| 5 | PM-005: browser "New task" in alpha scope (recommended: yes) | 7 Nov | SCR-176 |
| 6 | PM-003: macOS and Linux now, Windows later | 8 Nov | PM-035 merge into `build-v1` |
| 7 | PM-002: robot-key fix choice, after reading SCR-171 | 10 Nov | PM-023 |
| 8 | PM-006: buy the domain | 10 Nov | Caddy certificates, passkeys on the real RP ID |
| 9 | PM-007: Google Cloud account and project (card for the credit) | 10 Nov | VM, KMS, Secret Manager, Storage |
| 10 | PM-008: Circle Developer Console account | 12 Nov | PM-019 |
| 11 | PM-009 + PM-004: Anthropic account, separate projects, hard monthly limit | 12 Nov | live model wiring |
| 12 | An npm account or organisation for the daemon package | 14 Nov | publishing PM-034 |
| 13 | Key creation in Cloud KMS (PM-018) | 13 Nov | registering keys |
| 14 | Testnet funds for K3, K7, K8, relayer, K10 per service, K21a/K21b | 14 Nov | first testnet run |
| 15 | First deployment to the VM (`create.sh --apply`, then compose up) | 14 Nov | PM-020, PM-022 |
| 16 | Connecting the model provider live (`models.provider = anthropic`) | 15 Nov | AI merchants, boundary screen, planner prompts |
| 17 | Contract redeploy on testnet for SCR-171/173 | 18 Nov | PM-023, PM-029 |

---

## Section 6: builder prompts

- One file per approved task in `docs/production/builder-prompts/`. Each file is complete: common rules, scope, files, keys, tests first, acceptance, branch and report.

| File | Task |
|---|---|
| `PM-061-config-foundations.md` | PM-061 |
| `PM-011-012-cloud-machine-and-proxy.md` | PM-011, PM-012 |
| `PM-013-container-images.md` | PM-013 |
| `PM-010-testnet-deployment-record.md` | PM-010 |
| `PM-014-cloud-compose.md` | PM-014 |
| `PM-052-backups.md` | PM-052 |
| `PM-051-alerts.md` | PM-051 |
| `PM-017-signer-gcp-kms.md` | PM-017 |
| `PM-058-signer-provider-call.md` | PM-058 |
| `PM-024-signer-projection-audit.md` | PM-024 |
| `PM-016-passkey-rp-id.md` | PM-016 |
| `PM-021-anthropic-model-client.md` | PM-021 |
| `PM-059-cloud-entry-points.md` | PM-059 |
| `PM-037-uninstall-keeps-memory-key.md` | PM-037 |
| `PM-060-host-checks.md` | PM-060 |
| `PM-035-daemon-linux.md` | PM-035 |
| `PM-034-daemon-npm-package.md` | PM-034 |
| `PM-042-merchants-spot-extract.md` | PM-042 |
| `PM-043-test-merchant-lab.md` | PM-043 |
| `PM-046-job-test-provider.md` | PM-046 |

### 6.1 Branches and merging (for the orchestrator)

- Cut `prod/integration` from `build-v1` at `d9fb168` or later.
- Each task works on `prod/<PM-id>-<slug>` and opens a PR into `prod/integration`.
- The orchestrator merges a task PR when its acceptance tests and the existing suites pass and the §1.2 overlap check is empty.
- Keep `prod/integration` current by **merging** `build-v1` into it, never rebasing.
- **Weekly batch PR** `prod/integration` → `build-v1`; Zaryab merges. The first batch targets 12 November.
  - Whichever of the social PR and a batch lands second merges `build-v1` in and re-runs every suite.
- Never push to or force-push `build-v1`.

---

## Section 7: tracker updates

| ID | Change | New status / phase | Owner | Note |
|---|---|---|---|---|
| PM-001 | Recorded as SCR-170; approve by merging this PR | todo → in-progress | Zaryab | approval at 6 Nov 10:00 |
| PM-010 | Stays start-now; depends on Zaryab sending the broadcast record; adds bytecode verification | start now | Builder (lane A) + Zaryab input | |
| PM-011, PM-012 | Merged into one prompt; code only, no deploy | start now | Builder (lane A) | |
| PM-013 | Images live in `ops/cloud/docker/` | start now | Builder (lane A) | |
| PM-014 | Depends on PM-059 and PM-017 | start now (after deps) | Builder (lane A) | |
| PM-015 | **Closed: not needed** (loopback + Caddy) | done (closed) | Architect | SCR-170 §1 |
| PM-016 | Moved from "needs check" to start now; no new key, no `app.ts` edit | start now | Builder (lane C) | |
| PM-017 | Start now; includes signer cloud entry and gas-low log alert | start now | Builder (lane B) | |
| PM-021 | Start now; adapter only, not wired | start now | Builder (lane C) | wiring is PM-059 + approval |
| PM-024 | **Re-scoped:** the projection exists; half-day cloud audit | Phase 2 → start now | Builder (lane B) | |
| PM-030 | Design-only (SCR-174); copy changes wait | wait | Architect | due 7 Nov |
| PM-032 | **Moved to wait:** observation chain unbuilt; host checks first | wait | Builder | SCR-179 |
| PM-033 | **Moved to wait:** needs T-071 routes in `app.ts` (reserved) | wait | Builder | after the social merge |
| PM-034 | Build and pack only; publish needs an npm account | start now | Builder (lane D) | |
| PM-035 | Start now; shipping on Linux needs PM-003 | start now | Builder (lane D) | |
| PM-037 | Start now | start now | Builder (lane D) | |
| PM-041 | **Ruled in this plan** (§2.3) | done | Architect | |
| PM-042 | **Re-scoped** to T-051 part A: `czar-spot`, `czar-extract` | start now | Builder (lane E) | Page Reader = `czar-extract`; Chain Data = `czar-spot`; Vulnerability Lookup → SCR-178 |
| PM-043 | **Split:** T-106 lab (six profiles, no AI) starts now; AI Explainer merchants wait for SCR-178 + model | start now (lab) / wait (AI) | Builder (lane E) | the lab is the "bad merchant" set |
| PM-046 | **Re-scoped** to T-108 without testnet; placeholder work mode | start now | Builder (lane E, second builder) | |
| PM-047 | **Moved to design-only** (SCR-177) | wait | Architect | money path |
| PM-051, PM-052 | Start now, code only | start now | Builder (lane A) | |
| PM-053 | Draft after PM-034/PM-039 settle | wait | Architect | 12 Nov |
| PM-054 | Draft after SCR-174 | wait | Architect | 8 Nov |
| **PM-057** | **New, Phase 6:** apply the production SCRs' spec edits in one docs PR after the social merge | new, wait | Architect | |
| **PM-058** | **New, Phase 4:** signer K21a/K21b and `provider-call` policy | new, start now | Builder (lane B) | |
| **PM-059** | **New, Phase 1:** production entry points for server, merchants, indexer | new, start now | Builder (lane C) | |
| **PM-060** | **New, Phase 3:** host checks G0-11 and G0-17 | new, start now | Builder (lane D) | |
| **PM-061** | **New, Phase 1:** config foundations (`registry-production.ts`, `validateCloudConfig`) | new, start now (first) | Builder (lane A) | |
| **PM-062** | **New, Phase 3:** observation chain T-063 → T-066 → T-068 → T-069 as a feature track | new, wait | Architect + Builder | SCR-179 |
| **PM-063** | **New, Phase 4:** T-051 part B: Gateway routes, sweeps, Czar-service refunds | new, wait | Builder | SCR-177 |
