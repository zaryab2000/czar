# SCR-130: Circle endpoint base URLs and merchant public origin as config keys; D92 local stand-ins

| Field | Value |
|---|---|
| ID | SCR-130 |
| Filed by | chief architect, 2026-10-25 (Track A replan, baseline `ce17dad`) |
| Spec and section | `docs/specs/04-components/shared/cross-cutting.md` §3.1 environments (`:66-74`, local row `:72`) and §2.1 safeFetch scheme rule and local exception (`:53`, `:59`); `docs/specs/04-components/server/server-supply-side.md` CZ-20 §5.1–§5.4 and `:62` (`searchBackend`); `docs/specs/05-build-plan/phase-1-tasks.md` D92 note (`:13`), T-040; `@czar/config` |
| Status | Accepted (Zaryab, 2026-10-25); Applied (2026-10-25) |

## Problem
- Circle endpoints are hard-coded:
  - Facilitator: `FACILITATOR_BASE_URL`, `apps/merchants/src/facilitator.ts:6`.
  - Gateway: `GATEWAY_API_BASE`, `apps/indexer/src/gateway-poller.ts:4`. The server takes an optional `ServerMainOptions.gatewayTransferUrl` (`apps/server/src/main.ts:84`), and tests use `127.0.0.1:4999`.
- D92 (`phase-1-tasks.md:13`) runs every pre-M8 test on local `arc-anvil` "with Circle contracts and APIs replaced by the T-010 mocks and recorded fixtures". The cross-cutting `local` row says the Circle services are "mocked (`/verify`, `/settle`, Gateway API) by the test harness" (`cross-cutting.md:72`). No running process can be pointed at such a replacement, and no runnable replacement exists. The only one is a test-local function (`apps/server/test/evidence/receipt-arc.test.ts:566-620`).
- The merchant route needs `resourceUrl` (`apps/merchants/src/search/route.ts:27`). No key gives a service's public origin.
- safeFetch's only loopback exception is `fetch.localMerchantOrigins`, "Czar's own merchants" (`cross-cutting.md:53,59`). The server's Gateway calls go through safeFetch (`apps/server/src/payer/pullback.ts:697`), so a loopback Gateway stand-in would be refused.
- **Local and testnet share chain id 5042002** (`cross-cutting.md:72`: `arc-anvil --network arc --chain-id 5042002`; `ops/local/deploy.sh:6`; `selection.paymentNetwork = eip155:5042002`). A chain-id check therefore cannot tell local from testnet.

## Evidence
- File:line references above; verification report B §2; fact-check rows 1, 2, G10.

## Proposed change

### 1. New `@czar/config` keys

| Key | Type | Default | Reason |
|---|---|---|---|
| `merchants.facilitatorBaseUrl` | string | `https://api.circle.com/v1/facilitator/x402` | 02 §11.1; the merchant posts `${base}/verify` and `${base}/settle` (`facilitator.ts:63`) |
| `chain.gatewayApiBaseUrl` | string | `https://gateway-api-testnet.circle.com` | A2-30; one key for indexer polls and the server's `/v1/transfer` and `/v1/balances` (used by SCR-127) |
| `merchants.publicOrigin` | string | no default (`noDefault`) | `resourceUrl = publicOrigin + "/v1/<svc>"` |
| `fetch.localStandinOrigins` | string[] | no default (`noDefault`) | exact `http://127.0.0.1:<port>` origins of the D92 stand-ins; a second loopback exception beside `fetch.localMerchantOrigins`, same rules (D70) |

### 2. Local-only guard (replaces any chain-id test)
- A loopback URL (`http://127.0.0.1:<port>`) in any of the four keys, and any value in `fetch.localStandinOrigins`, is accepted only when all three conditions hold:
  1. The loaded overlay is `local` (`env/local.toml`, via `CZAR_LOCAL_CONFIG`).
  2. The configured Arc RPC URL is itself `http://127.0.0.1:<port>`.
  3. At startup, the RPC answers `anvil_nodeInfo`. The real Arc RPC does not implement anvil methods. If the pinned `arc-anvil` build does not answer it, the builder stops and reports. No weaker check may be substituted.
- Config load fails otherwise. Production and testnet values must be `https://`.
- The chain id is **not** used as the discriminator, because local and testnet are both 5042002.

### 3. D92 local stand-ins (ops tooling, never product components)
- **Location:** `ops/local/circle-standins/`, one process.
  - Facilitator: `POST /verify` and `POST /settle` with exactly the request and response shapes `apps/merchants/src/facilitator.ts` sends and parses. Settle submits `transferWithAuthorization` through the node's **unlocked** account with `eth_sendTransaction`, as `ops/local/deploy.sh:65` already does. It never embeds or loads a private key.
  - Gateway: `POST /v1/balances`, `POST /v1/transfer` and `GET /v1/x402/transfers`, serving the recorded A2 fixture responses parameterised by pocket.
- **Startup refusals** (each logged and exits non-zero):
  - the RPC URL is not loopback
  - the RPC does not answer `anvil_nodeInfo`
  - the bind address is not `127.0.0.1`
  - the overlay is not `local`
- It is never referenced by any non-local overlay. `env/testnet.toml` (T-121) uses the defaults.

### 4. `merchants.searchBackend`
- CZ-20 `:62` keeps `fixture` "for CI". Amend it to "for CI and the D92 local stack".
- The local overlay sets `fixture`. Choosing the `live` source stays a Zaryab decision for M8 (vendor account).

### 5. Cross-cutting §3.1
- Amend the existing `local` row's Circle services cell (`:72`) to "the D92 stand-ins in `ops/local/circle-standins/` (origins in `fetch.localStandinOrigins`)". No new column.

## Affected tasks
- T-040 (local hosting), T-043 (merchant), T-053 (pullback base URL), T-032 (indexer poll base URL), T-121 (testnet overlay must use defaults).

## Decision
- Accepted by Zaryab on 2026-10-25 with the Track A replan (context and briefs in `docs/builder-prompts/track-a/`).

## Applied
- cross-cutting §3.1 local row and §2.1 local-only guard
- CZ-20 `searchBackend` fixture wording and startup keys
- `@czar/config`: `merchants.facilitatorBaseUrl`, `chain.gatewayApiBaseUrl`, `merchants.publicOrigin`, `fetch.localStandinOrigins`
