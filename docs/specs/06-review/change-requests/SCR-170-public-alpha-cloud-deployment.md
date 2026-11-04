# SCR-170: Public alpha on one cloud machine — deployment shape, production entry points, secrets, and the parallel-window rules

| Field | Value |
|---|---|
| ID | SCR-170 |
| Filed by | chief architect, 2026-11-05, from Zaryab's request "parallel production plan" (4 Nov 2026) and `czar-public-alpha-plan.md` |
| Spec and section | `docs/product/decisions-log.md` D70 (amended for the public-alpha stage only, recorded here); `docs/specs/05-build-plan/stage-2-backlog.md` §6 (GC-1 to GC-9a); CZ-27 §3 (`signer.backend`); CZ-12 hosting; `docs/specs/04-components/shared/cross-cutting.md` §3 (secrets) |
| Status | Open → Accepted by Zaryab's merge (this merge is tracker item PM-001) |

## Problem

- **D70 says the server runs on Zaryab's Mac.** The public alpha needs it reachable by strangers' machines on Arc testnet.
- **Every app starts only through a local launcher.** The server, signer, indexer and merchants each have one `start:local` entry. Two of those enforce local-only rules on purpose:
  - `apps/server/src/local-main.ts` calls `validateLocalOnlyConfig`, which refuses any `app.origin` other than `http://localhost`.
  - `apps/signer/src/main.ts` refuses any `signer.backend` other than `local-keystore`.
- **No rule yet says** how cloud processes get secrets without putting them in environment variables or on the command line (D70, D78).
- **Production work runs in parallel with the agent social network,** so the shared files (config registry, migrations, spec-change numbers, lockfile) need explicit rules.

## Evidence

- `apps/server/src/local-main.ts:222`: `server.listen(port, "127.0.0.1", …)`. This is the only `listen` call in `apps/server/src`.
- `packages/config/src/local-only.ts:49-56`: `app.origin` must be `http://localhost` in Phase 1.
- `apps/signer/src/main.ts:48-49`: `signer process requires signer.backend=local-keystore`.
- `apps/signer/src/backend.ts:7`: `BackendName = "local-keystore" | "gcp-kms"`. The `gcp-kms` name is reserved, but no implementation exists.
- `apps/server/src/app/auth.ts:23`: `const RP_ID = "localhost"`, while `app/wallet-config.ts:34` already derives the RP ID from `app.origin` (SCR-156, SCR-157 §3).
- `apps/server/src/db/migrate.ts`: migrations apply in filename order and are tracked by filename, so gaps in numbering are harmless.
- `packages/config/test/spec-coverage.test.ts` checks one direction only (spec → registry). A registry key not named in the specs does not fail it.

## Ruling

### 1. Where Czar runs for the public alpha (amends D70 for this stage)

- **For the public alpha on Arc testnet,** the server stack runs on **one Google Compute Engine VM**.
  - Machine: e2-medium (2 vCPU, 4 GB).
  - Disk: a 30 GB persistent balanced disk.
  - Region: `asia-south1`, unless Zaryab names another when he creates the project.
- **D70 stays the rule for local development.** `start:local`, `env/local.toml`, the local-only guard and `ops/local/` are unchanged.
- **The VM runs, as Docker containers with `network_mode: host`:**
  - Postgres 16
  - the indexer (`ponder start`)
  - the signer
  - the server
  - the merchants
  - the web app (`next start`)
  - later, the social worker and the job-provider workers
- **Every container binds `127.0.0.1` only.** The server keeps its loopback bind.
  - **Tracker item PM-015 ("server listen address from config") is closed as not needed.**
- **Caddy runs on the host** and is the only public listener, on ports 80 and 443. It gets certificates from Let's Encrypt.
- **Firewall:**
  - inbound 80 and 443
  - inbound 22 only from Google's IAP range (`35.235.240.0/20`)
  - nothing else
- **Why one machine and not Cloud Run:** the indexer, the payer reconcile loops, the signer gas refill and the job workers are always-on loops. Postgres beside them costs nothing extra.
  - Cloud Run (GC-4) and the e2-micro indexer (GC-5) in `stage-2-backlog.md` §6 are superseded for the alpha.

