# SCR-138: Interim selection snapshot — fields that reproduce eligibility and exclusions

| Field | Value |
|---|---|
| ID | SCR-138 |
| Filed by | chief architect, 2026-10-25, from the final review of PR #66 (TA-06 / T-123) at head `e7747ee` |
| Spec and section | `docs/specs/04-components/server/server-acceptance-evidence-selection.md` CZ-18 §5.2 interim producer ("Metadata (SCR-137)"); SCR-137 §1 (`policy_version` descriptor, `snapshot_id` snapshot shape) |
| Status | Accepted (Zaryab's delegation for TA-06; recorded by his merge of this change); Applied (2026-10-25) |

## Problem
- SCR-137 §1 promises that a decision is reproducible from `(policy_version, snapshot_id)` plus the decision's own `query`. But the snapshot it defines keeps one offer per **successfully probed** service, with `{payTo, amount, scheme, network}` only.
- TA-06's decision function (PR #66 `apps/server/src/selection/registered/index.ts` at `e7747ee`) reads more than that:
  - **Probe outcome:** a registered service whose probe failed is excluded with gate `probe-failed`. The snapshot drops such services (`makeSnapshot` filters `record !== null`), so the exclusion cannot be reproduced.
  - **Every offer, not one:** the `network`, `offer` and `price-over-budget` gates and the exploration price walk over **all** offers of the live 402. A single stored offer cannot reproduce which gate fired, or which offer was cheapest under `max_price_atomic`.
  - **Offer eligibility inputs:** `isUsableOffer` checks `scheme = exact`, `asset = USDC`, and three `extra` flags (`siwx`, `siwxOnly`, `paymentFlow = "batch-settlement"`). None of these is stored.
- The offer rule itself (`exact` + USDC + no SIWX + no batch settlement) is not in the policy descriptor, so a change to that rule would not change `policy_version`.

## Proposed change

### 1. Snapshot (replaces the SCR-137 §1 `services` entry shape)
`snapshot = {"kind":"czar-registered-interim-snapshot","policy_version":…,"network":…,"services":[…]}`.

- **`services`:** every entry of `selection.czarRegisteredServices` at decision time, whatever its capability and whatever its probe outcome, sorted by `serviceId`. Each entry is:

  | Field | Type | Source |
  |---|---|---|
  | `serviceId` | `SlServiceId` | config key |
  | `serviceName` | string | config |
  | `capabilities` | string[], sorted | config |
  | `resourceUrl` | string | config `resource.url` |
  | `method` | `GET` \| `POST` | config `resource.method` |
  | `probe` | object | below |

- **`probe`:** one of two shapes.
  - `{"state":"failed","probedAt":<RFC 3339>}`: the last probe did not yield a valid same-origin, same-path `402`. This covers every failure; no reason text is stored, because the decision's `excluded[].detail` is a fixed code.
  - `{"state":"ok","probedAt":<RFC 3339>,"offers":[…]}`: `offers` holds **every** entry of the live 402's `accepts[]`. Each offer is reduced to exactly:

    | Field | Type | Rule |
    |---|---|---|
    | `network` | `Caip2` \| `null` | the received value if it matches `^eip155:[1-9][0-9]{0,19}$` (02 `Caip2`), else `null` |
    | `scheme` | string \| `null` | the received value if it matches `^[a-z0-9-]{1,32}$`, else `null` |
    | `asset` | `Address` \| `null` | the received value lowercased if it matches `^0x[0-9a-fA-F]{40}$`, else `null` |
    | `amount` | `Amount6` | as received (`@czar/x402` already rejects an offer whose amount is not `Amount6`) |
    | `payTo` | `Address` | lowercased (`@czar/x402` already requires 40-hex) |
    | `siwx` | boolean | `extra.siwx === true` |
    | `siwxOnly` | boolean | `extra.siwxOnly === true` |
    | `batchSettlement` | boolean | `extra.paymentFlow === "batch-settlement"` |

    - `null` never equals the snapshot `network`, `"exact"` or `usdcAsset`, so a value that fails its pattern produces the same gate outcome as the raw value did. The raw value is not stored.
    - `offers` are sorted by `network`, `scheme`, `asset` (with `null` before any string), then `amount` as an integer, then `payTo`. Duplicate reduced offers are kept, so the count matches `accepts[]`.
    - No other `extra` content and no free seller text is stored. The three booleans are the only `extra` inputs the rule reads.
  - `probedAt` is the time of the probe attempt whose outcome the decision used. That includes a failed attempt, so the producer keeps the attempt time beside a failed result in its probe cache.
- Removed from the SCR-137 shape: the single top-level `payTo`, `amount`, `scheme`, `network` and `probedAt` per service. They now live inside `probe`.
- **Storage is unchanged** (SCR-137): exact JCS text in `selection_interim_snapshots.body_jcs`, `snapshot_id = keccak256(utf8(body_jcs))`, and `last_used_at` retention.

### 2. Policy descriptor (amends SCR-137 §1)
Add the offer rule so that changing it changes `policy_version`:

`{"policy":"czar-registered-interim","scr":"SCR-138","network":<selection.paymentNetwork>,"usdcAsset":<lowercase chain.usdcAddress>,"offerRule":"scheme-exact,asset-usdc,no-siwx,no-siwx-only,no-batch-settlement","unverifiedWithApproval":<selection.unverifiedWithApproval>,"exploration":"lowest-eligible-live-price-then-serviceId","ranked":"none"}`

### 3. Reproduction rule (normative)
Given the decision's `query` (`capability`, `max_price_atomic`) and the snapshot, the result is fully determined. For each service whose `capabilities` contains the query capability, in `serviceId` order:
1. `probe.state = failed` → excluded `probe-failed`.
2. No offer with `network` = snapshot `network` → excluded `network`.
3. No such offer that is usable (`scheme = "exact"`, `asset = usdcAsset`, all three booleans false) → excluded `offer`.
4. No usable offer with `amount ≤ max_price_atomic` → excluded `price-over-budget`.
5. Otherwise the service is eligible, at the lowest such `amount`.

- Each step's `excluded[]` entry keeps the fixed `detail` code CZ-18 already uses: `live-402-unavailable-or-malformed`, `wrong-network`, `no-payable-live-offer`, `live-price-exceeds-max`.
- `unverified[]` is the eligible set ordered by that amount, then `serviceId`, each with `reason: "n_eff_below_min"` and `n_eff: 0`.
- `exploration_slot` is the first `unverified[]` entry, with reason `no-ranked-candidate`, when `unverifiedWithApproval` is true and the set is non-empty.
- `candidates_considered` is the number of services whose capabilities contain the query capability.
- `ranked` is `[]`.
- Only `query_id` and `received_at` are not derived from the snapshot.

## Affected tasks
- T-123 / TA-06 (Lane 3, PR #66): `makeSnapshot`, the policy descriptor, and a test that rebuilds `excluded[]`, `unverified[]` and `exploration_slot` from the stored `body_jcs` alone, for a failed probe, a wrong-network offer, a SIWX-only offer, a batch-settlement offer, an over-budget offer and a mixed-offer service.
- No schema, route, table or config change.

## Decision
- Architect ruling for the PR #66 review, under Zaryab's delegation. It takes effect when Zaryab merges this change.

## Applied
- CZ-18 §5.2 interim producer metadata text.
- SCR-137 carries a pointer to this SCR.
