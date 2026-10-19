# Czar MCP server: tool definitions

- **Date:** 2026-10-18
- **Status:** draft, part of spec 02 (§10 summarizes this file).
- **What it is:** the local Czar MCP server (spec 01 CZ-09). It runs as a stdio child of the person's agent (Claude Code first), holds no keys, and forwards anything that could spend to Czar's server, which enforces envelopes and earned limits (D25, D3-09).
- **Protocol revision:** `2026-07-28` (D3-01), with legacy support for clients on `2025-11-25` or older (§6).
- **Transport:** stdio only (D3-07, D3-12). No HTTP listener, no OAuth. Credentials come from the environment (§5).

---

## 1. Rules that apply to every tool

| Rule | Why |
|---|---|
| Tool annotations are hints. Clients MUST treat them as untrusted unless they trust the server; Czar never relies on a client asking the user. Approval is enforced by Czar's server and the vault. | D3-09, D3-10 |
| Any tool that can lead to spending (`pay`, and `quote` when it needs a new payee or an over-allowance amount) returns a Multi Round-Trip `input_required` result in **URL mode**, pointing to the Czar approval page. Form mode is never used for anything that touches spending or credentials. | D3-04, D3-11 |
| Every result carries the required `resultType` (`"result"` or `"input_required"`). | D3-04 |
| Errors are returned as `isError: true` with a `StepError` (spec 02 §4.16) in `structuredContent`. Messages never contain user text. | spec 02 §2.3 |
| Inputs are validated against the schemas below before any network call. Unknown fields are rejected. | |
| Untrusted text from merchants never appears raw in a result; results carry `StepResult` objects (spec 02 §4.15) with labelled, JSON-encoded fields. | C3-04, spec 01 §13.1 |
| Amounts are `Amount6` strings (USDC atomic units). | spec 02 §2.1 |

---

## 2. Tools

### 2.1 `get_objectives`

- **Title:** Czar objectives
- **Description:** Lists the person's current objectives (candidate, awaiting approval, executing, delivered) from the daemon's local store and the server's status mirror. Read-only.
- **Annotations:** `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.
- **Elicitation:** none.
- **Input schema:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "status": { "type": "array", "items": { "type": "string", "enum": ["candidate", "awaiting-approval", "executing", "delivered", "failed"] }, "description": "Filter; default all." },
    "limit": { "type": "integer", "minimum": 1, "maximum": 50, "default": 20 },
    "cursor": { "type": "string", "maxLength": 512 }
  }
}
```

- **Output schema (`structuredContent`):**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["objectives", "nextCursor"],
  "properties": {
    "objectives": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["objectiveId", "goal", "capabilities", "status", "minutesSaved"],
        "properties": {
          "objectiveId": { "type": "string", "pattern": "^obj_[0-9A-HJKMNP-TV-Z]{26}$" },
          "goal": { "type": "string", "maxLength": 1000, "description": "Redacted goal text." },
          "capabilities": { "type": "array", "items": { "type": "string" } },
          "status": { "type": "string" },
          "minutesSaved": { "type": "integer" },
          "deadline": { "type": "string", "format": "date-time" },
          "envelopeRef": { "type": "string" },
          "cap": { "type": "string", "pattern": "^(0|[1-9][0-9]*)$" },
          "spent": { "type": "string", "pattern": "^(0|[1-9][0-9]*)$" }
        }
      }
    },
    "nextCursor": { "type": ["string", "null"] }
  }
}
```

### 2.2 `find_service`

- **Title:** Find a paid service
- **Description:** Asks Czar's server for ranked services for a capability through `findService` (`POST /v1/services/search`, AM-01), which runs the Selection Layer query (spec 01 §15.5). Returns structured candidates only: ids, prices, evidence bounds and badges. Never returns merchant description text.
- **Annotations:** `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true` (it queries Circle's catalog live, D15).
- **Elicitation:** none.
- **Input schema:**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["capability"],
  "properties": {
    "capability": { "type": "string", "maxLength": 64, "description": "Capability tag, lowercase kebab-case, e.g. web-search." },
    "taskClass": { "type": "string", "maxLength": 64 },
    "maxPrice": { "type": "string", "pattern": "^(0|[1-9][0-9]*)$", "description": "Amount6 cap per call." },
    "network": { "type": "string", "pattern": "^eip155:[0-9]+$", "default": "eip155:5042002" },
    "rails": { "type": "array", "items": { "type": "string", "enum": ["x402-exact", "gateway-batched", "erc8183-job"] } },
    "allowUnverified": { "type": "boolean", "default": false }
  }
}
```