### 2. Origins

| Origin | Served by | Purpose |
|---|---|---|
| `https://app.<domain>` | Caddy → web app (`127.0.0.1:3100`); paths `/v1/*` and `/health` → server (`127.0.0.1:3000`) | The web app, the owner API, the daemon's `daemon.serverOrigin`, job briefs and deliverables (GC-9a) |
| `https://merchants.<domain>` | Caddy → merchants (`127.0.0.1:8787`) | `merchants.publicOrigin`; every Czar service and lab service by path, as CZ-20 §5.8 already specifies |

- **There is no separate `api.` subdomain.** One app origin keeps the passkey RP ID, cookies and the daemon on one host.
- **The passkey RP ID is the host name of `app.origin`** (unchanged rule, SCR-157 §3).
  - `apps/server/src/app/auth.ts` derives it from `app.origin` exactly as `app/wallet-config.ts` does. This is tracker item PM-016.
  - With the default `app.origin = http://localhost`, the RP ID stays `localhost`, so local behaviour is identical.

### 3. Production entry points (new files only)

| App | New entry | What it does | Must not |
|---|---|---|---|
| server | `apps/server/src/cloud-main.ts` | Loads `env/cloud.toml` (path from pointer `CZAR_CLOUD_CONFIG`), runs `validateCloudConfig`, builds the same `createServerMain(...)` that `local-main.ts` builds with real service URLs from config, injects a `ModelClient` only when `models.provider ≠ none`, and listens on `127.0.0.1:<port>` | edit `local-main.ts`, `main.ts`, `app.ts` or any route file |
| signer | `apps/signer/src/cloud-main.ts` | The same service, socket and audit as `local-main.ts`, with `signer.backend = gcp-kms` | read a keystore or keychain |
| merchants | `apps/merchants/src/cloud-main.ts` | The same runtime as `local-main.ts`, with real facilitator and indexer URLs | change payment or seller code |
| indexer | no new entry file | `ponder start` with `env/cloud.toml` and a testnet deployment file. `ponder.config.ts` gains one additive branch: when `deploy.environment = cloud-testnet` it sets `database: {kind: "postgres", connectionString}`, built from config plus the `db-password` file read at config load, so no password is ever in `DATABASE_URL` | edit handlers or `ponder.schema.ts`; change local behaviour |

- **`validateCloudConfig`** lives in a new file, `packages/config/src/cloud-only.ts`, exported from `index.ts` with one added line. It refuses to start unless all of these hold:
  - `deploy.environment = "cloud-testnet"`
  - the chain id is `5042002`
  - every RPC URL host is in `deploy.allowedRpcHosts`
  - `app.origin` and `merchants.publicOrigin` are `https`
  - `fetch.localStandinOrigins` is empty
  - `signer.backend = gcp-kms` (signer only)
  - `merchants.lab.enabled` is false on any mainnet chain id (already a CZ-20 rule)
- **Pointers versus secrets:** pointers such as `CZAR_CLOUD_CONFIG` and a database URL without a password may come from the environment, as in the local launchers. Secrets never do (§4).

### 4. Secrets

- **Secrets are files, never environment variables, command-line arguments, image layers, compose files or config values.**
- **Location and permissions:**
  - Each service reads its secrets from `deploy.secretsDir` (`/run/czar/secrets`), a host `tmpfs`.
  - Each service sees only its own subfolder, mounted read-only.
  - Files are mode `0400` and owned by the container's user.
- **How they get there:**
  - A host systemd unit (`czar-secrets.service`) fetches the files at boot from Google Secret Manager, using the VM's service account through the metadata server.
  - There are no key files on disk.
- **Config holds file names only,** for example `models.anthropic.apiKeyFile = "anthropic-api-key"`, resolved under the service's secrets folder.
- **Database:** each service connects as its own role with a password.
  - The connection URL carries no password.
  - The cloud entry point builds its `pg.Pool` with `password: () => readFile(<secretsDir>/<service>/db-password)`. This is node-postgres's supported password function; its `pgpass` fallback is deprecated in pg 8 and removed in pg 9.
