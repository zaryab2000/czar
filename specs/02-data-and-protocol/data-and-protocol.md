# Czar data and protocol (spec 02)

## 0. Header

- **Date:** 2026-10-18
- **Author:** Claude, protocol and smart-contract architect, for Zaryab
- **Status:** draft for review, written together with `specs/03-smart-contracts/`. Shared types are defined **here once**; spec 03 references them by section.
- **Inputs read in full:** `README.md`, `product/decisions-log.md` (D1–D37), `specs/01-system-architecture/system-architecture.md`, `product/czar-product.md`, `architecture/selection-layer-architecture.md`, `specs/00-ground-truth/part2.md`, `specs/00-ground-truth/circle-arc.md`, `research/evidence/experiments/{a1-erc1271-usdc,a2-gateway-e2e}/README.md`, `a1-erc1271-usdc/{x402-flow.mjs,foundry.toml,src/OwnerSig1271.sol}`, `a2-gateway-e2e/withdraw.ts`.
- **Primary sources read this session (all 2026-10-18):**
  - `circlefin/evm-gateway-contracts` @ `c21d2d2e356d6566b6c7c3dde7ebcbdf1747590b`: `src/lib/TransferSpec.sol`, `src/lib/BurnIntents.sol`, `src/lib/EIP712Domain.sol`, `src/modules/wallet/{Burns,Delegation,Deposits,Balances,Withdrawals}.sol`, `src/modules/minter/Mints.sol`, `src/modules/common/TransferSpecHashes.sol`.
  - `circlefin/stablecoin-evm` @ tag `release-2026-08-12T202509` (commit `fc85788b`): `contracts/v2/EIP3009.sol`, `contracts/v2/FiatTokenV2.sol`, `contracts/v2/FiatTokenV2_2.sol`, `contracts/util/SignatureChecker.sol`, `contracts/util/EIP712.sol`.
  - `erc-8183/base-contracts` @ `142e669c1fd318486a4628395b629f033654dd06`: `contracts/ERC8183.sol`, `contracts/IERC8183Hook.sol`.
  - Verified ABI of Arc testnet ERC-8183 implementation `0xA316fd02827242D537F84730F8a37D0BA5fd351a` (local file `arc-lab/abi/AgenticCommerce.ts`, 1,203 lines).
  - `x402-foundation/x402` @ `faa1c694c66a3732aaabbce93bdae140e521a67d`: `specs/extensions/payment_identifier.md`, `specs/transports-v2/http.md`.
  - `OpenZeppelin/openzeppelin-contracts` v5.7.0 (released 2026-07-29): `utils/cryptography/{MerkleProof,Hashes,P256,WebAuthn}.sol`, file presence of `ReentrancyGuardTransient`, `SignatureChecker`, `EIP712`, `Ownable2Step`, `IERC1271`.
  - `@circle-fin/x402-batching` 3.5.0 `dist/client/index.mjs` (Gateway contract address constants).
  - W3C WebAuthn Level 3 (`https://www.w3.org/TR/webauthn-3/`, authenticator data layout).
  - Tool versions: `forge 1.8.5`, Solidity latest release `v0.8.37` (2026-09-10), OpenZeppelin `v5.7.0` (2026-07-29), viem `2.57.2`.
- **Decisions relied on:** D10, D11, D15, D19, D22–D37.
- **Fact IDs relied on most:** A1-03, A1-08, A1-09, A1-11, A1-12, A1-13, A1-18, A1-20; A2-02, A2-04, A2-05, A2-06, A2-08, A2-09, A2-10, A2-13 to A2-19, A2-23, A2-28 to A2-31; A3-02 to A3-11, A3-32 to A3-37; A4-03, A4-05 to A4-13; A5-03 to A5-10; A6-01 to A6-03; A7-04; A9-06, A9-14, A9-15; B1-02 to B1-27, B2-13 to B2-17, B3-04 to B3-10; B5-05, B5-12; C2-05, C2-06; D2-04, D2-06; D3-02 to D3-11; F1-06; p1-A1, p1-A4, p1-A6, p1-A7, p1-G14.
- **Citation conventions:** as in spec 01 §0 (`p1-` prefix for part 1 facts; `SL-` for the Selection Layer document; `AR-n` for spec 01 assumptions).
- **Status wording:** Czar is a production system that will hold user funds.

---

## 1. Summary

- Every amount in every API is a USDC 6-decimal atomic-unit integer string. Never a float, never 18-decimal native wei.
- Every object has a schema file, a `schemaVersion`, and a privacy class on every field. Fields that leave the user's machine are explicit; Cursor's `user_email` and similar fields are dropped at intake.
- Three hashes bind the proof-of-demand chain: `objectiveHash`, `planHash` and `soulVersionHash`, all RFC 8785 JCS + keccak256 over named field sets.
- One Merkle rule serves evidence batches and `payeeRoot`: double-hashed leaves with a tag, sorted-pair (commutative) keccak256 nodes, odd nodes carried up, as OpenZeppelin's `MerkleProof` verifies.
- EIP-712 types: the Selection Layer §5.8 set is adopted verbatim; Czar adds `AutonomyRaise`, `OwnerAction` and `ReceiptAttestation` (RV-013) under the `CzarVault` domain. Every type hash and five test digests were computed with viem 2.57.2 and are recorded in `vectors/eip712-vectors.json`.
- The vault's ERC-1271 signature carries a kind tag (`USDC_3009`, `GATEWAY_BURN`, `SL_RECEIPT`) and the fields the vault needs to recompute the digest. A 65-byte fallback exists for the case where Circle's Facilitator rejects long signatures (AR-3).
- Batch reservations: one reservation fixes `payee`, `unitAmount` and `count`; nonce `i` is derived from the reservation id, so the worst case the agent can sign is `count × unitAmount`.
- Payment ids follow the x402 `payment-identifier` extension (16–128 chars of `[A-Za-z0-9_-]`) and are the retry key end to end.
- APIs are OpenAPI 3.1 with device-token auth, idempotency keys, RFC 9457 errors and cursor pagination. MCP tools follow revision `2026-07-28` over stdio; any tool that can spend returns a URL-mode elicitation.
- Czar's discovery index serves Circle's `metadata` item shape and the x402 spec shape on one item, with cache fields that enforce "query live, don't mirror".

---

## 2. Conventions

### 2.1 Units and primitive formats

| Name | Format | Rule | Example (invented) |
|---|---|---|---|
| `Amount6` | string, regex `^(0\|[1-9][0-9]*)$` | USDC atomic units, 6 decimals. Max `10^15` in APIs (one billion USDC) as a sanity bound. On-chain `uint256`. Never 18-decimal native wei (p1-A4, p1-A5). | `"100000"` = 0.10 USDC |
| `Bps` | integer 0–10000 | basis points; math floors | `2500` |
| `Address` | string, EIP-55 checksummed `0x` + 40 hex | in APIs; **lowercase** inside canonical JSON for hashing (§5.1) | `0xd80fe1aD38eC902df4Db294795D7CD18163A23EE` |
| `Hash32` | string, `0x` + 64 lowercase hex | keccak256 unless stated | `0x11…11` |
| `Caip2` | `eip155:<chainId>` | Arc mainnet `eip155:5042`, testnet `eip155:5042002` (p1-A1) | `eip155:5042002` |
| `Caip10` | `eip155:<chainId>:<address>` | address lowercase | `eip155:5042002:0xd80f…23ee` |
| `Timestamp` | RFC 3339 UTC, millisecond precision, `Z` suffix | in APIs and JSON objects | `2026-10-18T14:29:51.123Z` |
| `UnixSeconds` | integer | on-chain time fields (`uint64`) | `1760800000` |
| `Ulid` | 26 chars Crockford base32 | server-generated ids, sortable | `01K7ZT9…` |
| `Id(prefix)` | `<prefix>_<Ulid>` | see §7 | `obj_01K7ZT…` |

### 2.2 Schema versioning and compatibility

- Every object carries `schemaVersion` as `"<major>.<minor>"`, starting at `"1.0"`.
- Minor bump: fields added, all optional. Readers ignore unknown fields.
- Major bump: a field removed, renamed, retyped, or a hash rule changed. New file `<name>.v<major>.schema.json` with its own `$id` (`https://czar.dev/schemas/<file name>`); the older file stays, marked superseded. Hashes computed under an older major stay valid; the hash rule version is part of the canonical form (§5.1).
- `$id` and `$ref` convention (2026-10-19): `$id` is `https://czar.dev/schemas/<file name>` and cross-file `$ref`s are file-relative, so they resolve the same way by `$id` and by path (`schemas/README.md`).
- Hook payloads from Claude Code, Codex and Cursor are not under Czar's control; the mapping in §8 names each source field so a host change is visible as a diff.

### 2.3 Error model

- HTTP APIs use RFC 9457 `application/problem+json`: `type` (URI under `https://czar.dev/problems/`), `title`, `status`, `detail` (never contains user text), `instance`, plus `czarCode` (stable string) and `retryable` (boolean).
- MCP tools return `isError: true` with a `StepError` object (§4.16) in `structuredContent`.
- Contract errors are custom errors (spec 03 tables).

### 2.4 Key words

- "MUST", "SHOULD" as in RFC 2119.
- "Agent key" = `agentSigner` (spec 01 K3). "Owner" = the user's MSCA (D26, D30).

---

## 3. Privacy classes

| Class | Meaning | Where it may exist |
|---|---|---|
| `local-only` | never leaves the user's machine | daemon storage only |
| `redacted-to-server` | leaves the machine only after redaction layers 1 and 2 (spec 01 §11.2); may be sent to the hosted soul model under D31 | daemon, Czar server, model provider (transient) |
| `server-only` | created or held on Czar's server; never sent to the user's machine beyond what the app shows; never on-chain | Czar server |
| `hash-on-chain` | the value stays off-chain; only its keccak256 goes on-chain | server + chain (hash only) |
| `public` | on-chain or in published archives | anyone |

Rules:
- A field marked `local-only` MUST NOT appear in any object whose schema is sent over the daemon → server API. The schemas enforce this: `ObjectiveSubmission` has no `local-only` fields.
- Nothing marked `local-only` or `redacted-to-server` may appear in calldata, events, ERC-8183 `description`, `optParams` (p1-E7) or `OpenEvidenceLog` archives.
- `hash-on-chain` fields are hashed under §5 rules; the preimage is retained server-side for the retention period in spec 01 §11.1.

### 3.1 Redaction markers

- Format: `[[R:<layer>:<type>(#<n>)?]]`, ASCII only.
  - `<layer>` is `S` for the secrets layer (gitleaks rule id, C2-06) or `P` for the PII layer (Presidio entity name, C2-05).
  - `<type>` is the rule or entity id in lowercase kebab-case for `S` (for example `aws-access-token`) and the Presidio entity name for `P` (for example `EMAIL_ADDRESS`).
  - `#<n>` is an optional per-text counter so two different redacted values stay distinguishable (`[[R:P:PERSON#1]]`, `[[R:P:PERSON#2]]`).
- Examples: `[[R:S:generic-api-key]]`, `[[R:P:EMAIL_ADDRESS]]`, `[[R:P:PHONE_NUMBER#2]]`.
- Markers are literal text and are hashed as such. A marker MUST NOT be reversible from anything that leaves the machine.
- Dropped-at-intake fields (never stored, never marked): Cursor `user_email` (B3-04), `CURSOR_USER_EMAIL` env (B3-09), Claude Code `transcript_path` contents (B1-30), any `env` map, any `headers` map.

---
## 4. Data objects

