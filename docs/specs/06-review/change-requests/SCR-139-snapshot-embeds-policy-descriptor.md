# SCR-139: Snapshot embeds the policy descriptor for self-contained replay

| Field | Value |
|---|---|
| ID | SCR-139 |
| Filed by | chief architect, 2026-10-25, from the Lane 3 report on PR #66 reproducibility gap |
| Spec and section | SCR-138 §1 (snapshot shape), SCR-138 §3 (reproduction rule); SCR-137 §1 (`policy_version` descriptor) |
| Status | Accepted (Zaryab's delegation for TA-06; recorded by his merge of this change) |

## Problem

SCR-138 §3 states: "Given the decision's `query` (`capability`, `max_price_atomic`) and the snapshot, the result is fully determined." That claim is false.

The reproduction rule needs two values that live only in the policy descriptor, which is hashed one-way into `policy_version` and never stored:

| Value | Used by | Gate / output affected |
|---|---|---|
| `usdcAsset` | `isUsableOffer`: `offer.asset === usdcAsset` | step 3 — `offer` exclusion |
| `unverifiedWithApproval` | controls whether `exploration_slot` is populated | `exploration_slot` output |

`policy_version = "pol_" + keccak(JCS(descriptor))[0:16]`. The raw descriptor is discarded after hashing. A replayer with only `(snapshot, query)` cannot recover these values and cannot reproduce the decision.

The snapshot table (`selection_interim_snapshots`) stores `body_jcs` (the JCS'd snapshot) and `snapshot_id` (its keccak hash). No column holds the descriptor or any of its fields.

A test that hardcodes the USDC address works today but violates the reproduction promise: the address comes from outside the stored record.

## Proposed change

### 1. Embed the descriptor in the snapshot (amends SCR-138 §1)

The snapshot shape gains a `descriptor` field containing the **full descriptor object** — the same object whose JCS text is hashed to produce `policy_version`:

```
snapshot = {
  "kind":             "czar-registered-interim-snapshot",
  "policy_version":   <pol_hash>,
  "descriptor":       <the descriptor object>,
  "network":          <Caip2>,
  "services":         [...]
}
```

The `descriptor` value is the object defined in SCR-138 §2:

```
{
  "policy":                    "czar-registered-interim",
  "scr":                       "SCR-138",
  "network":                   <selection.paymentNetwork>,
  "usdcAsset":                 <lowercase chain.usdcAddress>,
  "offerRule":                 "scheme-exact,asset-usdc,no-siwx,no-siwx-only,no-batch-settlement",
  "unverifiedWithApproval":    <selection.unverifiedWithApproval>,
  "exploration":               "lowest-eligible-live-price-then-serviceId",
  "ranked":                    "none"
}
```

**Verification invariant:** `"pol_" + keccak(JCS(snapshot.descriptor))[0:16]` equals `snapshot.policy_version`. The producer asserts this before storing. A replayer can verify it.

**Storage is unchanged.** The descriptor lives inside `body_jcs`. No new column, no new table.

**`snapshot_id` is unaffected in a different way than it appears.** `snapshot_id = keccak(body_jcs)`. Two snapshots that differ only in their descriptor (same services, different policy) already differ in `policy_version` and therefore already produce different `snapshot_id` values. Adding the raw descriptor alongside its hash changes the `snapshot_id` for every new snapshot, but snapshots are not referenced across policy changes — `last_used_at` retention handles cleanup.

### 2. Amend the reproduction rule (amends SCR-138 §3)

Replace:

> Given the decision's `query` (`capability`, `max_price_atomic`) and the snapshot, the result is fully determined.

With:

> Given the decision's `query` (`capability`, `max_price_atomic`) and the snapshot (which embeds the policy descriptor), the result is fully determined. The replayer reads `usdcAsset` and `unverifiedWithApproval` from `snapshot.descriptor`.

The five reproduction steps are unchanged. Step 3's `usdcAsset` and the `exploration_slot` population's `unverifiedWithApproval` are now sourced from `snapshot.descriptor` instead of being externally supplied.

### 3. `makeSnapshot` change

`makeSnapshot` receives or constructs the descriptor object (it already constructs it to compute `policy_version`). It includes the object as `descriptor` in the snapshot before JCS-encoding and hashing.

### 4. Reproduction test (amends SCR-138 "Affected tasks")

The reproduction test required by SCR-138 must:
- rebuild `excluded[]`, `unverified[]` and `exploration_slot` from the stored `body_jcs` alone — reading `usdcAsset` and `unverifiedWithApproval` from `snapshot.descriptor`, not from any import or hardcoded constant
- verify the `policy_version` invariant: `"pol_" + keccak(JCS(snapshot.descriptor))[0:16] === snapshot.policy_version`

## What this does NOT change

- The descriptor shape (SCR-138 §2) is unchanged.
- The `policy_version` hash algorithm is unchanged.
- The snapshot table schema is unchanged (no new columns).
- The reproduction steps and gate order (SCR-138 §3 steps 1–5) are unchanged.
- The `services` entry shape (SCR-138 §1) is unchanged.

## Affected tasks

- T-123 / TA-06 (Lane 3, PR #66): `makeSnapshot` embeds `descriptor`; reproduction test reads `usdcAsset` and `unverifiedWithApproval` from it.

## Decision

- Architect ruling under Zaryab's delegation for TA-06.