- **Google APIs** (Cloud KMS, Secret Manager, Cloud Storage) authenticate with short-lived access tokens from the VM metadata server (`http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token`). There are no service-account key files anywhere.
- **Signing keys live in Cloud KMS** (secp256k1, `EC_SIGN_SECP256K1_SHA256`, software protection level). The VM service account has only `cloudkms.signerVerifier` and `cloudkms.viewer` on the Czar key ring.
  - The pocket keys (K4) are created at runtime. `cloudkms.admin`-level rights for creating them are given only to the signer's service account, and only on the key ring `czar-alpha-pockets`.

### 5. Database

- **Engine and network:** Postgres 16.15 (the image digest pinned in `ops/local/compose.yaml`), listening on `127.0.0.1:5432` only, with `password_encryption = scram-sha-256`.
- **Roles:** one per service (`czar_api`, `czar_signer`, `czar_indexer`, `czar_merchants`, and `czar_social` when the social network lands). Each has its own `db-password` secret file.
- **Data** lives on the persistent disk.
- **Backups:**
  - a nightly `pg_dump --format=custom` to a Cloud Storage bucket
  - objects deleted after `deploy.backupRetentionDays` (14)
  - a restore drill recorded before sign-ups open (tracker PM-052)

### 6. Model provider

- **`models.provider`:** `none` (default) or `anthropic`. The adapter is `apps/server/src/models/anthropic.ts` (tracker PM-021).
  - It implements the existing `ModelClient` interface with `fetch` against the Messages API.
  - There is no SDK dependency.
- **The adapter is wired only in `cloud-main.ts`, and only when `models.provider = anthropic`.**
  - Wiring it switches on the existing boundary screen (P-01/P-02) and the model proxy route. That is a behaviour change on the payment path.
  - So the first live run with a provider needs Zaryab's approval (tracker PM-009/PM-004).
- **Defaults:**
  - model `claude-haiku-5-5`
  - every prompt checked to stay under `models.anthropic.maxPromptTokens` (100,000), refused locally if over
  - the existing per-user caps (`models.userMonthlyTokens` etc.) unchanged

### 7. Rules for the parallel window (until the agent social network PR merges into `build-v1`)

- **Reserved for the social network:**
  - every path listed in Zaryab's request §3.1
  - spec-change numbers SCR-164 to SCR-169
  - migrations `0023` to `0029`
- **Production uses:**
  - spec-change numbers **SCR-170 to SCR-189**
  - migrations **`0030` to `0049`**
  - Production migrations never reference social tables.
- **Config keys:**
  - Every new key added in this window goes in a new file, `packages/config/src/registry-production.ts`, as `export const PRODUCTION_PARAMETERS = [...] as const satisfies readonly ParameterSpec[]`.
  - `registry.ts` gains exactly two edits: the import, and `...PRODUCTION_PARAMETERS,` as the first element of `PARAMETERS`.
  - Inside the file, entries are grouped by lane in the order A, B, C, D, E, with a comment line per lane.
  - Keys follow the spec's namespace when the spec names one (`merchants.lab.<service>.*`, `merchants.provider.*`, `signer.*`, `models.*`). Otherwise they use `deploy.*`.
  - Each `source` cites this SCR, or the SCR that defines the key.
  - The dump snapshot `packages/config/test/__snapshots__/loader.test.ts.snap` is regenerated with `vitest -u` in the same PR, never edited by hand.
- **Specs:**
  - In this window, production rulings live only in their SCR files.
  - The edits those rulings order to `docs/specs/02-…`, `04-…` and `05-…` are applied in one docs PR after the social PR merges.
  - New files under `docs/specs/05-build-plan/gate-0-results/` are allowed (check records, not spec text).
- **Not edited by production in this window:**
  - `ops/local/**`, `env/local.toml`
  - `apps/server/package.json`, `apps/web/package.json`
  - every reserved path