- **Output schema:**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["ranked", "unverified", "insufficientEvidence", "policyVersion", "snapshotId"],
  "properties": {
    "ranked": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["serviceId", "rank", "price", "rail", "score", "badges", "evidenceAgeDays"],
        "properties": {
          "serviceId": { "type": "string" },
          "rank": { "type": "integer" },
          "price": { "type": "string", "pattern": "^(0|[1-9][0-9]*)$" },
          "rail": { "type": "string", "enum": ["x402-exact", "gateway-batched", "erc8183-job"] },
          "score": { "type": "number" },
          "badges": { "type": "array", "items": { "type": "string" } },
          "evidenceAgeDays": { "type": "number" },
          "missing": { "type": "array", "items": { "type": "string" } }
        }
      }
    },
    "unverified": { "type": "array", "items": { "type": "object", "additionalProperties": false, "required": ["serviceId", "nEff"], "properties": { "serviceId": { "type": "string" }, "nEff": { "type": "number" } } } },
    "insufficientEvidence": { "type": "boolean" },
    "policyVersion": { "type": "string" },
    "snapshotId": { "type": "string" }
  }
}
```

### 2.3 `quote`

- **Title:** Price a step
- **Server route:** `createQuote` (`POST /v1/quotes`, AM-01).
- **Description:** Builds a priced, routed step (or a whole plan for an objective) without paying: live 402 probe, routing (vault-direct, pocket, job; spec 01 §8.7, D37), step cap. If the step would need a payee outside any open envelope's `payeeRoot`, or an amount above the category's remaining auto-allowance, the result is an `input_required` URL-mode elicitation to the approval page, because a new envelope will be needed.
- **Annotations:** `readOnlyHint: true` (it moves no money), `destructiveHint: false`, `idempotentHint: false` (live prices change), `openWorldHint: true`.
- **Elicitation:** URL mode when approval would be required (D3-11). The tool itself never opens an envelope.
- **Input schema:**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["capability"],
  "properties": {
    "objectiveId": { "type": "string", "pattern": "^obj_[0-9A-HJKMNP-TV-Z]{26}$" },
    "capability": { "type": "string", "maxLength": 64 },
    "serviceId": { "type": "string", "maxLength": 40 },
    "resourceUrl": { "type": "string", "format": "uri", "maxLength": 2048 },
    "expectedCalls": { "type": "integer", "minimum": 1, "maximum": 128, "default": 1 },
    "maxAmount": { "type": "string", "pattern": "^(0|[1-9][0-9]*)$" },
    "category": { "type": "string", "maxLength": 32 }
  }
}
```

- **Output schema (normal result):**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["quoteId", "kind", "unitAmount", "expectedCalls", "stepCap", "routingReason", "approvalNeeded", "expiresAt"],
  "properties": {
    "quoteId": { "type": "string", "pattern": "^qte_[0-9A-HJKMNP-TV-Z]{26}$" },
    "kind": { "type": "string", "enum": ["x402-exact", "gateway-nano", "erc8183-job"] },
    "serviceId": { "type": "string" },
    "payee": { "type": "string", "pattern": "^0x[0-9a-fA-F]{40}$" },
    "unitAmount": { "type": "string", "pattern": "^(0|[1-9][0-9]*)$" },
    "expectedCalls": { "type": "integer" },
    "stepCap": { "type": "string", "pattern": "^(0|[1-9][0-9]*)$" },
    "routingReason": { "type": "string" },
    "approvalNeeded": { "type": "boolean" },
    "envelopeRef": { "type": "string", "description": "Open envelope that already covers this step, if any." },
    "expiresAt": { "type": "string", "format": "date-time" }
  }
}
```

- **Output when approval is needed (`resultType: "input_required"`):** see §4.

### 2.4 `pay`

- **Title:** Pay for a step
- **Description:** Executes a quoted step through Czar's server: the server reserves against the envelope, signs, calls the merchant, settles, runs acceptance and returns a `StepResult`. The local server holds no keys; it only forwards `POST /v1/pay/requests` with the device token. If no open envelope covers the step, the server answers `approval-required` and this tool returns a URL-mode elicitation. The client can never make Czar spend by itself.
- **Annotations:** `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`, `openWorldHint: true` (spec 01 FD-31). Idempotency is still guaranteed by `paymentId` and `idempotencyKey`.
- **Elicitation:** URL mode to the approval page when `status = approval-required` (D3-11). After the person approves in the Czar app (desktop browser in Phase 1, D69), the client retries the same call with the same `paymentId`.
- **Input schema:**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["paymentId", "idempotencyKey", "quoteId"],
  "properties": {
    "paymentId": { "type": "string", "pattern": "^pay_[0-9a-f]{32}$", "description": "Client-supplied, spec 02 §7.4. Reuse on retry." },
    "idempotencyKey": { "type": "string", "format": "uuid" },
    "quoteId": { "type": "string", "pattern": "^qte_[0-9A-HJKMNP-TV-Z]{26}$" },
    "objectiveId": { "type": "string", "pattern": "^obj_[0-9A-HJKMNP-TV-Z]{26}$" },
    "input": { "type": "object", "description": "Structured merchant input only. Never free user text (layer 3, spec 01 §11.2)." },
    "maxAmount": { "type": "string", "pattern": "^(0|[1-9][0-9]*)$", "description": "Must be ≤ the quote's stepCap." }
  }
}
```

