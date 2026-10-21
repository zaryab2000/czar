# SCR-118: Specify Gateway transfer polling limits and projection shape

| Field | Value |
|---|---|
| ID | SCR-118 |
| Filed by | Codex, 2026-10-21 |
| Spec and section | `docs/specs/04-components/server/server-acceptance-evidence-selection.md` §5.3 and §5.6; `docs/specs/02-data-and-protocol/schemas/` |
| Status | Accepted (Zaryab, 2026-10-21); applied to CZ-19 §5.6 and `@czar/config` |

## Problem

- The Gateway poller spec requires `pageSize` ≤ 100 and cursor pagination but `@czar/config` has no page-size or request-timeout key. The builder rules require every limit and timeout to come from config.
- The `gateway_transfers` table lists fields and statuses but no exported `@czar/schemas` shape defines its status, timestamps, or amount representation. `PaymentRef` has no transfer status or timestamps.
- The poller needs a defined transition rule for Gateway statuses (`received`, `batched`, `confirmed`, `completed`, `failed`) so a stale or out-of-order API response cannot move a pocket payment backwards.
- CZ-19 filters Transfer events to known vault, pocket, and Czar merchant payout addresses, but the indexer task/config has no source for the configured merchant payout addresses.

## Evidence

- `docs/specs/04-components/server/server-acceptance-evidence-selection.md` §5.3 lists `id`, `status`, `fromAddress`, `toAddress`, `amount`, `nonce`, `txHash`, `createdAt`, and `updatedAt` for `gateway_transfers`.
- §5.6 requires `indexer.gatewayPollSeconds`, `pageSize` max 100, and cursor parsing from the `link` header.
- `packages/config/src/registry.ts` exports `indexer.gatewayPollSeconds` and `indexer.gatewayPollFailMax`, but no Gateway page-size or HTTP-timeout setting.
- `packages/schemas/src/generated/` exports `PaymentRef` and `Amount6`, but no `GatewayTransfer`/status projection type.
- The current indexer config has no merchant payout address registry to use for Transfer filtering or Gateway `?to=` polling.

## Proposed change

- Add config keys for Gateway API page size (bounded by 100) and request timeout, with defaults and reasons.
- Add a versioned schema/type for a Gateway transfer projection, including the exact amount representation, timestamp format, allowed statuses, and monotonic status transition rule.
- Specify the source and lifecycle for merchant payout addresses exposed to the indexer.
- State the fallback behavior for malformed pages, cursor loops, and status regressions.

## Affected tasks

- T-032 (Gateway transfer poller and pocket payment status)
- T-034 (indexer query API)
- T-071 (payment/quote/outcome routes)

## Decision

- 2026-10-21: **Accepted** (architect ruling under Zaryab's delegation), applied to CZ-19 §5.6:
  - Page size `indexer.gatewayPageSize` 100; request timeout reuses `fetch.timeoutMs` (no new key).
  - Payout addresses: `indexer.merchantPayoutAddresses` (`string[]`, default empty), set by T-040's local overlay; also feeds the §5.2 `Transfer` filter.
  - `gateway_transfers` is indexer-internal, so no `@czar/schemas` type: `amount` as `Amount6`, timestamps as the API's RFC 3339 strings, monotonic status rank with `failed` terminal except over `completed`; regressions ignored and logged.
  - A malformed page or repeated cursor ends the walk and counts as one error toward `indexer.gatewayPollFailMax`.