- **Lockfile:**
  - New dependencies need a reason in the PR body.
  - A `pnpm-lock.yaml` conflict is resolved by taking the target branch's lockfile and re-running `pnpm install`, never by hand-merging.
- **Merging into `build-v1`:**
  - Production reaches `build-v1` through `prod/integration` in **weekly batch PRs**. Zaryab merges each one.
  - Whichever of the social PR and a production batch lands second merges `build-v1` into its branch and re-runs every suite.

### 8. Config keys this SCR introduces (`registry-production.ts`)

| Key | Type | Default | Reason |
|---|---|---|---|
| `deploy.environment` | string | `"local"` | `local` or `cloud-testnet`; cloud entry points refuse to start unless `cloud-testnet` |
| `deploy.allowedRpcHosts` | string[] | `["rpc.testnet.arc.io"]` | the only RPC hosts a cloud process may use (CLAUDE.md: Arc testnet only) |
| `deploy.secretsDir` | string | `"/run/czar/secrets"` | secrets are files under a tmpfs folder (§4) |
| `deploy.backupRetentionDays` | integer | 14 | nightly dump retention (§5) |
| `deploy.metadataTokenUrl` | string | `"http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"` | access tokens for Google APIs without key files (§4) |
| `signer.kms.apiBaseUrl` | string | `"https://cloudkms.googleapis.com"` | Cloud KMS REST endpoint |
| `signer.kms.projectId` | string | no default | set in `env/cloud.toml` |
| `signer.kms.location` | string | `"asia-south1"` | key ring location (§1) |
| `signer.kms.keyRing` | string | `"czar-alpha"` | long-lived keys K3, K5, K7, K8, K10, K21, relayer |
| `signer.kms.pocketKeyRing` | string | `"czar-alpha-pockets"` | runtime K4 pocket keys (§4) |
| `signer.kms.keyVersions` | object | `{}` | key reference → full `cryptoKeyVersions/N` resource name; filled after key creation (tracker PM-018) |
| `models.provider` | string | `"none"` | `none` or `anthropic` (§6) |
| `models.anthropic.baseUrl` | string | `"https://api.anthropic.com"` | Messages API |
| `models.anthropic.model` | string | `"claude-haiku-5-5"` | default model for every prompt |
| `models.anthropic.apiKeyFile` | string | `"anthropic-api-key"` | file name under the server's secrets folder |
| `models.anthropic.maxPromptTokens` | integer | 100000 | a local refusal above this; the price tier changes above it |

- `kms.signTimeoutMs` (existing, 2,000) is the per-call timeout for Cloud KMS signing. No new timeout key is added.

## Not decided here (later SCRs, production range)

- SCR-171: shared agent signer → one agent signer per vault, or on-chain constraints on agent-opened envelopes; testnet redeploy plan (PM-002/PM-023).
- SCR-172: public-alpha safety: per-user isolation audit, rate limits, invite gate, global caps, kill switch (PM-025 to PM-028).
- SCR-173: narrower passkey owner powers (PM-029), folded into SCR-171's redeploy if it needs contract changes.
- SCR-174: privacy wording for the cloud stage (PM-030, PM-054).
- SCR-175: packaging the Python redaction helper (PM-036).
- SCR-176: browser-only "New task" (PM-039).
- SCR-177: treasury drip, Gateway sweep destination, Czar-service refunds under the ratings model, and the K10 send policy (PM-047, the T-051 Gateway, sweep and refund part).
- SCR-178: house supply beyond CZ-20 (the AI Explainer merchants, Vulnerability Lookup) and the job-provider work modes (OD-41).
- SCR-179: the observation chain (T-063 → T-066 → T-068 → T-069) and the plugin T-062, with what the alpha ships without it.

## Affected tasks

- T-040 (server launcher), T-051, T-105, T-106, T-108, GC-2, GC-4, GC-5, GC-6, GC-7, GC-9, GC-9a.
- Tracker items PM-001, PM-011 to PM-017, PM-021, PM-051, PM-052.

## Decision

- Accepted by Zaryab's merge of the PR that adds this file. The merge is his approval of tracker item PM-001 ("the server moves to the cloud for the public alpha").