- **Output schema (normal result):**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["paymentId", "status", "envelopeRef", "stepIndex"],
  "properties": {
    "paymentId": { "type": "string" },
    "status": { "type": "string", "enum": ["executing", "accepted", "rejected", "failed"] },
    "envelopeRef": { "type": "string" },
    "stepIndex": { "type": "integer" },
    "amount": { "type": "string", "pattern": "^(0|[1-9][0-9]*)$" },
    "paymentRefHash": { "type": "string", "pattern": "^0x[0-9a-f]{64}$" },
    "settlement": { "type": "string", "enum": ["reserved", "settled", "received", "completed"], "description": "Gateway payments show received, then completed 0–16 min later (A2-26)." },
    "result": { "$ref": "https://czar.dev/schemas/step-result/1.0" }
  }
}
```

### 2.5 `report_outcome`

- **Title:** Report an outcome
- **Server route:** `reportOutcome` (`POST /v1/outcomes`, AM-01).
- **Description:** Lets the person's agent report whether a delivered result was useful (good, bad, unused) and optionally attach a structured reason. Feeds the receipt's `outcome`, the ranking evidence and earned autonomy (spec 01 §15.1). Never moves money.
- **Annotations:** `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.
- **Elicitation:** none.
- **Input schema:**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["paymentId", "outcome"],
  "properties": {
    "paymentId": { "type": "string", "pattern": "^pay_[0-9a-f]{32}$" },
    "outcome": { "type": "string", "enum": ["useful", "not-useful", "wrong", "unused"] },
    "reasonCode": { "type": "string", "enum": ["missing-field", "stale", "incorrect", "slow", "format", "other"] },
    "minutesSavedActual": { "type": "integer", "minimum": 0 }
  }
}
```

- **Output schema:** `{ "type": "object", "additionalProperties": false, "required": ["recorded"], "properties": { "recorded": { "type": "boolean" }, "receiptObsId": { "type": "string" } } }`

---

## 3. Annotation summary

| Tool | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` | Elicitation |
|---|---|---|---|---|---|
| `get_objectives` | true | false | true | false | none |
| `find_service` | true | false | true | true | none |
| `quote` | true | false | false | true | URL mode when a new envelope would be needed |
| `pay` | false | true | false | true | URL mode when `approval-required` |
| `report_outcome` | false | false | true | false | none |

Defaults per the schema are `readOnlyHint false`, `destructiveHint true`, `idempotentHint false`, `openWorldHint true` (D3-10); the table sets each explicitly.

---

## 4. URL-mode elicitation (spending)

- Shape returned by `quote` and `pay` when approval is needed (Multi Round-Trip Request, D3-04): a result with `resultType: "input_required"` whose input request uses **URL mode** (D3-11) with `url` = the Czar approval page for that plan, for example `https://app.czar.dev/approve/pln_01K7…`, plus a short `message` such as "Czar needs your approval on your phone to spend up to $0.88 for this step."
- The client MUST show which server asks and the target host, and get consent before navigating (D3-11). Czar does not depend on that: nothing is spent until the owner's UserOp opens the envelope (D30).
- After approval the client retries with `inputResponses` carrying `{ "approved": true }` (or simply calls `pay` again with the same `paymentId`). The server checks the chain, not the client's claim.
- Form mode is never used for `pay`, `quote`, keys, tokens or anything that touches spending (D3-11).

---

## 5. Credentials and configuration

- The server reads `CZAR_DEVICE_TOKEN` (K15) and `CZAR_API_URL` from its environment (D3-07). It never prompts for them and never uses OAuth.
- The daemon writes the token into the plugin's data directory config so the agent host passes it as `env` (B1-37 for Claude Code).