Each object: purpose, fields (name, type, required, privacy class, description, source of truth), invariants, an invented example, schema path. Column key: **R** = required, **PC** = privacy class (`L` local-only, `RS` redacted-to-server, `SO` server-only, `HC` hash-on-chain, `PUB` public). Every object also has `schemaVersion: "1.0"` (R, same class as the object's lowest class).

### 4.1 `ActivityEvent`

- **Purpose:** one normalized observation from a work tool (product §7.1). Written by the daemon after redaction layer 1. Never leaves the machine.
- **Schema:** `schemas/activity-event.schema.json`
- **Source of truth:** daemon shared memory.

| Field | Type | R | PC | Description |
|---|---|---|---|---|
| `eventId` | `Id(evt)` | yes | L | ULID assigned at intake |
| `host` | enum `claude-code` \| `codex` \| `cursor` \| `chrome` | yes | L | detected per §8.1 |
| `hostVersion` | string | no | L | `cursor_version`, Codex `cli_version`, Claude Code version from `SessionStart` if present |
| `sessionRef` | `Hash32` | yes | L | keccak256 of the host session id (`session_id` / `conversation_id` / `thread-id`); never the raw id |
| `projectRef` | `Hash32` | yes | L | keccak256 of the absolute project root path (`cwd` walked to the git root) |
| `eventType` | enum `tool-call` \| `tool-result` \| `tool-failure` \| `file-read` \| `file-write` \| `command` \| `search` \| `prompt` \| `skill-use` \| `mcp-call` \| `agent-refusal` \| `subagent` \| `session-start` \| `session-end` \| `page-visit` \| `error` | yes | L | normalized type |
| `occurredAt` | `Timestamp` | yes | L | host time if present, else intake time |
| `toolName` | string ≤ 128 | no | L | host tool name; MCP parsed per §8.5 |
| `mcp` | object `{server, tool, plugin?}` | no | L | parsed from `mcp__…` names (B1-25) |
| `summary` | string ≤ 2,000 | yes | L | short redacted summary of inputs/outputs; markers per §3.1 |
| `fileRefs` | array of `Hash32` ≤ 20 | no | L | keccak256 of each absolute file path touched |
| `errorClass` | string ≤ 128 | no | L | normalized error class (for the repeated-error detector) |
| `durationMs` | integer | no | L | from `duration_ms` / `duration` |
| `agentRef` | `Hash32` | no | L | keccak256 of `agent_id` when inside a subagent (B1-26) |
| `provenance` | object `{hookEvent, hookSource?, trusted: boolean, flags?: ["injection-suspect"]}` | yes | L | `flags` is set by the intake screen (AM-12); `hookEvent` = host event name; `trusted=false` for content that came from tool output or pages (ASI06 gate, spec 01 §13) |
| `redaction` | object `{layer1: {hits: integer, rules: string[]}}` | yes | L | what layer 1 removed (counts and rule ids only) |
| `repeatCount` | integer ≥ 1 | no | L | how many identical events this record merges (memory dedupe rule, CZ-03; AM-12) |

- **Invariants:** `summary` contains no raw secret (layer 1 ran); `sessionRef`, `projectRef`, `fileRefs` are hashes, never paths; `provenance.trusted` is `false` whenever the text originated in a tool result, page, or `last_assistant_message`.
- **Example (invented):**

```json
{"schemaVersion":"1.0","eventId":"evt_01K7ZT9P4N5Q6R7S8T9V0W1X2Y","host":"claude-code","sessionRef":"0x3f…a1","projectRef":"0x9b…c2","eventType":"tool-call","occurredAt":"2026-10-18T09:12:03.420Z","toolName":"Bash","summary":"curl competitor pricing page (3rd time today) → 200, [[R:S:generic-api-key]] in header","fileRefs":[],"durationMs":812,"provenance":{"hookEvent":"PostToolUse","trusted":false},"redaction":{"layer1":{"hits":1,"rules":["generic-api-key"]}}}
```

### 4.2 `soul.json`

- **Purpose:** the machine-readable Work Soul (product §6.3). Eight sections of beliefs with receipts.
- **Schema:** `schemas/soul.schema.json`
- **Source of truth:** daemon soul store; `SOUL.md` is rendered from it (§13).

| Field | Type | R | PC | Description |
|---|---|---|---|---|
| `version` | integer ≥ 1 | yes | L | monotonically increasing per compile |
| `compiledAt` | `Timestamp` | yes | L | |
| `previousHash` | `Hash32` | no | HC | `soulVersionHash` of version − 1 |
| `sections` | object with keys `place`, `mission`, `rituals`, `friction`, `drives`, `taste`, `constraints`, `spendingPosture` | yes | L | each an array of `Belief` |
| `Belief.beliefId` | `Id(blf)` | yes | L | stable across versions while the belief lives |
| `Belief.text` | string ≤ 500 | yes | L (RS when selected as an excerpt for compilation, D31) | the belief in plain words; markers allowed |
| `Belief.confidence` | number 0–1 | yes | L | |
| `Belief.firstSeen`, `Belief.lastSeen` | `Timestamp` | yes | L | fade when not seen |
| `Belief.receipts` | array of `eventId` ≤ 50 | yes | L | observations behind it |
| `Belief.userEdited` | boolean | yes | L | true after the person edits or pins it |
| `Belief.state` | enum `candidate` \| `active` \| `faded` \| `archived` | no | L | belief lifecycle (CZ-04); only `active` and `faded` render to `SOUL.md` (AM-13) |
| `Belief.key` | string ≤ 256 | no | L | normalized dedupe key that merges repeated observations into one belief (AM-13) |
| `hourlyValue` | object `{amount: Amount6, currency: string, setByUser: boolean}` | no | L | the band, not the amount, leaves the machine (§4.4) |
| `excerptPolicy` | object `{maxChars: integer, allowSections: string[]}` | yes | L | what may be sent to the hosted model (D31); default `maxChars` 20,000 |

- **Invariants:** `version` strictly increases; every belief has ≥ 1 receipt or `userEdited = true`; the compile input sent to the hosted model is a redacted excerpt ≤ `excerptPolicy.maxChars` and contains only `RS`-eligible text.
- **Example (invented):** `{"schemaVersion":"1.0","version":12,"compiledAt":"2026-10-18T02:00:00.000Z","sections":{"mission":[{"beliefId":"blf_01K7…","text":"Pricing refresh due Friday","confidence":0.82,"firstSeen":"2026-10-16T08:00:00.000Z","lastSeen":"2026-10-18T09:12:03.420Z","receipts":["evt_01K7ZT9P4N5Q6R7S8T9V0W1X2Y"],"userEdited":false}],"place":[],"rituals":[],"friction":[],"drives":[],"taste":[],"constraints":[],"spendingPosture":[]},"excerptPolicy":{"maxChars":20000,"allowSections":["mission","friction","drives"]}}`

### 4.3 `Objective` (local)

- **Purpose:** a candidate objective produced by the drives engine, before publication. Holds the local evidence links.
- **Schema:** `schemas/objective.schema.json`

| Field | Type | R | PC | Description |
|---|---|---|---|---|
| `objectiveId` | `Id(obj)` | yes | L → RS (the id itself is sent) | |
| `soulVersion` | integer | yes | L | |
| `detector` | enum `placeholder` \| `repeated-error` \| `agent-refusal` \| `stale-work` \| `repeated-search` \| `copy-paste-loop` \| `deadline` | yes | RS | three in Phase 1 |
| `goal` | string ≤ 1,000 | yes | RS (after layer 2) | plain-language goal |
| `capabilities` | array of string ≤ 10 (capability tags, lowercase kebab) | yes | RS | for example `web-search` |
| `deadline` | `Timestamp` | no | RS | |
| `minutesSaved` | integer | yes | RS | estimate |
| `evidence` | array of `{eventId, beliefId?}` ≤ 50 | yes | L | local links |
| `observationHashes` | array of `Hash32` ≤ 50 | yes | HC | `keccak256(jcs(ActivityEvent minus eventId))` per linked event (§5.2) |
| `roi` | object `{hourlyBand: enum A..E, ratio: number}` | yes | RS (band only) | value-of-time filter output |
| `status` | enum `candidate` \| `dismissed` \| `shadowed` \| `published` | yes | L | `shadowed` = priced in shadow mode only, never sent for payment (AM-14) |

### 4.4 `ObjectiveSubmission`

- **Purpose:** the only object the daemon sends to the server for a new objective (D25). No `local-only` field exists in this schema.
- **Schema:** `schemas/objective-submission.schema.json`

| Field | Type | R | PC | Description |
|---|---|---|---|---|
| `objectiveId` | `Id(obj)` | yes | RS | |
| `objectiveHash` | `Hash32` | yes | HC | §5.2 |
| `soulVersionHash` | `Hash32` | yes | HC | §5.2 |
| `observationHashes` | array of `Hash32` | yes | HC | |
| `detector`, `goal`, `capabilities`, `deadline`, `minutesSaved` | as §4.3 | yes/no | RS | |
| `hourlyBand` | enum `A`..`E` | yes | RS | A < $25/h … E > $200/h; the exact amount stays local |
| `constraints` | object `{maxTotal?: Amount6, categoriesAllowed?: string[], noNewPayees?: boolean}` | no | RS | from soul constraints |
| `redaction` | object `{layer2: {hits: integer, entities: string[]}}` | yes | RS | counts and entity names only |
| `deviceId` | `Id(dev)` | yes | SO | from the device token |
| `submittedAt` | `Timestamp` | yes | RS | |

- **Invariants:** `objectiveHash` recomputes from the fields in §5.2; `goal` contains no unmarked PII per layer 2 (best effort, C2-03).
- **Example (invented):** `{"schemaVersion":"1.0","objectiveId":"obj_01K7ZTA0B1C2D3E4F5G6H7J8K9","objectiveHash":"0x9c…","soulVersionHash":"0x7a…","observationHashes":["0x11…","0x12…"],"detector":"placeholder","goal":"Fill the competitor price table for 5 named competitors","capabilities":["web-search","page-extract","table-build"],"deadline":"2026-10-23T17:00:00.000Z","minutesSaved":95,"hourlyBand":"C","redaction":{"layer2":{"hits":0,"entities":[]}},"deviceId":"dev_01K7…","submittedAt":"2026-10-18T09:30:00.000Z"}`

### 4.5 `Plan`

- **Purpose:** the priced plan for one objective (spec 01 CZ-13). What the user approves. `planHash` is written into the envelope.
- **Schema:** `schemas/plan.schema.json`

| Field | Type | R | PC | Description |
|---|---|---|---|---|
| `planId` | `Id(pln)` | yes | SO | |
| `objectiveId`, `objectiveHash` | | yes | SO / HC | |
| `planHash` | `Hash32` | yes | HC | §5.2 |
| `network` | `Caip2` | yes | HC | |
| `category` | string (lowercase kebab, ≤ 32) | yes | HC | `categoryId = keccak256(utf8(category))` on-chain |
| `cap` | `Amount6` | yes | HC | envelope cap = Σ step caps × (1 + slack) |
| `slackBps` | `Bps` | yes | HC | default 2500 |
| `maxStepAmount` | `Amount6` | yes | HC | max over step caps |
| `pocketCapBps` | `Bps` | yes | HC | `0` unless the plan has a `gateway-nano` step, then `2500` (D22, D71); the pocket steps' caps plus the gas grant must fit in `cap × pocketCapBps / BPS`, else the router moves steps to vault-direct |
| `pocket` | `Address` | no | HC | the pocket EOA the plan will use; present if and only if the plan has a `gateway-nano` step; committed in `payeeLeaves` as a kind-4 leaf (D71) |
| `expiresAt` | `Timestamp` | yes | HC | envelope expiry |
| `steps` | array of `Step` ≤ 64 | yes | SO (hashes HC) | |
| `payeeLeaves` | array of `PayeeLeaf` | yes | HC | §5.3; plan payees plus ≤ 2 alternates per step (D36), plus one kind-4 pocket leaf when `pocket` is set (D71) |
| `payeeRoot` | `Hash32` | yes | PUB | Merkle root of `payeeLeaves` (§5.3) |
| `rankingDecisionIds` | array of string | no | SO | SL `query_id`s used |
| `shadow` | boolean | yes | SO | true for shadow-mode pricing (no envelope) |
| `createdAt` | `Timestamp` | yes | SO | |

- **Invariants:** `cap ≥ Σ steps[].stepCap`; every step's `payee` and `alternates[]` appear in `payeeLeaves` with that step's `stepIndex` and `stepCap`; `maxStepAmount = max(steps[].stepCap)`; `payeeRoot` recomputes; `pocketCapBps = 0` and no kind-4 leaf when no step is `gateway-nano`, otherwise exactly one kind-4 leaf `{payee: pocket, kind: 4, stepIndex: 4294967295, stepCap: "0"}` (D71).

### 4.6 `Step`

| Field | Type | R | PC | Description |
|---|---|---|---|---|
| `stepIndex` | integer 0–63 | yes | HC | position; used in `PayeeLeaf` |
| `stepId` | `Id(stp)` | yes | SO | |
| `kind` | enum `x402-exact` \| `gateway-nano` \| `erc8183-job` \| `local` \| `tip` (P2) | yes | SO | from the router (spec 01 §8.7, D37) |
| `capability` | string | yes | SO | |
| `serviceId` | SL `ServiceId` | no | SO | |
| `resource` | object `{url, method}` | no | SO | the merchant endpoint |
| `payee` | `Address` | no | HC | `payTo` or job provider; absent for `local` |
| `alternates` | array of `Address` ≤ 2 | no | HC | D36 |
| `unitAmount` | `Amount6` | yes | HC | expected price per call (from the live 402, p1-D7) |
| `expectedCalls` | integer ≥ 1 | yes | SO | `n` for batch sizing (D37) |
| `stepCap` | `Amount6` | yes | HC | ≥ `unitAmount × expectedCalls` |
| `routingReason` | string | yes | SO | for example `below-pocket-threshold` |
| `acceptanceProfileId` | SL `ProfileId` | yes | SO | |
| `inputTemplate` | object | no | SO | structured input only, never user text (spec 01 §11.2 layer 3); optional `inputTemplate.expectedKeys: string[]` (≤ 50, each ≤ 64) names the output keys the `requirement` check (CZ-16) and the reader's `expectedFields` (P-02) look for (AM-09); `inputTemplate.inputKeys: [{name, type: string\|number\|boolean, maxLength?, enum?}]` (≤ 20) names the only input keys a `pay` call may send for this step (RV-021) |
| `dependsOn` | array of `stepIndex` | no | SO | |

### 4.7 `PayeeLeaf`

| Field | Type | R | PC | Description |
|---|---|---|---|---|
| `payee` | `Address` | yes | PUB (in proofs) | |
| `kind` | integer: `1` x402 payTo, `2` ERC-8183 provider, `3` tip repo (P2, payee = `BuilderEscrow`), `4` pocket EOA (D71) | yes | PUB | |
| `stepIndex` | integer | yes | PUB | 0–63 for kinds 1–3; always `4294967295` (`POCKET_STEP_INDEX`) for kind 4 |
| `stepCap` | `Amount6` | yes | PUB | the per-step cap shared by the payee and its alternates (D36), enforced per step on-chain through `stepUsed` (RV-002); always `"0"` for kind 4 (the pocket's bound is `cap × pocketCapBps / BPS`) |

Leaf hash: §5.3.

### 4.8 `Envelope` (server mirror of chain state)

- **Source of truth:** the `CzarVault` contract (spec 03 §czar-vault). The mirror is rebuilt from events by the indexer.
- **Schema:** `schemas/envelope.schema.json`

| Field | Type | R | PC | Description |
|---|---|---|---|---|
| `envelopeRef` | string `Caip10(vault)` + `:` + `envelopeId` | yes | PUB | global reference |
| `vault` | `Address` | yes | PUB | |
| `envelopeId` | integer (`uint64`) | yes | PUB | per-vault counter |
| `planId` | `Id(pln)` | no | SO | |
| `objectiveHash`, `planHash`, `payeeRoot` | `Hash32` | yes | PUB | from `EnvelopeOpened` |
| `categoryId` | `Hash32` | yes | PUB | |
| `cap`, `maxStepAmount` | `Amount6` | yes | PUB | |
| `pocketCapBps` | `Bps` | yes | PUB | |
| `expiresAt` | `UnixSeconds` | yes | PUB | |
| `approver` | enum `owner` \| `agent` | yes | PUB | who opened it |
| `approvalTx` | `Hash32` | yes | PUB | the UserOp's transaction hash or the agent tx |
| `spent`, `reserved`, `pocketOutstanding`, `jobEscrowed` | `Amount6` | yes | PUB | live counters |
| `state` | enum `Open` \| `Closing` \| `Closed` | yes | PUB | `Open`/`Closed` from events; `Closing` is derived by the indexer: on-chain `Open` and (`now ≥ expiresAt`, or the server has begun the close sequence: a pullback requested for the envelope's pocket or a `finalize` pending) (RV-048) |
| `shortfall` | `Amount6` | yes | PUB | from `ShortfallRecorded` (RV-011) |
| `pocket` | `Address` | no | PUB | the envelope's single pocket, from `PocketRegistered` |
| `lastEventBlock` | integer | yes | SO | indexer cursor |

- **Invariants (mirror of on-chain):** `spent + reserved + pocketOutstanding + jobEscrowed + shortfall ≤ cap`.

### 4.9 `Reservation` (mirror)

| Field | Type | R | PC | Description |
|---|---|---|---|---|
| `vault`, `reservationId` (`uint64`) | | yes | PUB | |
| `envelopeId`, `stepIndex` | | yes | PUB | |
| `payee` | `Address` | yes | PUB | |
| `unitAmount` | `Amount6` | yes | PUB | per authorization |
| `count` | integer 1–128 | yes | PUB | `N` |
| `validBefore` | `UnixSeconds` | yes | PUB | |
| `mode` | enum `envelope` \| `digest` | yes | PUB | AR-3 primary or fallback (§6.3) |
| `settledMask` | `Hash32` (128-bit mask, hex) | yes | PUB | which indices settled |
| `settledCount`, `releasedCount` | integer | yes | PUB | both stored on-chain; the reservation is `Final` exactly when `settledCount + releasedCount == count` (RV-001) |
| `state` | enum `Active` \| `Finalizing` \| `Final` | yes | PUB | |
| `paymentIds` | array of `paymentId` by index | no | SO | §7.4 |

### 4.10 `PocketRecord` (mirror + server)

| Field | Type | R | PC | Description |
|---|---|---|---|---|
| `vault`, `envelopeId` | | yes | PUB | |
| `pocket` | `Address` | yes | PUB | the EOA |
| `keyRef` | string | yes | SO | KMS key id, never the key |
| `state` | enum `Registered` \| `DelegateReady` \| `Funded` \| `Draining` \| `Closed` | yes | PUB | on-chain `PocketState` except `DelegateReady`, which the indexer derives: on-chain `Registered` and GatewayWallet emitted `DelegateAdded(USDC, pocket, vault)` for this vault (RV-048) |
| `funded` | `Amount6` | yes | PUB | Σ `fundPocket` |
| `gasGranted` | `Amount6` | yes | PUB | native sent for gas, in 6-dec units |
| `outstanding` | `Amount6` | yes | PUB | funded − confirmed pullbacks |
| `pendingPullback` | `Amount6` | yes | PUB | Σ pending pullback values |
| `pullbacks` | array of `PullbackRecord` | yes | PUB | |
| `gatewayTransferIds` | array of string | no | SO | nanopayment ids from the Gateway API (A2-29) |

`PullbackRecord`: `{pullbackId (uint64), value: Amount6, salt: Hash32, maxFee: Amount6, maxBlockHeight: integer, transferSpecHash: Hash32, requestedAtBlock: integer, state: Pending|Confirmed|Cancelled, recovery: boolean, creditedToEnvelope?: boolean, attestationTransferId?: string (SO), mintTx?: Hash32}`. `recovery` marks a pullback of a `Closed` pocket, credited to free balance (RV-004).

### 4.11 `JobRecord` (mirror + server)

| Field | Type | R | PC | Description |
|---|---|---|---|---|
| `vault`, `envelopeId`, `stepIndex` | | yes | PUB | |
| `jobEscrow` | `Address` | yes | PUB | which instance (Circle testnet or `CzarJobEscrow`) |
| `jobId` | integer (`uint256`) | yes | PUB | the escrow's id |
| `jobKey` | `Hash32` | yes | PUB | `keccak256(abi.encode(jobEscrow, jobId))` |
| `provider`, `evaluator` | `Address` | yes | PUB | |
| `reservedCap` | `Amount6` | yes | PUB | step cap reserved at `openJob` |
| `budget` | `Amount6` | no | PUB | from `BudgetSet`/`getJob` |
| `descriptionHash` | `Hash32` | yes | PUB | what went into the on-chain `description` string: `czar:<hash>` |
| `deliverableHash` | `Hash32` | no | PUB | from `JobSubmitted` |
| `deliverableUri` | string (https URI) | no | SO | where the evaluator fetches the work: `https://<provider-host>/.well-known/czar-deliverable/<deliverable-hex>`; the fetched bytes MUST keccak256 to `deliverableHash`, else the deliverable is treated as missing (D53, AM-08). ERC-8183 fixes only the `bytes32` (A4-03); this convention is Czar's and is stated in the job brief |
| `reportHash` | `Hash32` | no | PUB | the `reason` passed to `complete`/`reject` |
| `state` | enum `Opened` \| `Funded` \| `Submitted` \| `Completed` \| `Rejected` \| `Expired` \| `Refunded` \| `Released` | yes | PUB | `Released` = an unfunded job the vault released (`JobSynced(state = 6)`, RV-009) |
| `expiredAt` | `UnixSeconds` | yes | PUB | |

### 4.12 `PaymentRef`

- Adopted from SL §5.2 verbatim, with two Czar additions marked (★):

```ts
type PaymentRef =
  | { rail: "x402-exact"; network: Caip2; asset: Address; payer: Address; payTo: Address;
      amount: Amount6; nonce: Hash32; validBefore: number; settlementTx?: Hash32;
      reservationId?: number; index?: number }                                  // ★ vault bookkeeping
  | { rail: "gateway-batched"; network: Caip2; payer: Address; payTo: Address; amount: Amount6;
      nonce: Hash32; transferId?: string; batchTx?: Hash32 }
  | { rail: "erc8183-job"; network: Caip2; contract: Address; jobId: string; client: Address;
      provider: Address; evaluator: Address; budget: Amount6 }
  | { rail: "mpp"; network: Caip2; chargeId: string; payer: Address; payTo: Address;
      amount: Amount6; settlementTx?: Hash32 };                                  // SL-F27 GAP, unused
// paymentRefHash = keccak256(jcs(PaymentRef without the ★ fields))  — identical to SL for interoperability
```

- Privacy: all fields `PUB` (payments are public on-chain or in the rail's records, p1-G10). The ★ fields are `SO` and excluded from `paymentRefHash`.
- Schema: `schemas/payment-ref.schema.json`.

### 4.13 `Receipt`

- Adopted from SL §5.4 (`ObservationCore` with `kind = "receipt"`) and signed as SL §5.8 `Receipt`.
- Czar-specific: `reporter.kind = "buyer"`, `reporter.address` = the vault (vault-direct, signature valid under ERC-1271 kind `SL_RECEIPT`) or the pocket EOA (Gateway); for `erc8183-job` receipts the vault signs under the same `SL_RECEIPT` kind, because the vault is the job client (AM-10); `disclosure = "hash-only"` by default.
- Schema: `schemas/receipt.schema.json` (wraps the SL `Observation` shape plus `envelopeRef`, `stepIndex` as `SO`).

### 4.14 `AcceptanceReport`

- Adopted from SL §5.5 `ValidationReportCore` with `assignment.kind = "buyer-local"` and `conflict_flags = ["self-reported-checks"]` in Phases 1–2 (spec 01 §15.3).
- Czar additions (`SO`): `envelopeRef`, `stepIndex`, `jobKey?`, `decision: pass|fail|inconclusive`, `reportHash` (= keccak256(jcs(report minus reportHash)); used as the ERC-8183 `reason`, `HC`).
- Documented vocabulary (AM-11): `limits` values include `no-correctness-check`, `screen-unavailable`, `sandbox-timeout`; optional `flags` with the value `injection-quarantined` (set when the P-01 screen held the body back).
- Schema: `schemas/acceptance-report.schema.json`.

### 4.15 `StepResult`

- **Purpose:** the only form in which untrusted merchant output reaches the planner (spec 01 §13.1). Produced by the reader model under a fixed schema.
- **Schema:** `schemas/step-result.schema.json`

| Field | Type | R | PC | Description |
|---|---|---|---|---|
| `stepIndex` | integer | yes | SO | |
| `status` | enum `delivered` \| `http-error` \| `timeout` \| `no-response` \| `unknown` | yes | SO | SL outcome vocabulary |
| `source` | object `{origin: string, payTo: Address, paymentRefHash: Hash32}` | yes | SO | label of where the text came from |
| `fields` | array of `{name: string ≤ 64, value: string ≤ 2,000, confidence: number}` ≤ 50 | yes | SO | extracted values; values are data, JSON-encoded, never instructions |
| `flags` | array of enum `injection-suspect` \| `schema-mismatch` \| `truncated` \| `pii-suspect` | yes | SO | from the screen and reader |
| `bodyRef` | string | no | SO | object-store key of the raw body (never inlined) |
| `bodyCommit` | `Hash32` | yes | HC | SL `responseCommit` |

- **Invariant:** no free-text field other than `fields[].value`, and the planner prompt wraps the whole object in a labelled `tool_result` (C3-04).

### 4.16 `StepError`

`{code: string, message: string (no user text), retryable: boolean, elicitationUrl?: string}`. Used by MCP tools and APIs.

### 4.17 `DemandProofLeaf` (version 2, RV-026)

- **Purpose:** the proof-of-demand chain for one objective (product §6.22), anchored as a leaf in Czar's `EVIDENCE_BATCH`.
- **Schema:** `schemas/demand-proof-leaf.v2.schema.json`. All fields `PUB` (hashes and public refs only).
- **Superseded by RV-026:** version 1 (`schemas/demand-proof-leaf.schema.json`), which carried `userPseudonym` and the bare `soulVersionHash`. Both also appear in the public soul-version leaf (§4.18), so anyone reading the archive could join a user's soul-version history to their vault and every payment, and re-link them after each pseudonym rotation. Version-1 leaves are never produced.

| Field | Type | R | Description |
|---|---|---|---|
| `leafType` | const `"demand-proof"` | yes | |
| `leafVersion` | const `2` | yes | |
| `observationHashes` | array of `Hash32` | yes | |
| `objectiveHash` | `Hash32` | yes | |
| `soulVersionCommit` | `Hash32` | yes | `keccak256(abi.encode(soulVersionHash, demandSalt))`, where `demandSalt = keccak256(abi.encode(userDemandSecret, vault, envelopeId))` is per envelope, `SO`, and never used in any soul-version leaf. The user can fetch the salt for one envelope in the app (`getEnvelope`) and reveal it to prove which soul version the demand came from; no one else can link the leaf to a soul-version leaf |
| `planHash` | `Hash32` | yes | |
| `envelopeRef` | string | yes | |
| `approval` | object `{approver: owner\|agent, txHash: Hash32, blockNumber: integer}` | yes | |
| `paymentRefHashes` | array of `Hash32` | yes | one per step payment |
| `outcomeHashes` | array of `Hash32` | yes | `reportHash` per step |
| `closedAt` | `UnixSeconds` | yes | |

- **Invariant:** `envelopeRef`'s on-chain `EnvelopeOpened` event carries the same `objectiveHash` and `planHash`. The leaf carries no pseudonym and no value that also appears in a `soul-version` leaf.

### 4.18 `SoulVersionLeaf`

`{leafType: "soul-version", leafVersion: 1, userPseudonym: Hash32, soulVersion: integer, soulVersionHash: Hash32, previousHash?: Hash32, compiledAt: UnixSeconds}`. All `PUB`. Schema `schemas/soul-version-leaf.schema.json`. `userPseudonym` appears **only** in soul-version leaves; no leaf that names a vault, an envelope or a payment carries it or `soulVersionHash` (RV-026).

### 4.21 `JobBrief` (RV-025)

- **Purpose:** tells an ERC-8183 provider what the job is. The on-chain `description` carries only `"czar:" + descriptionHash` (p1-E7); the brief is the preimage the provider needs, served only to that provider.
- **Schema:** `schemas/job-brief.schema.json`. Privacy class `server-only` (sent to the job's provider only; never public, never on-chain).
- **Route:** `GET /v1/jobs/{jobKey}/brief` (`getJobBrief`, §9.2), authenticated by an EIP-712 `BriefRequest` signature from the job's `provider` address (§6.2), so only the provider named on-chain can read it.

| Field | Type | R | PC | Description |
|---|---|---|---|---|
| `briefVersion` | const `1` | yes | SO | |
| `network` | `Caip2` | yes | SO | |
| `jobEscrow`, `jobId`, `jobKey` | `Address`, string, `Hash32` | yes | SO | which job this brief is for |
| `planHash`, `stepIndex`, `acceptanceProfileId` | `Hash32`, integer, string | yes | SO | the `descriptionHash` preimage fields (§5.2) |
| `capability` | string | yes | SO | taxonomy tag |
| `inputs` | object | yes | SO | the structured step input, keys only from `inputTemplate.inputKeys` (RV-021); never free user text |
| `inputSalt` | `Hash32` | yes | SO | random per job; stops anyone guessing low-entropy `inputs` from the public hash |
| `inputCommit` | `Hash32` | yes | SO | `H({hashRule:"czar-hash-v1", kind:"job-input", inputs, inputSalt})` (§5.2) |
| `deliverable` | object `{mimeType, expectedKeys?: string[], schema?: object (≤ 8 KiB), uriConvention}` | yes | SO | what to submit; `uriConvention` = `https://<provider-host>/.well-known/czar-deliverable/<deliverable-hex>` (D53); bytes must hash to the submitted `deliverable`, else the job is rejected (D77) |
| `budgetCap` | `Amount6` | yes | SO | the job's `reservedCap`: `setBudget` above it is refused (`BudgetExceedsReserved`) |
| `evaluator` | `Address` | yes | SO | K7 |
| `expiredAt` | `UnixSeconds` | yes | SO | |
| `issuedAt` | `Timestamp` | yes | SO | |

- **Provider check:** recompute `inputCommit`, then `descriptionHash` (§5.2), and compare with the job's on-chain `description`.


### 4.19 `RankingDecision`

- Adopted from SL §5.6 verbatim. Schema `schemas/ranking-decision.schema.json` mirrors the TypeScript shape. Privacy `SO` (the SL's own publication rules apply when the full Selection Layer ships).

### 4.20 `EvidenceBatch`

`{batchId: Id(bat), publisher: Address, kind: "EVIDENCE_BATCH", prevRoot: Hash32, root: Hash32, leaves: array of {leafType, leafHash: Hash32, contentUri?: string}, uriHash: Hash32, archiveUri: string, cid?: string, committedTx?: Hash32}`. All `PUB`.

- **Phase 1 archive (D54, D78):** the archive (JSON Lines of the leaf objects, public rows only per SL §11) is served by Czar's local server. `archiveUri` is the host-free `czar-archive:<root>` (lowercase hex root), never a localhost URL, because the anchor is permanent and the public archive host arrives only in stage 2 (RV-028); `uriHash = keccak256(utf8(archiveUri))`. Readers resolve it against the archive hosts in Czar's latest `POLICY_RELEASE`; the anchored `root` lets anyone check the archive's leaves, so availability depends on Czar's hosts but integrity does not. `EvidenceBatch.archiveUri` uses this form.
- **Phase 2:** archives are also pinned to IPFS; `cid` is set and `uriHash = keccak256(CID)` (SL §7.1). Pin providers are chosen in Phase 2.
- Leaves are `demand-proof`, `soul-version`, or SL rows (`observation`, `report`, `assessment`, `correction`, `exposure`, `submission-log`). Schema `schemas/evidence-batch.schema.json`.

---
## 5. Canonical hashing and Merkle rules

### 5.1 Canonical JSON (`jcs`)

- `jcs(x)` = the RFC 8785 JSON Canonicalization Scheme serialization of `x`, as UTF-8 bytes. Object keys sorted by UTF-16 code units, no whitespace, numbers in the shortest round-trip form, strings escaped per RFC 8785.
- Before canonicalizing, Czar normalizes: addresses lowercase; `Amount6` stays a string; timestamps as given (RFC 3339 `Z`); absent optional fields are omitted (never `null`); a `hashRule` field names the rule version (`"czar-hash-v1"`).
- `H(x) = keccak256(jcs(x))`. All hashes are 32 bytes, hex lowercase with `0x`.
- This matches SL §5 ("keccak256 over canonical JSON (RFC 8785 JCS)"), so SL ids (`obs_`, `rep_`) and Czar hashes share one canonical form.

### 5.2 Named hashes

| Hash | Preimage (`jcs` of this object) | Notes |
|---|---|---|
| `observationHash` | `{hashRule:"czar-hash-v1", kind:"observation", host, sessionRef, projectRef, eventType, occurredAt, toolName?, summary, fileRefs?, errorClass?, provenance}` from an `ActivityEvent` | excludes `eventId`, `redaction`, `durationMs`, `agentRef`, `mcp`, `hostVersion`; the daemon keeps the preimage; the server sees only the hash |
| `objectiveHash` | `{hashRule:"czar-hash-v1", kind:"objective", objectiveId, soulVersionHash, observationHashes (sorted ascending), detector, goal, capabilities (as given), deadline?, minutesSaved, hourlyBand}` | `goal` is the redacted text; the server can recompute from the submission |
| `soulVersionHash` | `{hashRule:"czar-hash-v1", kind:"soul", version, compiledAt, previousHash?, sectionHashes}` where `sectionHashes[s] = H({section:s, beliefs:[{beliefId, text, confidence, firstSeen, lastSeen, receipts(sorted)}]})` | belief `text` never leaves; only the hash does; the person can prove any belief later by revealing it |
| `planHash` | `{hashRule:"czar-hash-v1", kind:"plan", planId, objectiveHash, network, category, cap, slackBps, maxStepAmount, pocketCapBps, expiresAt, payeeRoot, steps:[{stepIndex, kind, payee?, alternates?, unitAmount, expectedCalls, stepCap, acceptanceProfileId, serviceId?}]}` | excludes `resource` URLs and `inputTemplate` (server-only) |
| `reportHash` | `jcs(AcceptanceReport minus reportHash)` | the ERC-8183 `reason` |
| `paymentRefHash` | SL §5.2 (`PaymentRef` without ★ fields) | |
| `descriptionHash` | `H({hashRule:"czar-hash-v1", kind:"job-description", planHash, stepIndex, acceptanceProfileId, inputCommit})` | the ERC-8183 `description` string is `"czar:" + descriptionHash` |
| `inputCommit` | `H({hashRule:"czar-hash-v1", kind:"job-input", inputs, inputSalt})` with `inputs` and `inputSalt` from the `JobBrief` (§4.21) | RV-025: previously used but never defined |
| `soulVersionCommit` | `keccak256(abi.encode(bytes32 soulVersionHash, bytes32 demandSalt))`, `demandSalt = keccak256(abi.encode(bytes32 userDemandSecret, address vault, uint64 envelopeId))` | RV-026: the only soul reference in a public demand-proof leaf |

### 5.3 Merkle rules (`czar-merkle-v1`)

One rule for every tree Czar builds: evidence batches, feature snapshots and `payeeRoot`.

- **Leaf hash:** `leaf = keccak256(bytes.concat(keccak256(abi.encode(TAG, ...fields))))`. The inner keccak gives a 32-byte preimage for the outer keccak, so a leaf can never be confused with a node (whose preimage is 64 bytes). This is the OpenZeppelin "standard tree" convention (`MerkleProof.sol` v5.7.0 lines 16–19 warn about 64-byte leaf values; double hashing removes the risk).
- **Tags** (`bytes32`, computed in `vectors/eip712-vectors.json` → `kindTags`):
  - `PAYEE_LEAF = keccak256("czar.payee-leaf.v1")` = `0xabf82537a2dce15f109dca3554542a6a546f104bd1343c99de6c06fdd41462fe`
  - `EVIDENCE_LEAF = keccak256("czar.evidence-leaf.v1")` = `0x001eebeec2e768ec1a3711bc88cdd151a64d6e886b4ea663df8111ec36edda56`
- **Payee leaf fields:** `abi.encode(PAYEE_LEAF, address payee, uint8 kind, uint32 stepIndex, uint256 stepCap)`.
- **Evidence leaf fields:** `abi.encode(EVIDENCE_LEAF, bytes32 leafTypeHash, bytes32 contentHash)` where `leafTypeHash = keccak256(utf8(leafType))` and `contentHash = H(leaf object)`.
- **Node hash:** `node = keccak256(abi.encode(min(a,b), max(a,b)))` (OpenZeppelin `Hashes.commutativeKeccak256`, v5.7.0 lines 17–19). Pairs are sorted, so proofs need no left/right flags.
- **Tree shape:** leaves are sorted ascending by leaf hash, then paired left to right level by level. A level with an odd count carries its last node up unchanged.
- **Empty tree:** root = `bytes32(0)`. An empty batch is never anchored; an envelope MUST have ≥ 1 payee leaf unless every step is `local`.
- **Single leaf:** root = the leaf hash; proof = `[]`.
- **Proof format:** `bytes32[]` of sibling hashes from the leaf up. Verified with `MerkleProof.verify(proof, root, leaf)`.
- **Multiproofs:** not used.
- **Difference from the Selection Layer:** SL §7.1 anchors "Merkle root or content hash" without fixing the pair rule. Czar fixes it as above and publishes it in the policy tarball so alternative rankers can verify Czar's batches. SL evidence batches built by Czar use these rules; SL ids (`obs_`, `rep_`) are unchanged.

---

## 6. EIP-712 types

All type strings, type hashes and domain separators below were computed with viem 2.57.2 (`vectors/compute-eip712-vectors.mjs`, output `vectors/eip712-vectors.json`, run 2026-10-18, rerun 2026-10-19 after RV-013 and RV-061; the script's output now reproduces the JSON file byte for byte). Values that also appear in vendor source were checked against it and match.

### 6.1 Domains

| Domain | `name` | `version` | `chainId` | `verifyingContract` | Domain type hash | Separator (testnet 5042002) | Separator (mainnet 5042) | Source |
|---|---|---|---|---|---|---|---|---|
| USDC | `USDC` | `2` | yes | `0x3600000000000000000000000000000000000000` | `0x8b73c3c6…400f` (full) | `0x361191522483d32a83e70ae7183b4b9629442c13a78bc9921d6f707911c8c6b0` | `0x940506929bba468048a19b567f4f0d534714bc06604b5c3017e5d16785ccdf84` | A1-03 (matches `0x3611…c6b0` / `0x9405…df84`); `FiatTokenV2_2.sol` line 83 hard-codes `"2"`; `eip712Domain()` reverts so clients hard-code `name`/`version` |
| GatewayWallet | `GatewayWallet` | `1` | **none** | **none** | `0xb03948446334eb9b2196d5eb166f69b9d49403eb4a12f36de8d3f9f3cb8e15c3` | `0x23a37920eca61226c76d13c4462857a362147e4b18da665dba894fa297ae4f34` (same on every chain) | same | `EIP712Domain.sol` lines 29–42 (omits chainId and verifyingContract on purpose) |
| CzarVault | `CzarVault` | `1` | yes | the vault address | `0x8b73c3c6…400f` | per vault; example `0x64b8044a…b6b0` for vault `0x…0c2a21` | example `0xc5b5d62f…a755` | new |
| SelectionLayer | `SelectionLayer` | `1` | yes | none | `0xc2f87871…5b6e` (no contract) | `0x4937387a5eb9c824f88751eb9abc6792a901e035deb9ec3fa75f584cc4669f69` | `0x2a6156c387de0428b039beeb8edae161131616d6fc1fd3901b1f1836dfdc5a82` | SL §5.8 |

Digest = `keccak256("\x19\x01" ‖ domainSeparator ‖ structHash)` (EIP-712; Gateway `EIP712Domain.sol` line 103 uses OpenZeppelin `MessageHashUtils.toTypedDataHash`).

### 6.2 Types and type hashes

| Type | Exact type string | Type hash | Signer | Source |
|---|---|---|---|---|
| `TransferWithAuthorization` | `TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)` | `0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267` | the vault (ERC-1271, inner agent signature) | `EIP3009.sol` line 35 (matches) |
| `CancelAuthorization` | `CancelAuthorization(address authorizer,bytes32 nonce)` | `0x158b0a9edf7a828aad02f63cd515c68ef2f50ba807396f6d12842833a1597429` | optional, not used in Phase 1 | `EIP3009.sol` line 43 (matches) |
| `TransferSpec` | `TransferSpec(uint32 version,uint32 sourceDomain,uint32 destinationDomain,bytes32 sourceContract,bytes32 destinationContract,bytes32 sourceToken,bytes32 destinationToken,bytes32 sourceDepositor,bytes32 destinationRecipient,bytes32 sourceSigner,bytes32 destinationCaller,uint256 value,bytes32 salt,bytes hookData)` | `0x44409c7ba8872720f5fc290d2788c2d70a3905b7ca1cdb2ffa152791a69e089b` | (nested) | `TransferSpec.sol` lines 85–87 (matches) |
| `BurnIntent` | `BurnIntent(uint256 maxBlockHeight,uint256 maxFee,TransferSpec spec)` + the `TransferSpec` string | `0x8b99d17a83a2dd1add9fc2a450e22732c7e8564aa110ab99c20485a7a10ba37c` | the vault as delegate (TEE-vouched ERC-1271, A2-08, A2-19) | `BurnIntents.sol` lines 59–61 (matches) |
| `Receipt` | SL §5.8 string (13 fields) | `0xcd6ca6db33168140e9fc8604767fd5dc89fc51ca3853b876f9003e8bedd295f2` | vault (kind `SL_RECEIPT`) or pocket EOA | SL §5.8 |
| `ProbeObservation` | SL §5.8 | `0x082dc4c98e5ed9d44832847c1036fbda0c6c51f189f9539edadc1dc9f4aeb5ab` | prober (P3) | SL §5.8 |
| `ValidationReport` | SL §5.8 | `0x2f894791357c9968ede660d792c8ed847400a44300413a8a9980a411ae9a066a` | evaluator key K7 | SL §5.8 |
| `DeliveryAttestation` | SL §5.8 | `0xfdfd3bebe1937b601fca11051262263ef58ac3e4d2aa62e8baaa5df78435d599` | merchant payTo (optional) | SL §5.8 |
| `Correction` | SL §5.8 | `0x0e810e2b9d0736a6477b5f9ad4a10c3f02df00e32177bf40b65d3cff40dd715a` | claimed merchant / reporter | SL §5.8 |
| `ServiceClaim` | SL §5.8 | `0xdac3f27f79f0e197bffa8d8002d877778392e96adeaf0e7d55e61f96c4a1039c` | merchant payTo | SL §5.8 |
| `AutonomyRaise` | `AutonomyRaise(bytes32 category,uint256 newLimit,uint64 periodId,uint256 nonce,uint256 deadline)` | `0x6247988191abc5977b0b6f569e66d23eff38cc0f0fe30f8ed678b03c3f21b368` | `autonomySigner` (K5) | new |
| `OwnerAction` | `OwnerAction(uint8 action,bytes32 payloadHash,uint256 nonce,uint256 deadline)` | `0x5a8b2f7d5d70ba2335e2ee47a9d897748d8694bdb44c148ad01f541eeb2f0248` | the owner's passkey (D30 fallback; WebAuthn challenge = this digest) | new |
| `BriefRequest` | `BriefRequest(bytes32 jobKey,uint64 issuedAt)` under domain `{name: "CzarJobBrief", version: "1", chainId}` (no contract; separator on 5042002 `0x8c06faf59aae1fd812b66bab954eb62f8a9a8d5607d9e79e5e83d67e60fd1e54`) | `0xe012200f525ff4d3cacf52809316e0f39197c977a4498fb16c875c1defcfc215` | the job's provider (EOA or ERC-1271) | new (RV-025) |
| `ReceiptAttestation` | `ReceiptAttestation(bytes32 receiptStructHash)` | `0x01b75f6051eb731488fad2e8de7925f8a64c89ef33c418e2a62e77ae02691eff` | `agentSigner` (K3), under the **CzarVault** domain of one vault; `receiptStructHash` = the SL `Receipt` struct hash | new (RV-013) |

`AutonomyRaise` fields: `category` = `keccak256(utf8(category))`; `newLimit` = `Amount6` as `uint256`; `periodId = floor(block.timestamp / 604800)`; `nonce` = the vault's `autonomyNonce`; `deadline` = unix seconds.

`OwnerAction` fields: `action` enum `1 OPEN_ENVELOPE`, `2 SET_LIMITS`, `3 FREEZE`, `4 UNFREEZE`, `5 WITHDRAW`, `6 ROTATE_SIGNERS`, `7 SET_PASSKEY`, `8 CLOSE_ENVELOPE`, `9 FORCE_CLOSE_ENVELOPE`, `10 RECORD_MANUAL_RETURN`, `11 RAISE_AUTO_LIMIT`, `12 LOWER_AUTO_LIMIT`, `13 REQUEST_PULLBACK`, `14 CANCEL_PULLBACK`, `15 WRITE_OFF_POCKET`, `16 SET_MAX_PULLBACK_FEE` (9–16 added by RV-033 and D81; the type string is unchanged); `payloadHash = keccak256(abi.encode(...args of the matching vault function))` (spec 03 lists the encoding per action); `nonce` = the vault's `ownerActionNonce`; `deadline` unix seconds.

### 6.3 Vault signature envelopes (bytes passed to `isValidSignature`)

The vault's `isValidSignature(bytes32 digest, bytes signature)` reads the first 32 bytes of `signature` as a kind tag, unless `signature.length == 65` (fallback, §6.3.4). Kind tags (from `vectors/eip712-vectors.json`):

| Kind | Tag (`bytes32`) | Preimage |
|---|---|---|
| `USDC_3009` | `0x86b499474d9c0ea9b4a99b5ce22c4ae0f1ef4bf774214e3c1e4095c0371888cb` | `keccak256("czar.vault.sig.USDC_3009.v1")` |
| `GATEWAY_BURN` | `0xf453aa3365355a8cf99e674b4443d5009b132245c53a3eb3b5a14953d97265f2` | `keccak256("czar.vault.sig.GATEWAY_BURN.v1")` |
| `SL_RECEIPT` | `0x01c314900cb74ef1a689e81bddd748cc950a7aceb730d7cb9b7660a5aa6a3eaa` | `keccak256("czar.vault.sig.SL_RECEIPT.v2")` (RV-013). The retired `.v1` tag `0x6caa53e9…8601f` (opaque struct hash) is refused by the vault |

#### 6.3.1 `USDC_3009` (primary encoding, AR-3 true)

`signature = abi.encode(bytes32 kind, uint64 reservationId, uint32 index, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes agentSig)`

- `agentSig` is exactly 65 bytes `r ‖ s ‖ v` with `v ∈ {27, 28}` and low `s`.
- Total length: 9 head words + `bytes` tail (32 length + 65 padded to 96) = 416 bytes. USDC's `transferWithAuthorization(…,bytes)` overload `0xcf092995` accepts any length and Circle's relayer uses that overload (A1-08, A1-18, A1-20).
- The vault recomputes `digest' = toTypedDataHash(USDC_DOMAIN_SEPARATOR, keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, address(this), to, value, validAfter, validBefore, nonce)))` and requires `digest' == digest`. Checks continue in spec 03 (`czar-vault.md` §6).

#### 6.3.2 `GATEWAY_BURN`

`signature = abi.encode(bytes32 kind, uint64 pullbackId, bytes agentSig)`

- The vault rebuilds the full `BurnIntent` struct hash from the stored `PullbackRecord` plus its immutables (spec 03 `czar-vault.md` §6), computes `digest' = toTypedDataHash(GATEWAY_DOMAIN_SEPARATOR, structHash)` with the chain-less GatewayWallet domain, and requires `digest' == digest`.
- This path is exercised off-chain: Circle's TEE simulates `isValidSignature` through `eth_call` against a 2-of-3 RPC quorum (A2-08) and then signs the on-chain burn itself (`Burns.sol` lines 328–339, path 2 "TEE vouch"). The request to `POST /v1/transfer` sets `contractSigner: true` and `spec.sourceSigner = vault` (A2-19c; `withdraw.ts` lines 32–37).

#### 6.3.3 `SL_RECEIPT` (v2, RV-013)

`signature = abi.encode(bytes32 kind, SlReceipt receipt, bytes agentSig)` where `SlReceipt` is the tuple of the 13 SL `Receipt` fields in type-string order `(bytes32 paymentRefHash, bytes32 requestCommit, bytes32 responseCommit, uint16 statusCode, string originAsserted, bytes32 requirementsHashSeen, uint64 tRequest, uint64 tPaymentSigned, uint64 tComplete, uint8 outcome, bytes32 localChecksCommit, uint8 disclosure, uint64 createdAt)`.

- The vault recomputes `structHash = hashStruct(Receipt, receipt)` (the SL §5.8 encoding, `originAsserted` hashed as `keccak256(bytes)`), requires `digest == toTypedDataHash(SELECTION_LAYER_DOMAIN_SEPARATOR(chainId), structHash)`, then requires `agentSig` to recover to `agentSigner` over `toTypedDataHash(CZAR_VAULT_DOMAIN_SEPARATOR(chainId, vault), hashStruct(ReceiptAttestation{receiptStructHash: structHash}))`.
- Why both steps: recomputing from fields pins the type to `Receipt`, so the vault can never attest a `Correction`, `ServiceClaim` or other SL type; the `ReceiptAttestation` wrapper carries the vault address in its domain, so one agent signature validates for exactly one vault (all vaults share `agentSigner`, spec 03 factory defaults). This is the ERC-7739 nesting idea applied to one type.
- What a verifier does: call `vault.isValidSignature(receiptDigest, signature)` with the SL `Receipt` digest it already computes; nothing else changes for SL readers.
- Not blocked by freeze (it moves no money). Used for vault-direct receipts and for `erc8183-job` receipts (the vault is the job client, AM-10). The signer signs a `ReceiptAttestation` only after rebuilding the `Receipt` struct hash from fields and matching `paymentRefHash` to a payment of this vault that the indexer has seen settled (spec 04 CZ-27 `sl-receipt`).

#### 6.3.4 Fallback encoding (AR-3 false: Facilitator rejects long signatures)

- `signature` = exactly 65 bytes (`agentSig`).
- The vault looks up `digestSlot[digest] → (reservationId, index)`; the slot was written by `reserveWithDigests` (spec 03), which computes each index's digest on-chain at reserve time and stores it. Everything else is identical to §6.3.1.
- **How the server picks:** a one-time keyless `/verify` against Circle's Facilitator with a §6.3.1-encoded signature from a deployed test vault on Arc testnet (A1-15: `/verify` costs nothing). If `isValid:true` → the server uses `mode = envelope` for every reservation. If the response is `invalid_exact_evm_payload_signature` or a length error → `mode = digest`. The result is stored as the server setting `vaultSignatureMode` and re-checked weekly. Both modes are always accepted by the vault, so a wrong setting only costs gas, never safety.
- Gas: the fallback adds one cold `SSTORE` (~22,100 gas) per index at reserve time, so the server keeps `count ≤ 8` in `digest` mode (spec 03 gas table).

#### 6.3.5 Domain separation argument

- `USDC_3009` digests carry the USDC domain separator (name `USDC`, chainId, USDC address); `GATEWAY_BURN` digests carry the GatewayWallet separator (name `GatewayWallet`, no chainId); `SL_RECEIPT` digests carry the SelectionLayer separator. Three different `\x19\x01`-prefixed preimages; a digest valid under one kind cannot equal a digest under another unless keccak256 collides.
- The kind tag is only a dispatch hint. The vault always recomputes the digest for the claimed kind from fields it controls and compares (for `SL_RECEIPT`, from the 13 `Receipt` fields, RV-013). A wrong tag yields a mismatch and `INVALID`.
- The inner agent signatures are separated too: `USDC_3009` and `GATEWAY_BURN` sign the outer digest itself; `SL_RECEIPT` signs the `ReceiptAttestation` digest under the vault's own domain, which no other kind uses.
- Any digest that does not match a kind's recomputation returns `0xffffffff`. The vault never returns `0x1626ba7e` for a bare `ecrecover` match.

### 6.4 Test vectors

Recorded in `vectors/eip712-vectors.json` (all message values invented):

| Vector | Digest |
|---|---|
| `usdcTransferWithAuthorization_5042002` (from example vault `0x…0c2a21`, to `0x…bEEF`, value 100000, validBefore 1760800000, nonce `0x11…11`) | `0x0b90a5995f31dd9e567d03c72be39bad175cf2bb4fc652767365a0b44bf366b0` |
| `gatewayBurnIntent_sameChain` (domains 26/26, wallet `0x0077…19B9`, minter `0x0022…475B`, depositor `0x…b0c0`, recipient = signer = vault, value 199600, maxFee 10000, maxBlockHeight 68000000, salt `0x22…22`, empty hookData) | `0xbaa687f22d9719e8afd3f756b6c2c3991f4fcf2674f419c095132f7ec22d6ec8`; byte-encoded `TransferSpec` length 340, `transferSpecHash = 0xa2f49c1a7ff819bf27ffd2ff6d87a0ea51b77284f7b879ac42deb760376d3616` |
| `slReceipt_5042002` | `0x8bef0825cbab5aff373a3651d22ee4169a09d1504ad6eb30c02277d37725d561`; struct hash `0xe79fd862d70a3af78fdf18fc3b4039605e1728e44110a659b1de9b4bd9c2f0df` |
| `receiptAttestation_5042002` (example vault `0x…0c2a21`, `receiptStructHash` = the `slReceipt` struct hash) | `0xe4f941d6e918d974ccc3f435b16b3dc38eaa8027fb1955a87ea3763d250e65a0` (RV-013) |
| `autonomyRaise_5042002` (category `keccak256("research")`, newLimit 5000000, periodId 2963, nonce 7, deadline 1792026000 = one hour into period 2963) | `0xb6d92f2ab8f255a7aa93ad87b86fb4e3c22ccc3f7b86c4b4988a8c1fdf2123a3` (RV-061: the earlier deadline 1760900000 preceded its period, so the vector could never execute) |
| `briefRequest_5042002` (jobKey for Circle's escrow and job 42, issuedAt 1792026000) | `0x991363ddab9205ec2a375be2469430bd8d1b2b9cb767f0e8f21218038a9954fe` (RV-025) |
| `ownerAction_5042002` (action 1, payloadHash `0x77…77`, nonce 3) | `0x69b896f95e60ed729ed2cfab1c7a025da52213188bb0fa2fcee14cda92c559f5` |
| `derivedNonce_example` (vault `0x…0c2a21`, reservationId 12, index 3) | nonce `0x1f7eb762975d3148f76637d5498c320aa01d5daa71be09a5e6ca4947371fd59f` |

Spec 03's Foundry tests MUST reproduce the seven on-chain entries (all but `briefRequest`, which only the server verifies) from the same inputs (`security-and-testing.md` §3.1); `@czar/hashing` reproduces all eight.

---

## 7. IDs, nonces and payment ids

### 7.1 Identifier formats

| Id | Format | Who mints | Scope | Collision note |
|---|---|---|---|---|
| `eventId` | `evt_<Ulid>` | daemon | local | ULID: 80 random bits per ms |
| `beliefId` | `blf_<Ulid>` | daemon | local | |
| `objectiveId` | `obj_<Ulid>` | daemon | global (sent to server) | server rejects a reused id from another device |
| `planId` | `pln_<Ulid>` | server | global | |
| `stepId` | `stp_<Ulid>` | server | global; `stepIndex` is the on-chain-visible position | |
| `deviceId` | `dev_<Ulid>` | server at pairing | global | |
| `envelopeId` | `uint64`, per-vault counter from 1 | vault | per vault; global ref `envelopeRef = Caip10(vault) + ":" + envelopeId` | counters never reuse |
| `reservationId` | `uint64`, per-vault counter from 1 | vault | per vault | |
| `pullbackId` | `uint64`, per-vault counter from 1 | vault | per vault | |
| `pocket` | the EOA address | server (KMS) | global | one pocket per (vault, envelope) |
| `jobKey` | `keccak256(abi.encode(address jobEscrow, uint256 jobId))` | vault | global | distinct escrow instances cannot collide |
| `repoId` (P2) | `keccak256(utf8("github:" + <numeric GitHub repository id>))` | claim server | global | GitHub numeric ids survive renames |
| `batchId` | `bat_<Ulid>` | evidence publisher | global | |
| `resultId` | `res_<Ulid>` | server | global | write-back download handle |
| `userId` | `usr_<Ulid>` | server | global | |
| `pushSubscriptionId` | `psh_<Ulid>` | server | per user | stage 2 (D69) |
| `quoteId` | `qte_<Ulid>` | server | global | `createQuote` results (each names a `planId` and `stepIndex`) and shadow-mode quotes (RV-020) |
| `payRequestId` | `prq_` + 32 lowercase hex | client (MCP `pay`) | per device | one id per `createPayRequest` call, reused on retry; maps to the per-index `paymentId`s the server mints (RV-050) |
| `claimId` (P2) | `clm_<Ulid>` | claim server | global | |
| `candidateId` | `cand_<Ulid>` | daemon | local only (belief candidate passed between the rules and P-04; never leaves the machine) | AM-15 |
| `userPseudonym` | `keccak256(abi.encode(userSecret, epoch))` | server, rotating per 90-day epoch | soul-version leaves only (RV-026) | `userSecret` is `SO` |
| `demandSalt` | `keccak256(abi.encode(userDemandSecret, vault, envelopeId))` | server | one per envelope; `SO`; revealed to the user on request | `userDemandSecret` is `SO` and separate from `userSecret` (RV-026) |

### 7.2 EIP-3009 nonce derivation (`czar-nonce-v1`)

- `NONCE_TAG = keccak256("czar.vault.nonce.v1")`.
- `nonce_i = keccak256(abi.encode(NONCE_TAG, address vault, uint64 reservationId, uint32 index))`.
- The vault recomputes `nonce_i` inside `isValidSignature` and refuses any nonce that is not the derived one for `(reservationId, index)` with `index < count`.
- Collision analysis: nonces are 256-bit keccak outputs over distinct tuples; two reservations of one vault differ in `reservationId`, two indices in `index`, two vaults in `vault`. EIP-3009 nonces are scoped per authorizer (`_authorizationStates[authorizer][nonce]`, `EIP3009.sol` line 48), so cross-vault equality would not matter anyway. A nonce is consumed at most once by USDC (`_requireUnusedAuthorization`, lines 296–303; `_markAuthorizationAsUsed`, lines 332–335).
- `validAfter` is always `0`. `validBefore` is the reservation's `validBefore`.

### 7.3 Burn-intent salts

- `salt = keccak256(abi.encode(NONCE_TAG, address vault, uint64 pullbackId))`. Unique per pullback; the Gateway replay id is the keccak of the byte-encoded `TransferSpec` (`TransferSpec.sol` lines 46–48), which includes the salt.

### 7.4 Payment ids (`payment-identifier` extension)

- Format: `pay_` + 32 lowercase hex (UUID v4 without dashes) = 36 characters, within the extension's 16–128 chars of `[A-Za-z0-9_-]` (`payment_identifier.md`, "id Format"; F1-06).
- One `paymentId` per authorization index: `paymentId(reservationId, index)` is minted **by the server** when the reservation is created and stored in `Reservation.paymentIds`. It is the x402 `payment-identifier` value for that index only.
- **Pay calls (RV-050):** a `createPayRequest` / MCP `pay` call carries a client-chosen `payRequestId` (`prq_` + 32 hex), not a `paymentId`. One call can use several indices; the response lists their `paymentIds`. `reportOutcome` takes the `payRequestId` and optionally one `paymentId`. **Superseded:** the MCP spec's "client-supplied `paymentId`". A retry of the same call reuses the same id and the same signed authorization. The server never signs a second authorization for an index that already has a payment id unless the first is proven unused (`authorizationState == false` after `validBefore`).
- The client sends the extension only when the 402 advertises `extensions["payment-identifier"]`; otherwise idempotency rests on the nonce alone (a merchant cannot settle the same nonce twice).
- `409 Conflict` from a merchant on a reused id with a different fingerprint is a hard stop for that step (no new authorization).

### 7.5 Retry semantics (spec 01 §14.2)

| Failure | Retry rule |
|---|---|
| network error before any 402 | retry freely |
| 402 received, authorization signed, request failed | retry with the same `PAYMENT-SIGNATURE` and `paymentId`, up to 3 times within `validBefore` |
| merchant returned 200 but acceptance failed | no payment retry; alternate payee only via a new reservation |
| `/settle` reported `settlement_pending` (A3-11) | reconcile `authorizationState` on-chain; never re-sign |
| reservation expired unused | `finalize` releases it; a new reservation gets new nonces and new payment ids |

---
## 8. Observer events

How each host's hook payload becomes an `ActivityEvent` (§4.1). Only field names documented in part 2 B1–B3 are used. Anything not listed in a "mapped" column is dropped at intake.

### 8.1 Host detection

The daemon runs these checks in order on every incoming payload and its process environment. The first match wins.

| Order | Host | Detection rule | Facts |
|---|---|---|---|
| 1 | Cursor | payload has `cursor_version`, or env `CURSOR_VERSION` is set. Cursor runs Claude Code hooks from `~/.claude/settings.json` by default with its own payload shape, so this check must come first. | B3-04, B3-09, B3-10 |
| 2 | Codex | payload has `hook_event_name` and `turn_id`, has no `prompt_id` and no `scratchpad_dir`, and either env `CODEX_HOME` is set or the payload has `model` with `permission_mode` in Codex's set (`default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions`). | B2-13 |
| 3 | Claude Code | payload has `session_id`, `transcript_path` and `hook_event_name`. | B1-02 |
| 4 | unknown | anything else is logged as a count and discarded. | — |

- A Claude Code payload also carries `cwd` and (after first input) `prompt_id`; Cursor's common fields are `conversation_id`, `generation_id`, `model`, `model_id`, `model_params`, `hook_event_name`, `cursor_version`, `workspace_roots`, `user_email`, `transcript_path` (B3-04). The absence of `session_id` on most Cursor events is why rule 1 keys on `cursor_version`.
- `ActivityEvent.host` is set from the matched rule; `hostVersion` from `cursor_version` (B3-04), Codex `cli_version` when present in `session_meta` (B2-24), or the Claude Code version if `SessionStart` carries it (B1-04).

### 8.2 Claude Code mapping

Hook configuration shape in the plugin's `hooks/hooks.json` (B1-08, B1-09, B1-38):

```json
{
  "description": "Czar observer",
  "hooks": {
    "PreToolUse": [{ "matcher": "Skill|mcp__.*|mcp__plugin_.*", "hooks": [{ "type": "http", "url": "http://127.0.0.1:<port>/v1/hooks", "headers": { "Authorization": "Bearer ${CZAR_HOOK_TOKEN}" }, "allowedEnvVars": ["CZAR_HOOK_TOKEN"], "timeout": 2, "onFailure": "continue" }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "http", "url": "http://127.0.0.1:<port>/v1/hooks", "timeout": 2, "onFailure": "continue" }] }]
  }
}
```

- Same handler shape for `PostToolUseFailure`, `UserPromptSubmit`, `UserPromptExpansion`, `SubagentStop`, `Stop`, `SessionStart`, `SessionEnd`. `http` handlers post the payload JSON to the daemon (B1-08). `onFailure: "continue"` keeps hooks fail-open (B1-11). The timeout is short so observation never slows the agent (B1-09, B1-10). Where `http` is unavailable, a `command` handler with `async: true` is equivalent (B1-09).
- `SessionEnd` hooks share a 1.5 s budget (B1-10), so the daemon flushes continuously; `SessionEnd` only closes the session record.
- `matcher` values other than letters, digits, `_`, `-`, space, `,` and `|` are unanchored regexes (B1-15); `mcp__.*` and `mcp__plugin_.*` are regexes, `Skill` is exact.

| Hook event (matcher) | `eventType` | Mapped fields → `ActivityEvent` | Facts |
|---|---|---|---|
| common (every event) | — | `session_id` → `sessionRef` (keccak256); `cwd` → `projectRef` (keccak256 of git root); `hook_event_name` → `provenance.hookEvent`; `agent_id` → `agentRef` (keccak256) when present | B1-02, B1-26 |
| `PreToolUse` (`Skill`) | `skill-use` | `tool_input.skill` → `toolName`; `tool_input.args` → `summary` (redacted, ≤ 2,000) | B1-05, B1-21, B1-23 |
| `PreToolUse` (`mcp__.*`, `mcp__plugin_.*`) | `mcp-call` | `tool_name` → `toolName` and parsed `mcp` (§8.5); `tool_input` → `summary` (redacted) | B1-05, B1-25 |
| `PostToolUse` (`*`) | `tool-result`, or `file-read` / `file-write` / `command` / `search` by `tool_name` (`Read`→file-read, `Edit`/`Write`/`NotebookEdit`→file-write, `Bash`→command, `Grep`/`Glob`/`WebSearch`→search), `mcp-call` for `mcp__*` | `tool_name` → `toolName`; `tool_input.file_path` (if present) → `fileRefs[]` (keccak256); `tool_response` → `summary` (redacted, ≤ 2,000, `trusted=false`); `duration_ms` → `durationMs`; `tool_use_id` dropped | B1-05 |
| `PostToolUseFailure` (`*`) | `tool-failure` (or `agent-refusal` when `is_interrupt` is false and `error` matches the refusal detector's patterns) | `tool_name` → `toolName`; `error` → `errorClass` (normalized) and `summary`; `is_interrupt` → kept as `summary` suffix; `duration_ms` → `durationMs` | B1-05 |
| `UserPromptSubmit` | `prompt` | `prompt` → `summary` (redacted, ≤ 2,000, `trusted=true`) | B1-04 |
| `UserPromptExpansion` | `skill-use` | `command_name` → `toolName`; `command_source` → `provenance.hookSource`; `command_args` → `summary` (redacted); `expansion_type` kept in `summary` prefix; `prompt` dropped | B1-04, B1-22 |
| `SubagentStop` | `subagent` | `agent_id` → `agentRef` (keccak256); `agent_type` → `toolName`; `last_assistant_message` → `summary` (redacted, ≤ 2,000, `trusted=false`); `agent_transcript_path` dropped | B1-06, B1-26 |
| `Stop` | `agent-refusal` when the refusal detector matches `last_assistant_message`, else `tool-result` | `last_assistant_message` → `summary` (redacted, ≤ 2,000, `trusted=false`); `background_tasks`, `session_crons`, `stop_hook_active` dropped | B1-03, B1-06 |
| `SessionStart` | `session-start` | `source` → `summary`; `model` → `summary` suffix; `session_title` → `summary` (redacted); resume fields dropped | B1-04 |
| `SessionEnd` | `session-end` | `reason` → `summary` | B1-06, B1-10 |

- **Dropped on every Claude Code event:** the contents behind `transcript_path` (never read; plaintext and asynchronous, B1-03, B1-30), `prompt_id`, raw `cwd` (hashed only), `permission_mode`, `effort`, `scratchpad_dir`, `tool_use_id`, any `last_assistant_message` beyond the redacted 2,000-char summary (always `trusted=false`), any `tool_response` beyond the summary, `agent_transcript_path`, `transcript_path` itself.
- `EndConversation` tool calls fire no hooks (B1-28), so a session may end without a `tool-result`; `SessionEnd` covers it.

### 8.3 Codex mapping

- Codex hooks share Claude Code's JSON contract (events, `hookSpecificOutput`, exit 2), so the same handler script serves both with branching on the host detected in §8.1 (B2-07, B2-13, B2-15). Only `command` and `mcp_tool` handlers run; `prompt` and `agent` are skipped (B2-10). Czar uses a `command` handler with `async: true`.
- **Trust gate:** every non-managed Codex hook must be reviewed and trusted in `/hooks`, and re-trusted after any change because trust is stored against a hash (B2-09). Onboarding includes this step, and plugin updates repeat it.
- `SessionEnd` gets at most 3 s and always runs synchronously (B2-11); nothing is uploaded there.
- Hosted tools such as `WebSearch` are not visible to hooks (B2-17); search activity in Codex is partial.
- Inside a subagent, `session_id` is the **parent** session id (B2-13); `agent_id` / `agent_type` from `PreToolUse` / `PostToolUse` fill `agentRef`.
- Skills have no hook event (B2-19). A skill use is inferred when `UserPromptSubmit.prompt` contains `$<skill-name>` or when a `PostToolUse` shell/read call touches a path ending in `SKILL.md`; such events get `provenance.hookSource = "inferred"`.

| Codex event | `eventType` | Mapped fields | Facts |
|---|---|---|---|
| common | — | `session_id` → `sessionRef`; `cwd` → `projectRef`; `hook_event_name` → `provenance.hookEvent`; `turn_id` dropped; `model` → `hostVersion` suffix only; `permission_mode` dropped | B2-13 |
| `PreToolUse` | `mcp-call` for `mcp__<server>__<tool>`, `skill-use` when inferred, else `tool-call` | `tool_name` → `toolName`; `tool_input` → `summary` (redacted); `agent_id`, `agent_type` → `agentRef`, `toolName` suffix; `tool_use_id` dropped | B2-14, B2-17 |
| `PostToolUse` | `command` (`Bash`/`exec_command`), `file-write` (`apply_patch`, `Edit`, `Write`), `mcp-call` (`mcp__*`), `tool-result` otherwise | as above plus `tool_response` → `summary` (redacted, `trusted=false`) | B2-14, B2-17 |
| `UserPromptSubmit` | `prompt` (plus an inferred `skill-use` for each `$name`) | `prompt` → `summary` (redacted) | B2-14, B2-19 |
| `SubagentStart` / `SubagentStop` | `subagent` | `agent_id` → `agentRef`; `agent_type` → `toolName`; `last_assistant_message` → `summary` (redacted, `trusted=false`); `agent_transcript_path` dropped | B2-14 |
| `Stop` | `agent-refusal` when matched, else `tool-result` | `last_assistant_message` → `summary` (redacted, `trusted=false`) | B2-14 |
| `SessionStart` / `SessionEnd` | `session-start` / `session-end` | `source` / `reason` → `summary` | B2-14 |
| `PreCompact` / `PostCompact`, `Interrupt`, `PermissionRequest` | not subscribed | — | B2-07 |

- Dropped: `transcript_path` (may be null and "isn't a stable interface", B2-13), rollout files under `~/.codex/sessions/` (not read as a primary source, B2-23, B2-24), the legacy `notify` hook (B2-20).

### 8.4 Cursor mapping

- Czar ships a native `~/.cursor/hooks.json` (`{"version": 1, "hooks": {...}}`, B3-01) or a Cursor plugin (B3-16), not a VS Code extension (B3-15). Because Cursor also runs Claude Code hooks from `~/.claude/settings.json` by default (B3-10), the daemon de-duplicates: when a Cursor-shaped payload arrives through the Claude Code hook path, it is mapped by this table, not §8.2.
- Per-script options used: `command`, `type: "command"`, `timeout`, `failClosed: false` (default), `matcher` (B3-05).

| Cursor event | `eventType` | Mapped fields | Facts |
|---|---|---|---|
| common | — | `conversation_id` → `sessionRef` (keccak256); `workspace_roots[0]` → `projectRef` (keccak256); `hook_event_name` → `provenance.hookEvent`; `cursor_version` → `hostVersion`; `generation_id`, `model`, `model_id` dropped | B3-04 |
| `preToolUse` | `tool-call` (`mcp-call` when `tool_name` matches `MCP:`) | `tool_name` → `toolName`; `tool_input` → `summary` (redacted); `cwd` → `projectRef` when `workspace_roots` is absent; `tool_use_id` dropped | B3-06, B3-07 |
| `postToolUse` | `tool-result` | `tool_name` → `toolName`; `tool_output` (JSON string) → `summary` (redacted, `trusted=false`); `duration` → `durationMs` | B3-06 |
| `beforeMCPExecution` / `afterMCPExecution` | `mcp-call` | `tool_name` → `mcp.tool`; `mcp_server_name` → `mcp.server`; `tool_input` (string) → `summary` (redacted); after: `result_json` → `summary` (redacted, `trusted=false`), `duration` → `durationMs`; `mcp_server_url` / `command` dropped | B3-06 |
| `afterShellExecution` | `command` | `command` → `summary` (redacted); `output` → `summary` suffix (redacted, `trusted=false`); `duration` → `durationMs`; `sandbox` dropped | B3-06 |
| `afterFileEdit` | `file-write` | file path (from the event payload) → `fileRefs[]` (keccak256) | B3-03 |
| `beforeReadFile` | `file-read` | file path → `fileRefs[]` (keccak256) | B3-03 |
| `subagentStart` / `subagentStop` | `subagent` | `subagent_id` → `agentRef` (keccak256); `subagent_type` → `toolName`; stop: `status`, `summary` (redacted, `trusted=false`) → `summary`; `duration_ms` → `durationMs`; `modified_files` → `fileRefs[]` (keccak256); `agent_transcript_path`, `task`, `parent_conversation_id`, `tool_call_id`, `subagent_model`, `git_branch` dropped | B3-07 |
| `sessionStart` / `sessionEnd` | `session-start` / `session-end` | `session_id` → `sessionRef`; `is_background_agent`, `composer_mode` → `summary`; end: `reason`, `final_status` → `summary`, `duration_ms` → `durationMs` | B3-08 |
| `beforeSubmitPrompt` | `prompt` | prompt text → `summary` (redacted) | B3-03, B3-10 |
| `afterAgentResponse` | `agent-refusal` when matched, else `tool-result` | `text` → `summary` (redacted, `trusted=false`) | B3-08 |
| `afterAgentThought`, tab events, `workspaceOpen` | not subscribed | — | B3-03 |

- **Dropped at intake, never stored:** `user_email` and env `CURSOR_USER_EMAIL` (personal data, B3-04, B3-09), `model_params`, raw `workspace_roots` (hashed only), `transcript_path` and `CURSOR_TRANSCRIPT_PATH`, `CURSOR_CODE_REMOTE`.
- Cursor is untested on this machine (B3 preamble); the table follows the documented payloads and is re-checked in spec 04.

### 8.5 Skill-use and MCP tool-name detection

- **Skill use needs both Claude Code paths** (B1-21, B1-22): a `/skillname` typed by the user bypasses `PreToolUse`, so the daemon records `skill-use` from (a) `PreToolUse` with `tool_name == "Skill"` and `tool_input.skill` (B1-23), and (b) `UserPromptExpansion` with `command_name` and `command_source`. Within one session, the daemon de-duplicates (a) and (b) that name the same skill within 5 s.
- **MCP tool names** (B1-25) are parsed with:

```
^mcp__(plugin_(?<plugin>[A-Za-z0-9_-]+?)_)?(?<server>[A-Za-z0-9_-]+)__(?<tool>.+)$
```

  - Plugin-bundled servers use `mcp__plugin_<plugin-name>_<server-name>__<tool>`, where characters outside `A-Za-z0-9_-` became `_`. A plugin name that itself contains `_` makes the `plugin` / `server` split ambiguous; the daemon resolves the split against the installed plugin list and falls back to the non-greedy match.
  - A matcher of just `mcp__memory` matches nothing; the configured matchers are `mcp__.*` and `mcp__plugin_.*` (B1-25).
  - Codex uses the same `mcp__<server>__<tool>` form (B2-17). Cursor's `preToolUse` matcher form for MCP tools is `MCP:<tool_name>`, and `beforeMCPExecution` gives `mcp_server_name` directly (B3-06, B3-07).
- Parsed results fill `ActivityEvent.mcp = {server, tool, plugin?}` and `eventType = mcp-call`; a Czar MCP server call (`server == "czar"`) is additionally tagged in `summary` so the drives engine does not treat Czar's own tools as unmet needs.

---

## 9. Messages and APIs

Full definition: `api/openapi.yaml` (OpenAPI 3.1; 28 paths, 29 operations; parsed with Ruby `YAML.safe_load` on 2026-10-18). This section is the summary.

### 9.1 Auth model

| Surface | Credential | How it is issued | Where it lives | Revocation |
|---|---|---|---|---|
| Daemon → server | `DeviceToken` bearer (K15) | Pairing: the app shows an 8-digit code (valid 5 min); the daemon posts it to `POST /v1/devices/pair` with a device label and platform; the server returns `deviceId` and the token once | OS keychain through `@napi-rs/keyring` (K14, K15; B6-17) | the app lists devices and revokes; a revoked token gets `401` with `czarCode: device-revoked` |
| App → server | `AppSession` bearer | `POST /v1/auth/session` with a WebAuthn assertion over a server challenge; the same passkey owns the MSCA (D26) | browser session storage of the installed web app | 24 h expiry, refreshed on use; `DELETE` not needed, sessions expire |
| Claim server (P2) | `GitHubOAuth` authorization code | D23 default path; admin permission on the repo is checked server-side | server session during the claim | GitHub app settings; token discarded after the check (E1-12: no resale of personal data) |

### 9.2 Routes

**Daemon surface (`DeviceToken`)**

| Method | Path | Idempotent? | Request → Response | Notes |
|---|---|---|---|---|
| POST | `/v1/devices/pair` | key required | `PairRequest` → `PairResponse` | no auth; code is single-use |
| POST | `/v1/objectives` | key required | `ObjectiveSubmission` (§4.4) → `ObjectiveStatus` | `422` if `objectiveHash` does not recompute (§5.2) |
| GET | `/v1/objectives?status=&cursor=` | yes | → page of `ObjectiveStatus` | |
| GET | `/v1/objectives/{objectiveId}` | yes | → `ObjectiveStatus` (status, plan summary, `resultId`) | |
| POST | `/v1/objectives/{objectiveId}/results/ack` | key required | `ResultAck` → `204` | write-back confirmation (CZ-11) |
| GET | `/v1/results/{resultId}` | yes | → `Result` (labelled provenance per step) | |

**Provider surface (EIP-712 `BriefRequest` signature, RV-025)**

| Method | Path | Idempotent? | Request → Response | Notes |
|---|---|---|---|---|
| GET | `/v1/jobs/{jobKey}/brief` (`getJobBrief`) | yes | headers `X-Czar-Provider-Address`, `X-Czar-Brief-Issued-At`, `X-Czar-Brief-Signature` → `JobBrief` (§4.21) | the signature is the job's `provider` over `BriefRequest(jobKey, issuedAt)` (§6.2), EOA or ERC-1271; `issuedAt` within `api.briefSignatureMaxAgeSeconds` 300; any other caller gets 404 (no existence oracle) |

| POST | `/v1/soul-versions` | key required | `SoulVersionSubmission` (§4.18 minus pseudonym) → `202` | queued for the next evidence batch |
| POST | `/v1/shadow/quotes` | key required | `ShadowQuoteRequest` → `Plan` with `shadow: true` | no envelope, no payment (CZ-08) |
| POST | `/v1/pay/requests` | key + `payRequestId` | `PayRequest` `{payRequestId, objectiveId, planId, stepIndex, calls?, maxAmount?, input?}` → `PayResponse` (`executing` \| `approval-required` + `elicitationUrl` \| `accepted` \| `rejected` \| `failed`) | canonical shape; the MCP `pay` tool mirrors it (D75). Pays only a step of an approved plan with an open envelope, within the step's `expectedCalls` (RV-019); `409` on a reused `payRequestId` with a different request (§7.4) |
| POST | `/v1/hooks/ingest-report` | key required | `IngestReport` (counts only, optional `shadowTotals`, AM-04) → `204` | no events, no text |
| POST | `/v1/services/search` (`findService`) | key required | `FindServiceRequest` → `FindServiceResponse` | backs MCP `find_service` (AM-01) |
| POST | `/v1/quotes` (`createQuote`) | key required | `QuoteRequest` → `QuoteResponse` | backs MCP `quote`; moves no money (AM-01) |
| POST | `/v1/outcomes` (`reportOutcome`) | key required | `OutcomeReport` → `OutcomeRecorded` | backs MCP `report_outcome` (AM-01) |
| POST | `/v1/models/complete` (`completeModelCall`) | key required, **never replayed** | `ModelCallRequest` → `ModelCallResponse` | model proxy for P-01, P-04, P-05, P-06; stores only token counts (D31, AM-02); a repeated key gets `409 replay-not-stored` (RV-043) |

**App surface (`AppSession`)**

| Method | Path | Idempotent? | Request → Response | Notes |
|---|---|---|---|---|
| POST | `/v1/auth/session` | key required | `SessionRequest` (WebAuthn assertion) → `SessionResponse` | no auth |
| GET | `/v1/me` | yes | → `Me` (MSCA, vault, balance mirror, per-category limits, frozen/paused) | |
| GET | `/v1/approvals?status=pending` | yes | → page of `ApprovalSummary` | the source of truth for approvals (FD-32) |
| GET | `/v1/approvals/{planId}` | yes | → `Plan` (§4.5) | payees, amounts, alternates shown in USD (D51) |
| POST | `/v1/approvals/{planId}/intent` | key required | → `ApprovalIntent` (`openEnvelope` calldata, `payeeRoot`, decoded args) | the app builds and submits the UserOp through Circle's bundler itself (D30, A6-19); Czar never submits owner UserOps |
| POST | `/v1/approvals/{planId}/submitted` | key required | `SubmittedNotice` (`userOpHash`) → `202` | lets the indexer match `EnvelopeOpened` |
| GET | `/v1/envelopes?state=` | yes | → page of `Envelope` (§4.8) | |
| GET | `/v1/envelopes/{envelopeRef}` | yes | → `EnvelopeDetail` (envelope, reservations, pockets, jobs) | |
| POST | `/v1/freeze/intent` | key required | `{action}` → `FreezeIntent` calldata | one-tap freeze; app submits the UserOp |
| GET | `/v1/ledger/receipts?cursor=` | yes | → page of `LedgerReceipt` | Gateway payments show `pending` until `completed` (A2-26) |
| GET | `/v1/ledger/monthly/{yyyy-mm}` | yes | → `MonthlyStatement` | ROI ledger (CZ-25) |
| POST | `/v1/push/subscriptions` (stage 2, D69) | key required | `PushSubscription` (`declarative: true`) → `PushSubscriptionCreated` | created only after a user tap (D2-02) |
| DELETE | `/v1/push/subscriptions/{id}` (stage 2, D69) | yes | → `204` | |
| GET | `/v1/soul/pointer` | yes | → `SoulPointer` (`available: false`, desktop URL) | D34: no soul view in the app in Phase 1 |

**Public surface (no auth, rate-limited; AM-07)**

| Method | Path | Idempotent? | Request → Response | Notes |
|---|---|---|---|---|
| GET | `/v2/x402/discovery/resources` (`listIndexResources`) | yes | → `IndexResourcesResponse` | Circle-compatible list shape (§12.1) |
| GET | `/v2/x402/discovery/search` (`searchIndexResources`) | yes | → `IndexSearchResponse` | spec search shape (A3-34) |
| GET | `/v1/snapshots`, `/v1/snapshots/{id}` (`listSnapshots`, `getSnapshot`) | yes | → snapshot list / JSON Lines | Phase 2 (`x-phase: 2`, SL-C11) |

**Local viewer surface (loopback only; AM-16):** `api/local-openapi.yaml` defines `getLocalSoul`, `editLocalBelief`, `getLocalSoulDiff`, `getLocalBeliefReceipts`, `getLocalShadowReport`, `getLocalEgress` on the daemon's Unix socket or `127.0.0.1`, with a local token and an `Origin` check (D3-08). Everything there is `local-only`.

**Claim surface (Phase 2, D23, D29)**

| Method | Path | Idempotent? | Request → Response | Notes |
|---|---|---|---|---|
| POST | `/v1/claims/github/start` | key required | `ClaimStart` → `ClaimGithubStartResponse` (authorize URL) | |
| POST | `/v1/claims/github/callback` | key required | `ClaimGithubCallback` → `ClaimStatus` | server checks admin rights, schedules the timelocked release (spec 01 §8.6) |
| POST | `/v1/claims/file/start` | key required | `ClaimStart` → `ClaimFileStartResponse` (one-time code, `FUNDING.json` text) | shape follows Drips' `FUNDING.json` idea (A8-08) with Czar's own key |
| POST | `/v1/claims/file/verify` | key required | `ClaimFileVerify` → `ClaimStatus` | reads the default branch through the GitHub API; `429` maps GitHub limits (E1-09, E1-10) |
| GET | `/v1/claims/{repoId}` | yes | → `ClaimStatus` (escrow balance, release status, timelock end) | `repoId` per §7.1 |

### 9.3 Idempotency

- Every creating `POST` requires `Idempotency-Key` (UUID). The server stores the key with a fingerprint of the body for 24 h. Same key and same body → the stored response is replayed with the original status code. Same key and different body → `409` with `czarCode: idempotency-conflict`.
- **Exception (RV-043):** `POST /v1/models/complete` never stores or replays a response, because D31 lets the proxy keep only token counts. It stores the key and fingerprint only; any second request with the same key gets `409 replay-not-stored`, and the daemon retries with a new key if it still needs the output.
- `POST /v1/pay/requests` is additionally keyed by `payRequestId` (§7.4, RV-050); a different request under the same `payRequestId` is `409`.
- `GET` and `DELETE` are naturally idempotent.

### 9.4 Error model

- `application/problem+json` (RFC 9457): `type` under `https://czar.dev/problems/`, `title`, `status`, `detail` (no user text), `instance`, `czarCode`, `retryable` (§2.3).
- Stable `czarCode` values used in Phase 1: `validation`, `idempotency-conflict`, `replay-not-stored` (RV-043), `device-revoked`, `session-expired`, `hash-mismatch`, `plan-expired`, `envelope-not-open`, `approval-required`, `payment-id-conflict` (now about `payRequestId`), `plan-not-approved`, `step-not-in-plan`, `step-calls-exhausted`, `step-cap-exhausted`, `input-not-in-template`, `input-redaction-hit` (RV-019, RV-021), `resource-not-indexed` (RV-019), `fetch-blocked` (RV-022), `rate-limited`, `upstream-unavailable` (retryable), `frozen`, `paused`.

### 9.5 Pagination and rate limits

- Cursor pagination: `?cursor=&limit=` (max 200, default 50); responses carry `items` and `nextCursor` (`null` at the end). Cursors are opaque and expire after 1 h.
- Rate limits (defaults): daemon 600 requests/min per device, app 120/min per session, claim 30/min per account. Headers `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` on every response; `429` is a problem with `retryable: true`.

### 9.6 Push payloads (stage 2, D69)

- Phase 1 sends no push; the in-app pending-approvals list (`listApprovals`) is the only approval channel (D69). The payloads below stay defined for stage 2 (`specs/05-build-plan/stage-2-backlog.md` §2, M-4).

- Declarative Web Push JSON `{"web_push": 8030, "notification": {"title", "body", "navigate", "app_badge"}}` for `approval-needed` and `result-delivered` (D2-06). Every push is visible; silent pushes are not sent because WebKit revokes the subscription (D2-04). The body carries only the redacted goal title and USD amounts (D51: USDC shows 1:1 as USD in Phase 1). Full examples: `mcp/czar-mcp-tools.md` §7.

### 9.7 What never crosses each link

| Link | Never sent | Why |
|---|---|---|
| Daemon → server | raw hook payloads, `ActivityEvent`s, soul text, `transcript_path` contents, file paths, `user_email`, the hourly value amount (band only) | D25, D31, B1-30, B3-04; schemas carry no `local-only` field |
| Server → daemon | other users' data, merchant bodies beyond the labelled `Result`, keys | spec 01 §11.1 |
| App ↔ server | passkey private material (assertions only), soul contents (D34), merchant raw bodies | D26, D34 |
| Server → push (stage 2) | anything beyond title, amount and a navigate URL | D2-06, §9.6 |
| Claim server → GitHub | nothing beyond the OAuth exchange and one file read | E1-12 |

---

## 10. MCP tools

Full definition: `mcp/czar-mcp-tools.md`. The local Czar MCP server (CZ-09) runs over stdio as a child of the person's agent, targets revision `2026-07-28` with a legacy path for older clients (D3-01, D3-02), reads its device token from `CZAR_DEVICE_TOKEN` (D3-07), and holds no keys. Approval is enforced by Czar's server and the vault, never by the client (D3-09); annotations are hints that clients may ignore (D3-10).

| Tool | Does | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` | Elicitation |
|---|---|---|---|---|---|---|
| `get_objectives` | lists objectives and their status | true | false | true | false | none |
| `find_service` | ranked candidates from the Selection Layer through `findService` (`POST /v1/services/search`, AM-01); structured fields only, no merchant text (spec 01 §15.5) | true | false | true | true | none |
| `quote` | prices and routes a step through `createQuote` (`POST /v1/quotes`, AM-01) (live 402, D37 routing); moves no money | true | false | false | true | URL mode to the approval page when a new envelope would be needed (D3-11) |
| `pay` | forwards `POST /v1/pay/requests` with exactly its shape (D75): one `(planId, stepIndex)` of an approved plan; the server reserves, signs, settles, screens, accepts and returns a `StepResult` (§4.15) | false | true | false | true | URL mode when the server answers `approval-required` (D3-04, D3-11); retry with the same `payRequestId` after approval |
| `report_outcome` | records useful / not useful / wrong / unused for a payment through `reportOutcome` (`POST /v1/outcomes`, AM-01); feeds receipts and earned autonomy | false | false | true | false | none |

- Every `pay` call carries a client-chosen `payRequestId` (`prq_` + 32 hex, §7.4, RV-050) and an `idempotencyKey`; retries reuse both.
- Form-mode elicitation is never used for spending or credentials (D3-11). URL mode points at `http://localhost/approve/<planId>` in Phase 1 (D78); the client must show the server name and target host before navigating.
- Errors are `isError: true` with a `StepError` (§4.16) in `structuredContent`.
- Dual era: `server/discover` plus the `_meta` protocol-version and client-capabilities keys for `2026-07-28`; `initialize` answered for `2025-11-25` and older. Which revision each host negotiates today is a GAP (part 2, D3), so both paths ship.
- Configuration snippets for the Claude Code plugin `.mcp.json` (B1-36; tool names become `mcp__plugin_czar_czar__<tool>`, B1-25), Codex `[mcp_servers.czar]` (B2-22) and Cursor `mcp.json` (B3-13) are in `mcp/czar-mcp-tools.md` §5.

---

## 11. x402 integration

Czar is both a seller (its own testnet merchants, D14, CZ-20) and a buyer (the paying agent, CZ-15). Both sides speak x402 v2 (A3-01).

### 11.1 What Czar's merchants put in `PAYMENT-REQUIRED`

- Transport: HTTP `402` with the `PAYMENT-REQUIRED` header holding base64 JSON `PaymentRequired` (A3-02). Czar never puts protocol data in the body.
- Vanilla x402 seller (Circle Facilitator settles): fields below (A3-04 to A3-06).

| Field | Value Czar sets | Rule / fact |
|---|---|---|
| `x402Version` | `2` | A3-01 |
| `error` | `"payment required"` | A3-04 |
| `resource.url` | the exact resource URL | A3-05 |
| `resource.description` | ≤ 200 chars, plain text | A3-05 |
| `resource.mimeType` | `application/json` | A3-05 |
| `resource.serviceName` | ≤ 32 printable ASCII | A3-05 |
| `resource.tags` | ≤ 5 tags, each ≤ 32 ASCII | A3-05 |
| `accepts[0].scheme` | `"exact"` | A3-06, p1-F5 |
| `accepts[0].network` | `"eip155:5042002"` (mainnet `"eip155:5042"`) | A3-06, p1-A1 |
| `accepts[0].amount` | `Amount6` string, for example `"100000"` | A3-06, §2.1 |
| `accepts[0].asset` | `0x3600000000000000000000000000000000000000` | A1-01 |
| `accepts[0].payTo` | the merchant payout key address (K10) | A3-06 |
| `accepts[0].maxTimeoutSeconds` | `300` (never above 600, so the vault's reservation TTL covers it; spec 01 §10.1) | A3-06 |
| `accepts[0].extra` | `{"name":"USDC","version":"2"}` (the USDC domain; `eip712Domain()` reverts, so clients need it) | A1-03, A3-06 |
| `extensions["payment-identifier"]` | `{"info":{"required":false},"schema":{…}}` exactly as in `payment_identifier.md` | F1-06 |

- Facilitator calls: `POST https://api.circle.com/v1/facilitator/x402/verify` and `/settle` with `network: "eip155:5042002"`; the same base URL serves testnet (A1-15). During the keyless trial the seller signs the `Facilitator-Seller-Proof` header (base64url EIP-712 `SellerRequest`, bound to purpose, method, body hash, network, nonce, 5-minute expiry) with the `payTo` key (p1-F4). After the trial, `403 registration_required` means a Console API key (K11) is needed (p1-F4). The keyless trial covers `exact` only (A1-15).
- Flow: Czar's seller declares no `extra.paymentFlow`, so the default `authorization` flow applies: verify → serve the resource → settle (A3-09). The handler runs only after `/verify` returns `isValid:true`; `/settle` runs only after the handler succeeded. A handler failure means no settle, so the buyer is not charged.
- Settlement response: the seller returns `PAYMENT-RESPONSE` with base64 JSON `SettlementResponse{success, transaction, network, payer, amount?}` (A3-08). `transaction` is the Facilitator's tx hash (A1-17 example `0x78d909c8…e66d`).
- Gateway nanopayment seller (second Czar merchant, so the pocket path is exercised): `createGatewayMiddleware({ sellerAddress, facilitatorUrl: "https://gateway-api-testnet.circle.com", networks })` from `@circle-fin/x402-batching/server` 3.5.0, then `gateway.require("$0.001")` (p1-G11, F2-01). The testnet facilitator URL is always explicit; omitting it means mainnet since SDK 3.0.0 (p1-G11). Settlement happens before the handler runs and there is no refund call (p1-G6). The seller is paid into its Gateway balance and withdraws with a same-chain transfer (A2-28, A2-16).
- Circle's live `/supported` lists `exact` and `upto` kinds and the `payment-identifier` and `settlement-status` extensions; no `batch-settlement` (A3-18). Czar's sellers offer `exact` only in Phases 1–2; `upto` is Phase 3 and needs a Console API key (A3-17).

### 11.2 Buyer parsing (CZ-15)

1. Send the request. On `402`, read the `PAYMENT-REQUIRED` header and base64-decode `PaymentRequired` (A3-02). If the header is absent and the body is JSON with `x402Version === 1`, parse the v1 body; any other `x402Version` is rejected (A3-03).
2. Validate the shape: `accepts` non-empty; each entry has `scheme`, `network`, `amount` (string of digits), `asset`, `payTo` (checksummed or lowercase hex), `maxTimeoutSeconds` (integer) (A3-06). Untrusted `extensions` go through §11.3 before anything else reads them.
3. Pick one `accepts` entry per spec 01 §8.7 routing and D37: prefer `exact` on the plan's network with `asset == USDC` for vault-direct; Gateway for pocket steps; refuse `upto` in Phases 1–2 and `batch-settlement` always (A3-25). Refuse any entry whose `network` is not the plan's network ("never switch chains", F1-07).
4. Compare `amount` and `payTo` with the plan's `Step.unitAmount` and `payee` or `alternates` (live 402 wins, p1-D7). If `amount > stepCap` or `payTo` is not in the step's leaves, stop the step (`StepError.code = "price-or-payee-drift"`).
5. Check `extra.paymentFlow` (A3-09): accept absent or `"authorization"`, accept `"escrow"`, refuse `"upfront"` unless `payTo` is in the plan's `trustedPayees` (spec 01 §8.3).
6. Reserve on-chain (spec 03 `czar-vault.md`), derive `nonce` per §7.2, set `validAfter = "0"` and `validBefore` = the reservation's `validBefore` (≤ `maxTimeoutSeconds` from now).
7. Build `PaymentPayload` (A3-07):

```json
{"x402Version":2,
 "resource":{"url":"https://merchant.example/v1/prices","description":"…","mimeType":"application/json"},
 "accepted":{"scheme":"exact","network":"eip155:5042002","amount":"100000","asset":"0x3600000000000000000000000000000000000000","payTo":"0x000000000000000000000000000000000000bEEF","maxTimeoutSeconds":300,"extra":{"name":"USDC","version":"2"}},
 "payload":{"signature":"0x<§6.3.1 envelope bytes, or 65-byte fallback>",
            "authorization":{"from":"0x<vault>","to":"0x000000000000000000000000000000000000bEEF","value":"100000","validAfter":"0","validBefore":"1760800000","nonce":"0x1f7eb762975d3148f76637d5498c320aa01d5daa71be09a5e6ca4947371fd59f"}},
 "extensions":{"payment-identifier":{"info":{"required":false,"id":"pay_3f9a0c2d4e5b6a7f8091a2b3c4d5e6f7"},"schema":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"required":{"type":"boolean"},"id":{"type":"string","minLength":16,"maxLength":128}},"required":["required"]}}}}
```

   - `from` is the vault (ERC-1271 payer, A1-13, A1-17). `signature` is the §6.3.1 envelope (416 bytes) in `envelope` mode or the 65-byte agent signature in `digest` mode (§6.3.4). Both go through USDC's `bytes` overload `0xcf092995`, which Circle's relayer already uses even for 65-byte signatures (A1-18, A1-20).
   - `payment-identifier` is included only when the 402 advertised it (F1-06, §7.4).
8. Retry the request with the `PAYMENT-SIGNATURE` header (A3-02). Reuse the identical header and `paymentId` on network retries (§7.5).
9. Read `PAYMENT-RESPONSE`, then `X-PAYMENT-RESPONSE` for v1 sellers (A3-03). Decode `SettlementResponse` (A3-08):
   - `success: true` and non-empty `transaction` → `PaymentRef{rail:"x402-exact", settlementTx: transaction}`; call `settle` on the vault (spec 03) after `authorizationState` reads `true`.
   - `errorReason: "settlement_pending"` with non-empty `transaction` → non-terminal (A3-11): poll `authorizationState(vault, nonce)` on-chain; never re-sign.
   - `success: false` → the step is unpaid; the reservation index releases after `validBefore`.
10. Hand the body to the reader model as untrusted text (spec 01 §13.1, §4.15). Never let the planner see it raw.

Invented `PaymentRef` capture:

```json
{"rail":"x402-exact","network":"eip155:5042002","asset":"0x3600000000000000000000000000000000000000","payer":"0x00000000000000000000000000000000000c2a21","payTo":"0x000000000000000000000000000000000000beef","amount":"100000","nonce":"0x1f7eb762975d3148f76637d5498c320aa01d5daa71be09a5e6ca4947371fd59f","validBefore":1760800000,"settlementTx":"0x78d909c8f9b9ac6827b616d25a1a1070078390492677dc8672597db41c06e66d","reservationId":12,"index":3}
```

`paymentRefHash` excludes `reservationId` and `index` (§4.12).

### 11.3 Sanitizing untrusted extensions

Seller-declared `extensions` (including `bazaar`) are data, not instructions (C3-04). Before any field is read (A3-36):

| Rule | Action |
|---|---|
| `info` must validate against the declared `schema` (JSON Schema 2020-12) | drop the whole extension on failure |
| `$ref` / `$id` pointing outside the document | never resolved; extension dropped |
| `serviceName` not printable ASCII ≤ 32 | soft-drop the field (SDK `isValidServiceName`) |
| `tags` > 5 or any tag > 32 ASCII | truncate per SDK `sanitizeTags` |
| `iconUrl` not `http(s)` or > 2048 chars | soft-drop (SDK `isValidIconUrl`) |
| whole `resource` metadata | `sanitizeResourceServiceMetadata` from `@x402/extensions` 2.28.0 |
| size caps | header ≤ 16 KiB after decode; `schema` ≤ 8 KiB; `routeTemplate` validated with `isValidRouteTemplate` (A3-35) |
| unknown extension keys | ignored; never forwarded to the planner |

Only `payment-identifier` (F1-06) is acted on in Phases 1–2. `sign-in-with-x` listings are skipped (A3-26, p1-D4).

### 11.4 The proven path

- Spec 01 §8.3 draws the full sequence; it is not repeated here.
- Experiment A1 (2026-10-18) is the reference encoding: a deployed ERC-1271 contract as `from`, a 65-byte owner signature passed as `payload.signature`, `/verify` → `isValid:true`, `/settle` → `success:true`, settled by Circle's relayer through the `bytes` overload `0xcf092995`, 96,739 gas, `AuthorizationUsed` and `Transfer` emitted, mined in block 67854309 (A1-17, A1-18). `x402-flow.mjs` lines 139–171 show the exact `PaymentPayload` construction.
- The §6.3.1 envelope is the same call with a longer `signature`. Whether Circle's off-chain `/verify` accepts the longer bytes is AR-3; §6.3.4 is the fallback and the vault accepts both.

---

---

## 12. Czar discovery-index item shape

Czar's index (CZ-18, SL-C2 lite) serves one item shape that both the Circle CLI (`CIRCLE_DISCOVERY_URL`, p1-D9) and x402 SDK clients can read. Circle's live items use a non-spec `metadata` object (A3-37, F4-02); the x402 spec uses `extensions.bazaar` and top-level `serviceName`/`tags` (A3-33). All extra fields are optional in both readers, so one item can carry both (part 2 A3 design implication).

### 12.1 Endpoints

| Endpoint | Response | Source |
|---|---|---|
| `GET /v2/x402/discovery/resources?limit=&offset=&network=&payTo=&scheme=&type=` | `{x402Version, items: [Item], pagination: {limit, offset, total}}` | A3-32, A3-37 (Circle's shape also uses `items` + offset paging; `limit` ≤ 200, p1-D1) |
| `GET /v2/x402/discovery/search?query=&cursor=&limit=` | `{x402Version, resources: [Item], partialResults?, pagination?: {limit, cursor} \| null}` | A3-34 (spec: note `resources`, not `items`) |

- Czar accepts the spec's `category` values and also returns `DATA_ENRICHMENT`, which Circle's own filter rejects with 400 although listings carry it (F4-03, p1-D5). `sort` is honoured by Czar (evidence first), unlike Circle where it is ignored (F4-03).

### 12.2 Item fields

| Field | Shape served | Reader | Grade / source |
|---|---|---|---|
| `resource` | URL string | both | A3-33, A3-37 |
| `type` | `"http"` (no `mcp` listings exist in Circle's catalog today, p1-D6 snapshot; Czar may add `mcp` per A3-35) | both | A3-33 |
| `x402Version` | `2` | both | A3-33 |
| `lastUpdated` | RFC 3339 | both | A3-33 |
| `accepts[]` | `PaymentRequirements[]` as in §11.1 | both | A3-33 |
| `description`, `mimeType`, `serviceName`, `tags`, `iconUrl` | spec top-level fields | x402 SDK | A3-33 |
| `extensions.bazaar` | `{info:{input, output?}, schema, routeTemplate?}` sanitized per §11.3 | x402 SDK | A3-35, A3-36 |
| `metadata.provider` | `{name, website, docsUrl, openApiUrl, description, category, tags}` | Circle CLI | A3-37, F4-02 |
| `metadata.path`, `metadata.method` | path and HTTP method | Circle CLI | A3-37 |
| `metadata.description`, `metadata.mimeType` | copies of the top-level values | Circle CLI | A3-37 |
| `metadata.input`, `metadata.output` | Circle's input/output shape (free-form objects; sanitized) | Circle CLI | A3-37 |
| `metadata.siwx` | boolean | Circle CLI | A3-31, A3-37 |
| `metadata.supportsVanillax402`, `metadata.supportsCircleGateway` | booleans, derived by Czar from the **live** 402, not copied | Circle CLI | A3-37, p1-D7 |
| `extensions.czar.serviceId` | SL `ServiceId` (`svc_…`) | Czar | SL §5.1 |
| `extensions.czar.claim.status` | `unclaimed \| domain-verified \| wallet-verified \| erc8004-claimed` | Czar | SL §5.3 |
| `extensions.czar.evidence` | `{deliveryLcb, structuralLcb, nEff, badges[]}` from the latest anchored snapshot, or `null` with `unverified: true` | Czar | SL-C9, SL-C10 |
| `extensions.czar.routing` | `{vaultDirect: bool, gateway: bool, upto: bool}` from the live 402 | Czar | spec 01 §8.7 |
| `extensions.czar.source` | `czar-registered \| circle-live \| onchain-lead` | Czar | SL-C2 sources |
| `extensions.czar.cache` | `{fetchedAt, expiresAt, etag?}` present only for `circle-live` | Czar | §12.3 |
| `extensions.czar.rail` | `x402-exact` \| `gateway-batched` (optional) on `czar-registered` items, so the two routes of one Czar service are told apart without parsing `accepts[]` | Czar | AM-17 |

### 12.3 Cache rules ("query live, don't mirror", D15, p1-D8)

- For `source: circle-live` items Czar persists only: `resource` (URL), `payTo`, `network`, `fetchedAt`, `expiresAt = fetchedAt + 3600 s` (Circle's `cache-control: public, max-age=3600, stale-while-revalidate=600`, p1-D2), and `etag` if returned. Nothing else from Circle's response is stored beyond process memory for the request that uses it.
- On a query, Czar fetches Circle live (keyless, p1-D1), merges in memory, serves, and discards descriptions and metadata. After `expiresAt` the item is re-fetched or dropped; it is never served from a stale copy.
- Evidence, claims and routing are keyed by `(payTo, origin)` and attached at serve time (SL-C1 attribution), never by Circle's record. Deleting the cache loses nothing of Czar's.
- `czar-registered` items (merchants that submitted a URL, SL-C2 source 1) are stored in full; the 402 is re-crawled every 24 h (SL-C2 refresh).
- Probe before paying: the live 402 wins over any item (p1-D7, about 10% drift).
- Grade: CONFIRMED for the shapes (live calls in A3-37, F4-01 to F4-03); the legal reading of Circle's §15 terms for live querying is AR-11 (low confidence, SL A7).

### 12.4 Invented example item

```json
{"resource":"https://prices.czar-merchant.example/v1/spot","type":"http","x402Version":2,"lastUpdated":"2026-10-18T12:00:00Z",
 "accepts":[{"scheme":"exact","network":"eip155:5042002","amount":"50000","asset":"0x3600000000000000000000000000000000000000","payTo":"0x000000000000000000000000000000000000bEEF","maxTimeoutSeconds":300,"extra":{"name":"USDC","version":"2"}}],
 "description":"Spot price for one asset pair as JSON","mimeType":"application/json","serviceName":"czar-spot","tags":["price","json"],
 "extensions":{"bazaar":{"info":{"input":{"type":"http","method":"GET","queryParams":{"pair":"BTC-USD"}},"output":{"type":"json"}},"schema":{"type":"object"}},
   "czar":{"serviceId":"svc_7f3a…","claim":{"status":"wallet-verified"},"evidence":{"deliveryLcb":0.91,"structuralLcb":0.88,"nEff":16.0,"badges":["single-source"]},"routing":{"vaultDirect":true,"gateway":false,"upto":false},"source":"czar-registered"}},
 "metadata":{"provider":{"name":"Czar Merchants","website":"https://czar-merchant.example","docsUrl":"https://czar-merchant.example/docs","openApiUrl":"https://czar-merchant.example/openapi.json","description":"Czar's own testnet merchants","category":"FINANCIAL_ANALYSIS","tags":["price"]},
   "path":"/v1/spot","method":"GET","description":"Spot price for one asset pair as JSON","mimeType":"application/json","input":{"pair":"string"},"output":{"price":"string"},"siwx":false,"supportsVanillax402":true,"supportsCircleGateway":false}}
```

---

---

## 13. Soul exports

Phase 2 (component CZ-10, spec 01 §4.1). Every export file is written on the user's machine only; privacy class `local-only` for the file and its contents. Nothing in this section is sent to the server.

### 13.1 `soul.json` → `SOUL.md` rendering rules

| Rule | Detail | Facts |
|---|---|---|
| Section order | `place`, `mission`, `rituals`, `friction`, `drives`, `taste`, `constraints`, `spendingPosture`; a section with no beliefs is omitted | product §6.3 |
| Header | one line: `# Work Soul (version <n>, compiled <date>)`, then one line stating that this file is written by Czar from observed work and that the person can edit any line in the Czar viewer | product §6.3 |
| Belief line | `- <text> (confidence <0.00–1.00>, last seen <YYYY-MM-DD>)`; one belief per line; beliefs sorted by confidence descending within a section | §4.2 |
| Receipts | omitted; event ids never appear in exports | §4.2, D25 |
| Redaction markers | kept verbatim (`[[R:…]]`, §3.1); never expanded | §3.1 |
| Size | total ≤ 20,000 characters including the header; when over, beliefs are dropped lowest-confidence first and a final line `- (truncated: <k> beliefs omitted)` is added | B5-05, B5-12 |
| Injection hygiene | no imperative instructions to the agent, no quoted attack phrases ("ignore previous instructions", role-play framing, tool-install commands); the renderer rejects a belief whose text matches the daemon's injection screen and keeps the previous rendering | B5-06, C3-04 |
| Encoding | UTF-8, LF line endings, no front matter | — |
| Atomic write | write to `<path>.tmp` then rename; keep the previous file as `<path>.czar-prev` for one version | — |
| User-owned files | if the target file exists and was not written by Czar (no `<!-- czar:soul v=… -->` marker on its first line), Czar does not overwrite it; it writes `SOUL.czar.md` beside it and tells the user | B5-02 (Hermes seeds and never overwrites its own) |

### 13.2 Per-tool paths and limits

| Tool | Path | Limit | What Czar writes | Facts |
|---|---|---|---|---|
| Hermes Agent | `~/.hermes/SOUL.md`, or `$HERMES_HOME/SOUL.md` when set (Windows default home `%LOCALAPPDATA%\hermes`) | `CONTEXT_FILE_MAX_CHARS` floor 20,000; over-limit files keep 70% head + 20% tail with a truncation marker | the rendered `SOUL.md` (≤ 20,000 chars). Note: Hermes treats `SOUL.md` as the agent identity (prompt slot #1) and blocks a distribution-installed file on an injection-scanner hit, so Czar writes as a user-authored file and keeps the identity framing neutral | B5-01, B5-02, B5-05, B5-06 |
| OpenClaw | `~/.openclaw/workspace/SOUL.md` (or `$OPENCLAW_WORKSPACE_DIR`, or `~/.openclaw-<profile>/workspace`) | per file `bootstrapMaxChars` 20,000; total `bootstrapTotalMaxChars` 60,000; `USER.md` capped at 4,000 | the rendered `SOUL.md` (≤ 20,000 chars). Rules that sub-agents must follow go into `AGENTS.md`, because sub-agent sessions inject only `AGENTS.md`; Czar does not write `USER.md` | B5-09, B5-10, B5-12, B5-13 |
| Claude Code | project `CLAUDE.md` or `./.claude/CLAUDE.md` gets one import line: `@.czar/soul-compact.md` (the compact rendering, ≤ 200 lines); the file itself lives at `.czar/soul-compact.md` | imports are relative to the importing file and at most 4 hops deep; a `CLAUDE.md` over 4 MiB is skipped; keep under 200 lines (startup warning on long files) | the import line plus the compact file; never the full `SOUL.md` | B1-41, B1-43, B1-44 |
| Codex | `AGENTS.md` at the project root gets a `## Czar` section (≤ 4 KiB) | `project_doc_max_bytes` 32 KiB is shared across all project `AGENTS.md` files; the file that crosses it is truncated silently | a short section only; the compact file is referenced by path, not inlined | B2-02, B2-03 |
| Cursor | `.cursor/rules/czar-soul.mdc` with front matter `description` and `alwaysApply: false` (Apply Intelligently) | rules should stay under 500 lines; plain `.md` in that folder is ignored | the compact rendering as an `.mdc` rule; `AGENTS.md` in the project root is also read by Cursor | B3-11, B3-12 |

- The compact rendering (`soul-compact.md`) is the `mission`, `friction` and `drives` sections only, ≤ 6,000 characters, so it fits every tool's smallest budget with room for the user's own instructions.
- **Marker family (AM-18):** Czar-written files start with one first-line marker so one parser recognises them: `<!-- czar:soul v=<n> hash=<soulVersionHash> -->` for soul exports and `<!-- czar:result v=1 objective=<objectiveId> result=<resultId> -->` for write-back result files (CZ-11).
- Every export file starts with `<!-- czar:soul v=<n> hash=<soulVersionHash> -->` so the daemon can tell its own files from the user's, and so a later version can prove which soul version was exported.
- Watching `~/.hermes/` and `~/.openclaw/workspace/` for changes is a cheap observer for those harnesses (B5-01, B5-09); it is part of CZ-10, Phase 2, and feeds `ActivityEvent` with `host` left as `unknown` until a host enum value is added in a minor schema bump.

---

## 14. Cross-reference to specs/03

| Definition here | Used in spec 03 |
|---|---|
| §2.1 `Amount6` (uint256 on-chain, 6 decimals) | every amount field in `czar-vault.md` |
| §5.2 `objectiveHash`, `planHash` | `openEnvelope` params and `EnvelopeOpened` event (`czar-vault.md` §5.2, §9.1) |
| §5.2 `reportHash` | ERC-8183 `reason` passed by the evaluator (`job-escrow-adapter.md` §3) |
| §5.2 `descriptionHash` | ERC-8183 `description = "czar:" + hex` (`job-escrow-adapter.md` §3, JOB-3) |
| §5.3 `czar-merkle-v1`, `PAYEE_LEAF`, `EVIDENCE_LEAF` | `reserve`/`openJob` proofs (`czar-vault.md` §5.3, §5.5); `open-evidence-log.md` leaf types |
| §6.1 domain separators (USDC, GatewayWallet, CzarVault, SelectionLayer) | vault immutables/constants (`czar-vault.md` §3) |
| §6.2 `TransferWithAuthorization`, `BurnIntent`, `TransferSpec` type hashes | `isValidSignature` §6.1, §6.2 |
| §6.2 `AutonomyRaise`, `OwnerAction` | `raiseAutoLimit`, `executeOwnerAction` (`czar-vault.md` §5.6, §7) |
| §6.3 kind tags and envelope encodings | `isValidSignature` dispatcher (`czar-vault.md` §6) |
| §6.3.4 fallback | `reserveWithDigests`, `digestSlot` |
| §6.4 test vectors | `security-and-testing.md` §3.1 (must be reproduced on-chain) |
| §7.1 `envelopeId`, `reservationId`, `pullbackId`, `jobKey`, `repoId` | vault counters and mappings; `BuilderEscrow` keys |
| §7.2 `NONCE_TAG`, `derivedNonce` | `czar-vault.md` §5.3, §6.1 step 4, §6.5 proof |
| §7.3 burn-intent salt | `requestPullback` |
| §4.8–§4.11 mirrors | rebuilt by the indexer from the events in `czar-vault.md` §9.1 |
| §4.17, §4.18 leaves | `open-evidence-log.md` Czar additions |

Reconciliation rule: a script in the build plan greps every `0x…` constant and type string that appears in both folders and fails CI on any mismatch (see `security-and-testing.md` §3.6).

---

## 15. Assumptions, open decisions, gaps, flags

### 15.1 Assumptions (adds to spec 01 §20)

| # | Assumption | Check | If false |
|---|---|---|---|
| AR-13 | A plain ERC-20 `transfer` of native USDC to the vault succeeds without invoking `receive()` and shows up in `balanceOf` (A1-05 precompile path) | `arc-anvil` test: transfer to a vault with and without `receive()` | keep `receive()` payable (already specified) and document that native sends need it |
| AR-14 | Circle's TEE calls `isValidSignature(digest, signature)` with exactly the EIP-712 digest of the `BurnIntent` under the chain-less GatewayWallet domain (A2-08, A2-19 proved it for a minimal contract) | AR-5 live test with the real vault | fall back to the pocket key's own 7-day withdrawal path |
| AR-15 | `GatewayMinter.isTransferSpecHashUsed` is exposed on the deployed testnet/mainnet minter proxies (it is in the verified 1.3.0 source via `GatewayCommon`) | `cast call` on `0x0022…475B` and `0x2222…C205` | credit pullbacks from the `AttestationUsed` event through the indexer plus owner confirmation |
| AR-16 | The deployed vault bytecode fits under 24,576 bytes with the WebAuthn and Gateway-hash code | `forge build --sizes` | split into an external library |
| AR-17 | Gas estimates in `czar-vault.md` §13 are within 2× of measured | `forge snapshot` | routing thresholds recomputed from measurements; D37 still holds by construction |

### 15.2 Open decisions for Zaryab

| # | Decision | Options | Recommendation | Confidence |
|---|---|---|---|---|
| OD-10 | `maxFeeRatioBps` for routing (D37 target) | 500 / 1000 / 2000 | 1000 (10%) | moderate |
| OD-11 | `MAX_AUTHORIZATIONS_PER_RESERVATION` | 64 / 128 / 256 | 128 (keeps `finalize` under 4 chunks of 32) | moderate |
| OD-12 | Earned-autonomy raise step `MAX_RAISE_STEP_BPS` and one raise per week | 1000 / 2000 | 2000 | low |
| OD-13 | Owner-only `recordManualReturn` for the 7-day pocket withdrawal path (adds an owner-trusted credit) vs. no manual path (funds credited only through the indexer with no on-chain un-spend) | keep / drop | keep; it only moves money from "pocket outstanding" to free balance when the vault balance really rose | moderate |
| OD-14 | Vault size: single contract vs. external `VaultLib` for WebAuthn and Gateway hashing | single / library | decide after `forge build --sizes` (AR-16) | unknown |
| OD-15 | Per-step caps in `PayeeLeaf` (`stepCap` per leaf) vs. one `maxStepAmount` only | per-leaf (chosen) / global | per-leaf; alternates share the step's cap as D36 says | high |
| OD-16 | `BuilderEscrow` `RELEASE_DELAY` 48 h and `MIN_TIP` 0.01 USDC (Phase 2) | as proposed / other | as proposed | low |

No locked decision is changed. Tensions noted: spec 01 §19 asked for a `sync()` that credits plain transfers; here free balance is live and `sync()` only emits (§4.8 note in `czar-vault.md` §12). Spec 01 §8.4 treated the pocket 25% cap as a total per objective in Phase 1; with trustless pullback confirmation, top-ups are safe in Phase 2 under the same 25% outstanding bound (D22 wording "at a time").

### 15.3 Gaps

| Gap | Effect | Closing step |
|---|---|---|
| AR-3 Facilitator signature length | mode selection | one keyless `/verify` (`security-and-testing.md` §3.4) |
| A2-G2 Gateway mainnet code hash | pullback semantics on mainnet | pre-mainnet checklist |
| A2-G3 delegate burns on mainnet | same | pre-mainnet checklist |
| GAP: Arc block gas limit | `finalize` chunk size, vault deployment cost | `cast block latest` on both networks before the build plan |
| GAP: `arc-forge` solc 0.8.30 availability | toolchain | `arc-forge build` in CI with `solc_version = 0.8.30` |
| GAP: which MCP revision Claude Code, Codex and Cursor negotiate today (D3 GAPs) | dual-era code path | probe at daemon start, log the version |
| GAP: Presidio non-English models | redaction quality for non-English users | Phase 2 |
| ~~GAP: `Me.displayCurrency` conversion source~~ | closed by D51: Phase 1 shows USD only (USDC 1:1); local currency is a later option | — |
| GAP: `ActivityEvent.host` enum lacks Hermes/OpenClaw observers | Phase 2 minor schema bump | CZ-10 |

### 15.4 Flags

Agent-directed text met this session (not followed): the Circle and Arc doc headers already recorded as FL-1 and FL-2 in part 2 (install skills, add an MCP server); the `AGENTS.md` contributor files in `x402-foundation/x402`, `0xSplits/splits-contracts-monorepo` and `circlefin/evm-gateway-contracts` (build instructions for agents editing those repos; read for layout only, no commands run; FL-4). No new agent-directed text was found in `stablecoin-evm`, `erc-8183/base-contracts` or OpenZeppelin sources read this session. No secrets were opened; key files seen by name only: `research/evidence/experiments/a1-erc1271-usdc/{owner,seller}.key`, `a2-gateway-e2e/{buyer,delegate,merchant}.key`.

---

## Change log

| Date | Id | Change |
|---|---|---|
| 2026-10-18 | AM-01 | §9.2, §10: added `findService`, `createQuote`, `reportOutcome` routes backing the MCP tools. |
| 2026-10-18 | AM-02 | §9.2: added the model proxy `completeModelCall`. |
| 2026-10-18 | AM-03 | `Me` gains `mode`, `shadowEndsAt`, `limits[].periodEndsAt`, `balances.pocketOutstanding` (openapi.yaml). |
| 2026-10-18 | AM-04 | §9.2: `IngestReport.shadowTotals`. |
| 2026-10-18 | AM-05 | `LedgerReceipt`: `merchantIsCzar`, `minutesSource`, status `quarantined` (openapi.yaml). |
| 2026-10-18 | AM-06 | `ApprovalIntent.decoded` fixed to `OpenEnvelopeParams` fields (openapi.yaml). |
| 2026-10-18 | AM-07 | §9.2: public index routes; Phase 2 snapshot routes. |
| 2026-10-18 | AM-08 / D53 | §4.11: `JobRecord.deliverableUri` and the `.well-known/czar-deliverable` convention. |
| 2026-10-18 | AM-09 | §4.6: `inputTemplate.expectedKeys`. |
| 2026-10-18 | AM-10 | §4.13, §6.3.3: job receipts signed under the vault's `SL_RECEIPT` kind. |
| 2026-10-18 | AM-11 | §4.14: acceptance `limits` vocabulary and `flags: injection-quarantined`. |
| 2026-10-18 | AM-12 | §4.1: `repeatCount`, `provenance.flags`. |
| 2026-10-18 | AM-13 | §4.2: `Belief.state`, `Belief.key` (local-only). |
| 2026-10-18 | AM-14 | §4.3: objective status `shadowed`. |
| 2026-10-18 | AM-15 | §7.1: `cand_` prefix. |
| 2026-10-18 | AM-16 | §9.2: pointer to the new `api/local-openapi.yaml`. |
| 2026-10-18 | AM-17 | §12.2: `extensions.czar.rail`. |
| 2026-10-18 | AM-18 | §13.2: marker family includes `czar:result`; `pairDevice` description. |
| 2026-10-18 | D51 | USD-only display; local-currency gap closed. |
| 2026-10-18 | D54 | §4.20: Phase 1 archives on Czar's server (`archiveUri`); IPFS `cid` is Phase 2. |
| 2026-10-18 | — | No EIP-712 type string, type hash or test vector changed. |
| 2026-10-19 | D69 | Push routes, push payloads (§9.6) and the push link in §9.7 tagged stage 2; soul-pointer wording no longer says phone. |
| 2026-10-19 | D69 | `psh_` id tagged stage 2. |
| 2026-10-19 | RV-002, RV-003 / D71 | §4.5 `pocket`, `pocketCapBps` rule; §4.7 kind-4 pocket leaf and per-step enforcement; `plan.schema.json` 1.1. |
| 2026-10-19 | RV-001, RV-004, RV-009, RV-011, RV-048 | §4.8 `shortfall`, `pocket`, derived `Closing`; §4.9 `releasedCount` rule; §4.10 derived `DelegateReady`, `recovery`; §4.11 `Released`; schemas `envelope`, `pocket-record`, `job-record` 1.1. |
| 2026-10-19 | RV-013 | §6.2 `ReceiptAttestation`; §6.3 `SL_RECEIPT` v2 tag and encoding; §6.3.3 rewritten; §6.3.5; §6.4 new vector; vectors regenerated (byte-for-byte reproducible). |
| 2026-10-19 | RV-033, D81 | §6.2 `OwnerAction` kinds 9–16 (type string unchanged). |
| 2026-10-19 | RV-061 | §6.4 `autonomyRaise` vector deadline inside its period; digest changed. |
| 2026-10-19 | D78 / RV-028 | §4.20 host-free `archiveUri` (`czar-archive:<root>`); `evidence-batch.schema.json` 1.1. |
| 2026-10-19 | — | Schema `$ref`s resolve against `https://czar.dev/schemas/common/1.0` (ajv now compiles all 19). |
| 2026-10-19 | RV-025 | §4.21 `JobBrief`; `inputCommit` defined; `getJobBrief` route; `BriefRequest` EIP-712 type and vector. |
| 2026-10-19 | RV-026 | §4.17 `DemandProofLeaf` v2 (no pseudonym, salted `soulVersionCommit`); `demandSalt`; v1 superseded. |
| 2026-10-19 | RV-019, RV-020, RV-021, RV-027, RV-043, RV-050 / D75 | §4.6 `inputKeys`; §7.1 `quoteId`, `payRequestId`; §7.4; §9.2–§9.4; §10. |
