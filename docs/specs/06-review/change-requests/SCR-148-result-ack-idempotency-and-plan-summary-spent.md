# SCR-148: Result-ack idempotency key, and `planSummary.spent`

| Field | Value |
|---|---|
| ID | SCR-148 |
| Filed by | chief architect, 2026-10-27, from PRs #106, #107, #108 |
| Spec and section | 02 §9.3 idempotency; OpenAPI `IdempotencyKey`, `ackResult`, `ObjectiveStatus.planSummary`; 02 §4.8 `Envelope` live counters (`:330`); SCR-147 (amended) |
| Status | Accepted (Zaryab's delegation for Track A closure; recorded by his merge) |

## 1. Result-ack idempotency
**OpenAPI and §9.3 win.** The architect's packet of 2026-10-27 said "Idempotency-Key = resultId". That was wrong and is replaced by the rules below.

### Header
- `Idempotency-Key` is a UUID v4, unchanged.
- **Client (T-126):** generates one UUID v4 per `resultId`. It persists it in the daemon database **before** the first send, and reuses it for every retry and every later `czar result <objectiveId>`.

### Request-level replay (§9.3, unchanged)
- Same key + same body → the stored response (204) is replayed.
- Same key + different body → `409 idempotency-conflict`.

### Domain-level rule: one acknowledgement per `resultId` (new)
- The first successful ack moves the result to acknowledged and records its `writtenAt` and `surface`.
- A later ack for the same `resultId` **with a different key** returns `204` and changes nothing. The first `writtenAt` wins.
- **Scope:**
  - The `resultId` in the body must be the result of `{objectiveId}`.
  - That objective must belong to the device token's user.
  - Otherwise `404`. Never confirm another user's objective or result exists.

### Required tests (#106 server, #108 client)
1. **Retry replay:** the same key and body sent twice → two `204`s and one stored acknowledgement.
2. **Key reuse with a changed body** (`writtenAt` differs) → `409 idempotency-conflict`, stored acknowledgement unchanged.
3. **A new key for an acknowledged `resultId`** → `204`, stored `writtenAt` unchanged.
4. **Scoping** → `404` for each case:
   - `resultId` of a different objective
   - an objective of another user
   - an unknown `resultId`
5. **Client:**
   - the UUID is persisted before the first send
   - a simulated network failure followed by a retry reuses the same key
   - a later `czar result` reuses it
   - a 5xx retries up to 3 times; a 4xx stops

## 2. `planSummary.spent`
- **Source of truth:** the on-chain envelope counter `spent` for the plan's envelope (02 §4.8, the live mirror of the vault). It comes from the existing indexer envelope read the server already uses (envelope reads by `envelopeRef`). Nothing else may be summed or estimated.
- **Values:**

  | Objective state | `spent` |
  |---|---|
  | Plan exists, no envelope yet (`awaiting-approval`, or `opening` before `EnvelopeOpened`) | `"0"`. True by construction: the vault cannot spend before the envelope exists. |
  | Envelope opened | the envelope's `spent` from the indexer |
  | Envelope closed | the final `spent` |
  | Envelope opened, but the indexer read fails or times out (`fetch.timeoutMs`) | **omitted** (the field is optional in OpenAPI); the other `planSummary` fields are still returned |

  - Never return `"0"` or a stale value for an opened envelope whose read failed.
- **The rest of `planSummary`:** `planId`, `cap`, `category` and `stepCount` come from the stored plan and are always present when a plan exists.
- **Required tests (#107):**
  1. `awaiting-approval` → `spent = "0"`, with `planId`, `cap`, `category`, `stepCount` present.
  2. Envelope opened, indexer fixture `spent = "0"` → `"0"`.
  3. After settlement, indexer fixture `spent = X` → `X` exactly (`Amount6` string).
  4. Indexer unavailable for an opened envelope → `spent` absent and the other fields present.
  5. Another user's objective → `404`.

## Merge gates
- **#107:** may merge once it implements §2 with tests 1–5.
- **#106:** may merge once its server ack follows §1 with tests 1–4.
- **#108:** may merge after #106, with §1 client test 5 and the rest of SCR-147.

## Decision
- Architect ruling under Zaryab's delegation. Recorded by his merge.