**Claude Code plugin `.mcp.json` (plugin root, B1-36):**

```json
{
  "mcpServers": {
    "czar": {
      "command": "${CLAUDE_PLUGIN_ROOT}/bin/czar-mcp",
      "args": ["--stdio"],
      "env": { "CZAR_DEVICE_TOKEN": "${CLAUDE_PLUGIN_OPTION_DEVICE_TOKEN}", "CZAR_API_URL": "https://api.czar.dev" }
    }
  }
}
```

Tool names then appear as `mcp__plugin_czar_czar__pay` and friends (B1-25).

**Codex `config.toml` (B2-22, raw keys `command`, `args`, `env`):**

```toml
[mcp_servers.czar]
command = "/path/to/czar-mcp"
args = ["--stdio"]
env = { CZAR_DEVICE_TOKEN = "…", CZAR_API_URL = "https://api.czar.dev" }
```

**Cursor `.cursor/mcp.json` or `~/.cursor/mcp.json` (B3-13):**

```json
{ "mcpServers": { "czar": { "type": "stdio", "command": "/path/to/czar-mcp", "args": ["--stdio"], "env": { "CZAR_DEVICE_TOKEN": "${env:CZAR_DEVICE_TOKEN}" } } } }
```

---

## 6. Dual-era handling

- **Current era (`2026-07-28`, D3-02):** MCP is stateless. There is no `initialize` handshake and no `Mcp-Session-Id`. Every request carries `_meta` keys `io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientCapabilities`. The server MUST implement `server/discover` and does. Every result has `resultType`. Server-initiated requests do not exist; elicitation uses `input_required` results (D3-04).
- **Legacy era (`2025-11-25` and older, called "Legacy" by the spec):** the client opens with `initialize`. The server answers it with the legacy capabilities object and then serves `tools/list` and `tools/call` in the legacy shape. Elicitation in legacy clients that cannot handle `input_required` falls back to a plain result containing the approval URL in `content[].text` and `structuredContent.elicitationUrl`, with `isError: false`.
- **Detection:** if the first message is `initialize` → legacy path for that session. If a request carries `_meta["io.modelcontextprotocol/protocolVersion"]` → current path; the server echoes the negotiated version. Which revision Claude Code, Codex and Cursor negotiate today was not checked (part 2 GAP under D3), so both paths ship in Phase 1.
- Deprecated features (roots, sampling, logging, `ping`, `logging/setLevel`, HTTP GET stream) are not used on either path (D3-03, D3-05).

---

## 7. Push payloads (stage 2, D69; CZ-23)

- Phase 1 sends no push. Approvals appear only in the app's pending list (`listApprovals`). This section stays defined for stage 2 (`specs/05-build-plan/stage-2-backlog.md` §2, M-4).

Declarative Web Push JSON (iOS/iPadOS 18.4+, D2-06). Every push shows a visible notification; a push that shows nothing gets the subscription revoked (D2-04). The in-app pending-approvals list (`GET /v1/approvals?status=pending`) is the source of truth; push is only a hint (spec 01 FD-32).

**`approval-needed`:**

```json
{
  "web_push": 8030,
  "notification": {
    "title": "Czar needs your approval",
    "body": "Spend up to $0.88 on \"Competitor price table\"",
    "navigate": "https://app.czar.dev/approve/pln_01K7ZTA0B1C2D3E4F5G6H7J8K9",
    "app_badge": 1
  }
}
```

**`result-delivered`:**

```json
{
  "web_push": 8030,
  "notification": {
    "title": "Result delivered",
    "body": "Competitor price table: 4 of 5 rows, $0.45",
    "navigate": "https://app.czar.dev/objectives/obj_01K7ZTA0B1C2D3E4F5G6H7J8K9",
    "app_badge": 0
  }
}
```

- `body` holds only the redacted goal title and amounts in USD (D51); never merchant text or payee addresses.
- Keys used are exactly `web_push`, `notification.title`, `notification.body`, `notification.navigate`, `notification.app_badge` (D2-06). A service worker may rewrite the message but is not required.

---

## Change log

| Date | Id | Change |
|---|---|---|
| 2026-10-18 | AM-01 | `find_service`, `quote`, `report_outcome` now name their server routes (`findService`, `createQuote`, `reportOutcome`). |
| 2026-10-18 | D51 | Push bodies show USD amounts. |
| 2026-10-19 | D69 | Approval happens in the desktop-browser app in Phase 1; push payloads (§7) tagged stage 2. |
