# Tier 1 build report

- **Branch:** `build-v1`, cut from `main` at the start of this session. No PR, no push to `main`.
- **Date:** 2026-10-19. **Builder:** Claude (Czar builder agent).
- **Scope:** the 11 tier-1 tasks: T-001, T-002, T-003, T-004, T-005, T-008, T-010, T-030, T-060, T-064, T-080. Tier 2 has not started.
- **Spec changes:** none. Spec problems are filed as SCR-101 to SCR-106 in `specs/06-review/change-requests/`. That folder is the one this assignment named; the template names `specs/05-build-plan/scr/`.

## Summary

| Task | Status | Main output |
|---|---|---|
| T-001 Repo scaffold | done | pnpm workspace, strict `tsconfig.base.json`, oxlint/oxfmt, `.gitignore`, `CLAUDE.md` |
| T-002 CI | done | `.github/workflows/ci.yml`, `secrets.yml`, `dependabot.yml` |
| T-003 Contracts toolchain | done (hardfork pin open, SCR-101) | `scripts/install-arc-foundry.sh`, `contracts/foundry.toml`, OZ 5.7.0, 7 interfaces |
| T-004 `@czar/config` | done (6 keys without spec defaults, SCR-103) | `packages/config` |
| T-005 `@czar/logging` | done | `packages/logging` |
| T-008 `@czar/redaction` layer 1 | done | `packages/redaction` |
| T-010 Contract test mocks | done | `contracts/test/mocks/*.sol`, `contracts/test/MockSelfTest.t.sol`, fault-injecting RPC proxy |
| T-030 Indexer setup | done (keyed fallback URL open, SCR-104) | `apps/indexer` |
| T-060 Daemon skeleton | done, needs device | `apps/daemon` |
| T-064 Presidio helper | done, needs device | `apps/redact-sidecar`, `scripts/bundle-redact-sidecar.sh`, layer-2 client |
| T-080 Web app scaffold | done | `apps/web` |

## How to check it

- `pnpm install --frozen-lockfile`
- `pnpm lint && pnpm -r typecheck && pnpm -r test`
  - `pnpm -r lint typecheck test`, as written in the assignment, makes pnpm run the `lint` script with `typecheck test` as its arguments. Run the three commands above instead; lint is a root script, because oxlint and oxfmt run once over the whole repo.
- `cd apps/redact-sidecar && uv sync --frozen && uv run pytest -q`
- `scripts/install-arc-foundry.sh && cd contracts && FOUNDRY_PROFILE=arc arc-forge build --deny-warnings --sizes && FOUNDRY_PROFILE=arc arc-forge test`
- Local results at the last commit:
  - Vitest: logging 11, config 24, redaction 473, daemon 34 (plus 1 skipped without a bundle), indexer 10, web 17. All passed.
  - pytest: 14 passed.
  - The Chromium Playwright project passed locally (3 tests).
  - The daemon integration test against the real bundle passed locally.
  - `actionlint`: 0 findings. `zizmor --persona pedantic`: 0 findings. `shellcheck`: clean on both scripts.
- **Contracts:** Arc Foundry could not run in this container.
  - The proxy blocks GitHub release pages.
  - My attempt to build it from source was refused by this session's permission rules.
  - So `arc-forge build` and `arc-forge test` run only in CI (jobs `contracts (ubuntu-24.04)` and `contracts (macos-15)`).
  - Locally, all mock and interface sources compiled with solc-js 0.8.30 (prague, optimizer) with 0 errors and 0 warnings.
- **CI status:** see the last section.

---

## T-001 Repo scaffold

- **Status:** done.
- **Acceptance criteria:**
  - `pnpm install --frozen-lockfile` succeeds. ✔
  - `pnpm -r exec tsc --noEmit` (here `pnpm -r typecheck`) and `pnpm oxlint` pass with 0 warnings. ✔ (`oxlint --deny-warnings`)
  - `git ls-files | grep -E '\.key$|\.key\.json$|\.env'` prints nothing. ✔ Also enforced in CI by `scripts/check-no-secret-files.mjs`.
- **Notes:**
  - ESM only.
  - Every strict flag is on, including `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `noPropertyAccessFromIndexSignature`.
  - `.npmrc` sets `ignore-scripts=true`, `save-exact=true` and `engine-strict=true`. `pnpm-workspace.yaml` sets `minimumReleaseAge: 1440`.
  - Absolute imports: packages import each other as `@czar/*` through pnpm workspace links. Relative `..` imports are a lint error (`no-restricted-imports`).
  - Empty package folders for later tasks hold `.gitkeep`.
  - Packages export TypeScript sources directly. Node ≥ 22.18 strips types natively, so there is no build step, and `erasableSyntaxOnly` keeps the code strippable.

## T-002 CI

- **Status:** done.
- **Acceptance criteria:**
  - `actionlint .github/workflows/` and `zizmor .github/workflows/` report 0 findings. ✔ (zizmor is also clean in pedantic mode). Both run in the `workflows` CI job.
  - A planted fake key fails the secret job, and removing it passes. ✔, but tested locally rather than on a test branch:
    - The assignment allows pushes to `build-v1` only.
    - A planted key committed to `build-v1` would stay in the history the scan reads, and break it for good.
    - So I ran the same scan (`gitleaks git --redact --exit-code 1`) in a throwaway worktree. A commit with a fake AWS key exited 1; the same history without it exited 0.
- **Notes:**
  - Every action is pinned to a full SHA with a version comment, with `persist-credentials: false`, `permissions: {}` at the top level and per-job `contents: read`.
  - gitleaks v8.30.1 and actionlint v1.7.12 are built with `go install`, so the Go checksum database verifies them. zizmor 1.31.1 runs through `uvx`.
  - Dependabot covers npm, GitHub Actions and uv, with a 7-day cooldown and grouped updates.
  - **History findings:** 6 gitleaks hits already on `main` are false positives (bytes32 `jobKey` values in spec examples, idempotency UUIDs in experiment logs, a contract address in research notes). They are listed by fingerprint in `.gitleaksignore`, along with false positives from this branch (config registry entries whose field is named `key`).
  - `.gitleaks.toml` extends the default rules and excludes only the vendored gitleaks test corpus and the rules compiled from it (T-008).
  - Fork-PR and merge-queue gaps are out of scope.

## T-003 Contracts toolchain

- **Status:** done. The `--hardfork` pin is open (SCR-101).
- **Acceptance criteria:**
  - `shellcheck scripts/install-arc-foundry.sh` is clean. ✔ Running it twice is idempotent: the CI step runs it twice, and the second run sees the commit and exits early. ✔
  - `arc-anvil --version` shows commit `d497beea…`. ✔ The script fails the install if it does not.
  - `cd contracts && arc-forge build --deny-warnings` compiles the 7 interface files. CI only (see the note above).
  - `diff -r contracts/src/interfaces specs/03-smart-contracts/interfaces` shows no differences. ✔ Also a CI step.
- **Pinned digests** (`scripts/arc-foundry.sha256`). Every download must match both this file and the release `.sha256`.
  - `arc-foundry-v0.8.0-2-aarch64-apple-darwin.tar.gz`: `90e3eefbf7dd80652fd283a7562e9263301a48797bc2224cc21a3964e2d5db87`. This matches the A9-13 fragment `90e3eefb…db87`, so A9-13 recorded the macOS archive.
  - `arc-foundry-v0.8.0-2-x86_64-unknown-linux-gnu.tar.gz`: `088bdb96a84418b757f9825d491e702792f1d1d1e29a9145af305a6600a79556`. First seen in CI; there is no independent record of it (SCR-102).
- **Notes:**
  - `foundry.toml`: solc 0.8.30, `evm_version = "prague"`, optimizer on, `deny_warnings = true`, `[profile.arc] network = "arc"`. The optimizer run count is Foundry's default (200), because the spec only says "optimizer on".
  - OpenZeppelin is a git submodule at `v5.7.0` (`cab19933c33c2ad1d4c7a84864a3601dddfd16f3`). forge-std is at `v1.17.0` (`f3dae6e6ee381f25eb6a246f7da9b85c91a68219`), for tests.
  - **SCR-101:** Arc testnet's hardfork (`arc:zero6`, `arc:zero7` or `arc:zero8`) is recorded nowhere, and this container cannot reach `rpc.testnet.arc.io`. The pin is left unset, so arc-anvil runs the newest hardfork until the value is decided.
  - forge-lint runs on `src/` only. The mocks copy upstream code on purpose (`block.timestamp` checks, a string-to-`bytes32` cast), and forge-lint aborts the build on those lint warnings. Compiler warnings still fail the build.

## T-004 `@czar/config`

- **Status:** done. 6 keys have no default in the specs (SCR-103).
- **Acceptance criteria:**
  - `pnpm --filter @czar/config test` passes, including "unknown key → startup error" and "env overlay overrides a default". ✔
  - A grep of `S04/*.md` for parameter names finds 0 missing from the registry. ✔ (`test/spec-coverage.test.ts`)
    - It scans every backtick code span in `specs/04-components` for `section.name` tokens (sections are taken from the registry).
    - Non-parameters (socket methods, event names, file names, field paths) are listed with a reason in `src/non-parameters.ts`; wildcards are expanded.
  - The review-fix keys are present (`signer.*`, `fetch.*`, `payer.pullbackWindowBlocks`, `acceptance.deliverableRefetch*`, `screen.chunkOverlapChars`, `api.briefSignatureMaxAgeSeconds`). ✔
  - Any key or `CZAR_*` variable containing `passphrase`, `secret`, `private`, `mnemonic` or `seed` is refused. ✔ The error never echoes the value.
- **Notes:**
  - 295 parameters, each with its default, unit, reason and source line.
  - `vault.maxAuthorizationsPerReservation = 128` is read-only, and overriding it is an error.
  - Overlay order: defaults → environment file → `CZAR_<SECTION>_<KEY>`, as SCREAMING_SNAKE (`daemon.hookPort` → `CZAR_DAEMON_HOOK_PORT`).
  - Keys without a spec default are registered with `noDefault`, and reading one before it is set throws.
  - The environment-file format is not in the spec. The loader takes a flat JSON object (SCR-103).
  - `czar-config dump` and the daemon's `czar config dump` print one JSON line per parameter. A snapshot test pins the dump.
  - `kms.pocketKeyGraceHours` is superseded (RV-004) and is not registered.

## T-005 `@czar/logging`

- **Status:** done.
- **Acceptance criteria:**
  - `pnpm --filter @czar/logging test` passes the corpus test: goal text, soul text, file paths, emails and a merchant body are never emitted, and redaction markers are kept. ✔
  - The corpus also covers hook payloads, `StepResult` values, URL query strings and full IPs. Each item is placed in every field name, in child loggers and as the event name.
- **Notes:**
  - A field is emitted only if its name matches an allowlist rule and its value has that rule's shape (Czar ids, `Hash32`, addresses, `Amount6`, counts, durations, enum tokens, HTTP status, block numbers, origin host, model, prompt hash, markers). Everything else is dropped and counted in `droppedFields`.
  - URLs are reduced to the origin host. IPs are truncated to /24 or /48, including IP-literal hosts.

## T-008 `@czar/redaction` layer 1

- **Status:** done.
- **Acceptance criteria:**
  - `pnpm --filter @czar/redaction test` passes the vendored gitleaks test corpus. ✔
    - Every true positive becomes the right `[[R:S:<rule>]]` marker with no secret substring left, both with the rule alone and with all 222 rules.
    - No rule flags its own false positives.
    - Redacting twice changes nothing.
  - The package never calls trufflehog or any live verification. ✔ A grep test checks the layer-1 sources; a second check confirms the layer-2 client only opens a local Unix socket.
- **Notes:**
  - `vendor/gitleaks-v8.30.1/gitleaks.toml` is byte-identical to the tag (sha256 `e163e53b…9caf`, checked on every build), with its MIT licence alongside.
  - **Corpus provenance:**
    - gitleaks ships its rule samples as Go code. I recorded them by running gitleaks's own rule generator with a patched `Validate` (`tools/extract-gitleaks-corpus/`).
    - That gave 6,368 true and 342 false positives across 220 rules. `dropbox-long-lived-api-token` and `dropbox-short-lived-api-token` have no upstream samples, and 5 path-gated rules cannot fire on plain text.
    - Samples are stored base64-encoded.
  - **RE2 → JavaScript:** Node 22 has no scoped regex flags. `scripts/compile-rules.ts` translates each Go RE2 pattern exactly, failing the build on any construct it cannot translate. It expands `(?i)`, `(?i:…)` and `(?-i:…)`, keeps RE2's `.` and `\s`, and maps `\z`/`\A`, POSIX classes and named groups. The output is committed, and a test fails if it goes stale.
  - **Detection mirrors gitleaks `detectRule`:** keyword prefilter, `secretGroup` or first non-empty group, Shannon entropy (per code point over UTF-8 bytes, as gitleaks computes it), global and rule allowlists (`regexTarget`, AND/OR, stopwords), and the `gitleaks:allow` signature.
  - **Replaces the whole match:** cross-cutting §2 says layer 1 replaces every match. For some rules gitleaks reports only a fragment as the secret (`jwt-base64` reports 10 characters of a JWT), so replacing just the "secret" would leave most of the token visible. Overlapping matches merge into one span.
  - **Budget:** typical text runs under 20 ms per 10 KB (tested).
  - **Interfaces:** `markers.parse/validate`, `truncatePreservingMarkers`, and the layer-2 interface (`Layer2Client`, `analyze_anonymize` payload types) that T-064 implements.

## T-010 Contract test mocks

- **Status:** done.
- **Acceptance criteria:**
  - `arc-forge test --match-contract MockSelfTest` passes. CI only.
    - The USDC mock rejects a reused nonce, an expired authorization, and an `isValidSignature` that returns a wrong value, a short return or a revert.
    - The suite also covers the not-yet-valid bound, both `transferWithAuthorization` overloads, the `receiveWithAuthorization` payee check, pause, blacklist, and the domain separator: etched at `0x3600…` on chain 5042002, it equals the vectors' `USDC_5042002`.
  - The Czar ERC-8183 mock supports partial claims (`settledAmount`) and `claimRefund` from `Open`. ✔ Tests cover approve and settle claims, the refund of the remainder, the grace period for `Submitted`, and `complete` paying only the unsettled amount.
  - The fault-injecting JSON-RPC proxy returns `-32012` above 10,000 blocks and `-32014` at a seeded random rate. ✔ It lives in `apps/indexer/test/support/fault-rpc-proxy.ts` because T-030 is its user; it was committed with T-030.
- **Notes (each behaviour cites its fact id in a comment):**
  - **`MockUSDC3009`:** circlefin/stablecoin-evm `EIP3009.sol` and `SignatureChecker.sol` (A1-03, A1-08, A1-09, A1-20), with the revert strings copied.
  - **`MockGatewayWallet`:** evm-gateway-contracts @ `c21d2d2` `Deposits.sol` and `Delegation.sol` (A2-01, A2-02, A2-04, A2-05). Events and errors are copied.
  - **`MockGatewayMinter`:** `TransferSpecHashes.sol` lines 29–60 (A2-16).
  - **`MockCircleAgenticCommerce`:** the EIP reference implementation (`ERCs` @ `4dec821`) with the Circle testnet ABI (A4-05, A4-06, A4-09).
  - **`MockCzarJobEscrow`:** base-contracts `ERC8183.sol` @ `142e669`, including claims, hooks, payout receiver and pause.
  - **Differences from upstream:**
    - Constructors stand in for `initialize`.
    - The reentrancy guard is OZ's storage `ReentrancyGuard` instead of `ReentrancyGuardTransient`, because solc 0.8.30 warns on transient storage and the build denies warnings. Behaviour is the same.
    - Gateway burns and mints are reduced to controller-only test helpers.

## T-030 Indexer setup

- **Status:** done. The keyed fallback URL is not wired (SCR-104).
- **Acceptance criteria:**
  - Behind an RPC that returns `-32012` for wide ranges and `-32014` at random, a 50,000-block sync has no gaps, and every block range is covered once. ✔ (`test/sync-50k.test.ts`)
    - Locally it runs against an in-process fake chain.
    - In CI, job `indexer-arc-anvil` runs the same test against real `arc-anvil --network arc --chain-id 5042002` with 50,001 mined blocks behind the proxy.
  - A restart mid-sync resumes from the checkpoint. ✔ (`test/ponder-resume.test.ts`)
    - It runs real `ponder start` through the production transport, SIGKILLs it a quarter of the way through a 50,000-block backfill, and restarts it.
    - It asserts that no request after the restart starts at block 0, and that every log is indexed exactly once.
- **Notes:**
  - **`src/rpc/arc-transport.ts`** is the viem transport handed to Ponder:
    - Pages `eth_getLogs` to `indexer.getLogsBlockRange` (9,999).
    - Halves a page on `-32012`.
    - Retries `-32014`, HTTP 429/5xx and network failures with backoff from 250 ms, up to 6 retries.
    - Then fails over to the second URL for 300 s (`indexer.failoverHoldSeconds`).
  - `ponder.config.ts` has the `arcTestnet` chain (5042002, `https://rpc.testnet.arc.io`, never `rpc.testnet.arc.network`) and `ethGetLogsBlockRange` 9,999. Every value comes from `@czar/config`.
  - **No contracts yet:** `deployments/arc-testnet.json` comes from T-027, which is not built. Projections are tier 3.
  - **SCR-104:** the keyed provider's URL holds an API key, and no spec names where it is stored or which provider to use. The failover path is built and tested; wiring the URL waits on that decision.
  - Ponder's live mode near the chain head is outside T-030's scope. The resume test ends its backfill 1,000 blocks below the head.

## T-060 Daemon skeleton (macOS only, D67)

- **Status:** done, needs device. Every OS call is injected; tests on Linux use a scripted `launchctl` and an in-memory keychain.
- **Acceptance criteria:**
  - `czar status` reports the installed state after `launchctl bootstrap gui/$UID <plist>`. ✔ With mocked launchctl.
  - Uninstall removes the agent and the keychain items. ✔ With mocks. Memory is kept unless `--delete-memory` is given.
  - A hook POST without the token, or with a foreign `Origin`, gets `401`. ✔ (real HTTP server on 127.0.0.1). Also tested:
    - `Origin: null` is accepted.
    - A non-loopback `Host` gets 401.
    - Oversize bodies get 413.
    - Locked gets 503; paused gets 202 with a discard count.
    - A busy port falls back to a free one.
  - The socket file mode is `0600`. ✔ (real Unix socket, created under umask `0177`, then `chmod 0600`)
  - The SQLite file cannot be opened without the keychain key. ✔ (real `better-sqlite3-multiple-ciphers` 13.0.3)
    - Opening it with no key or a wrong key fails.
    - No plaintext is on disk; the file header is not `SQLite format 3`.
    - File mode is 0600.
    - All 11 tables of CZ-02 §5.3 exist.
  - **Needs device:** the real `launchctl` round trip, the real macOS keychain, and the restart within 10 s after a kill (see the commands below).
- **Notes:**
  - **CLI install path only:** writes `~/Library/LaunchAgents/dev.czar.daemon.plist` and runs `bootstrap`, `kickstart -k` for updates and `bootout`; never `load`. `SMAppService` registration belongs to `Czar.app`, which no tier-1 task builds.
  - **Plist keys:** `Label`, `ProgramArguments`, `KeepAlive` true, `ProcessType` Background, `ThrottleInterval` 10 (one spawn per 10 s, stated explicitly), log paths under `~/Library/Logs/Czar/`, `WorkingDirectory`; no `RunAtLoad`.
  - **Keys:** K14 is created as 32 random bytes on first run. K16 is random at install. Both live in the keychain as service `dev.czar.daemon`, accounts `memory-db-key` and `hook-token` (CZ-02 §5.4), never on argv, in the environment or in logs.
  - **Cipher:** set explicitly to SQLCipher's AES-256 scheme, because the binding's default is ChaCha20 (SCR-105).
  - **Wording not in the spec:** "Czar is not installed." and "Czar is installed but not running." are not in CZ-02 §12. The rest follows §12. "Observing N tools · last activity…" needs intake (T-063) and prints only "Observing 0 tools" for now.
  - **Not in this task:** writing the free hook port and K16 into the plugin data config is T-062. Socket methods other than `status.get` arrive with their owning tasks. The daemon does not import `@czar/schemas` yet, because T-006 is tier 2.

## T-064 Presidio helper `czar-redact`

- **Status:** done, needs device. Built and tested on Linux; the macOS installer bundling and the clean-account check need a Mac.
- **Acceptance criteria:**
  - `uv run pytest -q` in `apps/redact-sidecar` passes the PII corpus: emails, phones, and names with contact details become `[[R:P:…]]`. ✔ 14 passed. Also a CI job.
  - With the helper stopped, the daemon uses the Node regex fallback and marks the objective for forced review (D45). ✔
    - `sidecarLayer2Client` returns `forcedReview: true` from `regexFallback` when the helper is down, times out, errors or rejects the language.
    - Tested with no socket, a mute socket and an error reply, and end to end against the real bundle after stopping it.
    - The objective itself is T-069, which consumes the flag.
  - The installed bundle runs on a clean macOS user account with no system Python. Needs device.
    - On Linux the same bundle ran with `env -i PATH=/nonexistent` (no system Python reachable) and redacted correctly.
    - In CI, job `redact-sidecar` builds the bundle and runs `apps/daemon/test/sidecar-integration.test.ts` with an empty environment.
- **Notes:**
  - **Helper:** Presidio 2.2.364 on spaCy 3.8.16 with `en_core_web_md` 3.8.0, all hash-pinned in `uv.lock` (`exclude-newer` 2026-10-18).
  - **Socket protocol:** JSON-RPC 2.0, newline-delimited, socket mode 0600, single method `analyze_anonymize`. Errors never echo text. Non-English input gets error `-32010`.
  - **Markers:** `[[R:P:<ENTITY>#n]]`, where `n` counts distinct values per entity type within one text. Presidio's custom operator produces the marker as the replacement.
  - **Bundle (`scripts/bundle-redact-sidecar.sh`):** uv-managed CPython 3.13.14, `--require-hashes` installs from `uv.lock`, and a launcher that runs the bundled interpreter with `-I`.
  - **Memory (SCR-106):** RSS with `en_core_web_lg` was 807 MB, double the 400 MB budget. `en_core_web_md` measures 397 MiB (416 MB); the bundle is 467 MB.
  - **Daemon supervisor (`apps/daemon/src/sidecar.ts`):** starts the helper lazily, restarts it with backoff at most 5 times a minute, and stops it after the idle period.
  - **Not built:** the `.pkg`/`.app` installer itself, signing and notarization, the entity allowlist (`redaction.entityAllowlist` has no field in the socket payload), and the review UI.

## T-080 Web app scaffold

- **Status:** done.
- **Acceptance criteria:**
  - The formatter gives `"880000"` → `$0.88` and `"1000"` → `$0.001`. ✔ BigInt only; rejects anything that is not an `Amount6`.
  - No other currency path exists: a grep for `fxSource` and for 30 ISO 4217 codes other than `USD` finds nothing in `apps/web`. ✔
  - The app loads and routes correctly in desktop Safari and Chrome (Playwright WebKit and Chromium at 1440×900). ✔ Chromium passed locally; both engines run in CI job `web-e2e`.
    - The checks: `/` → 200 with the shell, an unknown path → 404 page, and no manifest or service worker.
- **Notes:**
  - Next.js 16.4.2 with the App Router: root layout, placeholder home and not-found page; desktop CSS only.
  - Telemetry is disabled in every script. The app is served on `localhost` (D78).
  - The formatter lives in `apps/web/packages/money-format`, as the task says.

---

## Pinned versions and where each came from

- **Runtimes and package managers:**
  - **Node.js 22.22.0** (`.nvmrc`): this container's Node 22 LTS. ≥ 22.18 is required for type stripping and by the buyer SDK (p1-G13).
  - **pnpm 10.28.0:** this container's pnpm; `packageManager`.
  - **CPython 3.13.14** (bundle): the newest uv-managed 3.13 build listed by `uv python list` on 2026-10-19. The local venv uses the system's 3.13.16.
  - **uv 0.11.32:** this container's uv; pinned in CI.
- **TypeScript tooling (npm registry, 2026-10-19 unless noted):**
  - **TypeScript 6.0.3** (2026-04-16): the last JavaScript-based compiler. 7.x is the native port, and Next.js type checking still targets 6.x.
  - **vitest 5.0.5** (2026-10-15), **oxlint 1.88.0** and **oxfmt 0.73.0** (2026-10-13).
  - **@types/node 22.20.5:** the latest 22.x line, matching Node 22.
- **Chain and indexer:**
  - **viem 2.57.7** and **ponder 0.18.2** (A9-05; cross-cutting §7).
  - **hono 4.13.13:** the version Ponder resolves; used only by the resume test fixture.
- **Daemon:**
  - **better-sqlite3-multiple-ciphers 13.0.3** (cross-cutting §7, B6-12). N-API prebuilds ship in the package, so no install script is needed.
  - **@napi-rs/keyring 2.1.1** (cross-cutting §7, B6-17). 2.1.2 came out on 2026-10-19 and was not taken.
- **Redaction:**
  - **smol-toml 1.9.1** (2026-10-09): TOML parser for the rule compiler only.
  - **gitleaks rules v8.30.1** (C2-06).
- **Web app:**
  - **next 16.4.2**, **react / react-dom 19.3.1** (2026-10-15).
  - **@types/react / @types/react-dom 19.3.0**.
  - **@playwright/test 1.64.1** (2026-10-14).
- **Python helper:**
  - **presidio-analyzer / presidio-anonymizer 2.2.364** (C2-01).
  - **spacy 3.8.16:** latest on PyPI, resolved by uv.
  - **en_core_web_md 3.8.0** (SCR-106).
  - **pytest 8.4.2** and **hatchling 1.27.0**.
- **Contracts:**
  - **Arc Foundry v0.8.0-2**, commit `d497beea` (A9-12, A9-13).
  - **solc 0.8.30, prague** (spec 03).
  - **OpenZeppelin v5.7.0** (spec 03).
  - **forge-std v1.17.0:** the latest tag, test-only.
- **CI tools:**
  - **gitleaks v8.30.1** (C2-06), **actionlint v1.7.12** (latest on the Go proxy), **zizmor 1.31.1** (latest on PyPI).
  - **Go 1.25.14:** gitleaks needs ≥ 1.24.11 and actionlint ≥ 1.25.
  - **shellcheck 0.11.0.1:** used locally only.
- **Actions** (full SHAs in the workflows): `actions/checkout` v7.0.1, `actions/setup-node` v7.1.0, `pnpm/action-setup` v6.1.0, `actions/setup-go` v7.0.0, `astral-sh/setup-uv` v10.3.0. Each SHA came from `git ls-remote` of the tag.

## Spec change requests filed

| ID | Problem | Affects |
|---|---|---|
| SCR-101 | Arc testnet hardfork for the `arc-anvil` pin is not recorded, and testnet RPC is unreachable from the build container | T-003, T-010, T-021, T-022 |
| SCR-102 | arc-foundry digest recorded only as a fragment, without the archive name | T-003 |
| SCR-103 | 6 parameters without defaults, 6 inferred key names, 7 duplicates or conflicts, environment-file format unspecified | T-004 and consumers |
| SCR-104 | Storage and provider for the indexer's keyed fallback RPC URL are not specified | T-030, T-040 |
| SCR-105 | memory.db cipher described as "the binding's default SQLCipher-compatible AES-256"; the default is ChaCha20 | T-060 |
| SCR-106 | spaCy model not pinned; Presidio's default `lg` breaks the 400 MB RSS budget | T-064 |

## Things a reviewer should know

- **Agent instructions in fetched text:** none were met. I read the arc-foundry README, the gitleaks, stablecoin-evm, evm-gateway-contracts and base-contracts sources, and the EIP-8183 text as data only.
- **Blocked in this container:**
  - GitHub release pages (`github.com/.../releases/tag/...`) and `api.github.com` return 403.
  - `rpc.testnet.arc.io`, `binaries.soliditylang.org` and `releases.astral.sh` are refused by the proxy.
  - Release asset downloads, git, npm and PyPI work.
- **Never touched:** no keys, keystores or `.env` files were created or read, and nothing in this work sends funds or calls Circle services.

## Commands for Zaryab's Mac

Run them from a fresh clone on `build-v1`, with Node ≥ 22.18, pnpm 10.28.0 and uv installed. None of them prints a secret.

### T-060 daemon

```sh
git clone https://github.com/zaryab2000/czar && cd czar && git checkout build-v1
pnpm install --frozen-lockfile

# 1. Install as a login agent. macOS may ask to allow keychain access for node; choose Allow.
node apps/daemon/src/cli.ts install
launchctl print "gui/$(id -u)/dev.czar.daemon" | head -20      # expect: state = running

# 2. Status reports the installed state.
node apps/daemon/src/cli.ts status
# expect: "Czar is installed. Pair this computer from the Czar app to start."

# 3. Socket mode 0600 and the DB is unreadable without the key.
ls -l "$HOME/Library/Application Support/Czar/czar.sock"      # expect: srw-------
ls -l "$HOME/Library/Application Support/Czar/memory.db"      # expect: -rw-------
sqlite3 "$HOME/Library/Application Support/Czar/memory.db" 'select count(*) from sqlite_master;'
# expect: "Error: file is not a database"

# 4. Keychain items exist (prints metadata only, never the value: no -w flag).
security find-generic-password -s dev.czar.daemon -a memory-db-key > /dev/null && echo "K14 present"
security find-generic-password -s dev.czar.daemon -a hook-token > /dev/null && echo "K16 present"

# 5. Hook endpoint: no token and a foreign Origin are refused.
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:47011/v1/hooks                 # expect 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Origin: https://evil.example' \
  http://127.0.0.1:47011/v1/hooks                                                                  # expect 401

# 6. launchd restarts it after a kill (within about 10 s, B6-02).
launchctl kill SIGKILL "gui/$(id -u)/dev.czar.daemon"; sleep 12
launchctl print "gui/$(id -u)/dev.czar.daemon" | grep -E 'state|pid'                           # expect: running, new pid

# 7. Uninstall removes the agent and the keychain items, and keeps memory.
node apps/daemon/src/cli.ts uninstall
launchctl print "gui/$(id -u)/dev.czar.daemon"                                                  # expect: an error (service not found)
security find-generic-password -s dev.czar.daemon -a memory-db-key                               # expect: item not found
ls "$HOME/Library/Application Support/Czar"                                                     # memory.db still there
node apps/daemon/src/cli.ts uninstall --delete-memory                                           # removes the folder too
```

### T-064 Presidio helper

```sh
# 1. Tests on macOS.
cd apps/redact-sidecar && uv sync --frozen && uv run pytest -q && cd ../..      # expect: 14 passed

# 2. Build the self-contained bundle (downloads CPython 3.13.14 for macOS arm64).
scripts/bundle-redact-sidecar.sh /Users/Shared/czar-redact-bundle

# 3. Daemon end to end against the bundle, with an empty environment.
CZAR_TEST_SIDECAR_CMD=/Users/Shared/czar-redact-bundle/bin/czar-redact \
  pnpm --filter @czar/daemon exec vitest run test/sidecar-integration.test.ts   # expect: 1 passed

# 4. Clean account check (no system Python): create a standard user in
#    System Settings → Users & Groups, log in as that user, then run:
/Users/Shared/czar-redact-bundle/bin/czar-redact --socket /tmp/czar-redact-check.sock &
sleep 20
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"analyze_anonymize","params":{"text":"Ask Jonathan Whitaker at jw@example.org","language":"en"}}' \
  | nc -U /tmp/czar-redact-check.sock
# expect: {"jsonrpc": "2.0", "id": 1, "result": {"text": "Ask [[R:P:PERSON#1]] at [[R:P:EMAIL_ADDRESS#1]]", ...}}
ps -o rss= -p $!                                                              # record RSS (KB) in SCR-106
kill %1
```

- Gatekeeper is not involved for a bundle built on the same Mac.
- An installer that downloads the bundle needs signing and notarization of the bundled Python, which no tier-1 task builds.

## CI status

- **Green at `a3a63c6`** on `build-v1`: workflows `ci` (run 39295777850) and `secrets` (run 39295777879) both succeeded.
- Jobs: lint/typecheck/test, contracts (ubuntu-24.04) and contracts (macos-15) with forge build and test (49 tests, including the OEL invariants), indexer paging against arc-anvil (50,001 blocks), czar-redact, web e2e in Chromium and WebKit, actionlint and zizmor.
- **indexer-arc-anvil** had been red since tier 1. Three causes, fixed in turn (T-001 commits):
  - A single `anvil_mine` call outran arc-cast's 45 s client timeout. Mining now runs over curl in 5,000-block chunks with a 600 s limit per call.
  - Without `--prune-history`, arc-anvil kept every historical state. Each chunk was slower than the last, and the runner ran out of disk at about 30,000 blocks. It now starts with `--prune-history`.
  - The job timeout was raised to 45 minutes.
- A flaky sidecar idle test in the daemon (T-064) was given wider timing margins.
