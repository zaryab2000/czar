# SCR-129: Read-only public address lookup on the signer socket

| Field | Value |
|---|---|
| ID | SCR-129 |
| Filed by | chief architect, 2026-10-25 (Track A replan, baseline `ce17dad`) |
| Spec and section | `docs/specs/04-components/server/server-autonomy-roi-keys.md` CZ-27 §4 interface table; SCR-126 §1 (client surface); `docs/specs/04-components/server/server-supply-side.md` CZ-20 (merchant startup); SCR-109 (`merchant-seller-proof` part) |
| Status | Accepted (Zaryab, 2026-10-25); Applied (2026-10-25) |

## Problem
- Three runtime consumers need a public key address that only the signer holds:
  - The `czar-search` merchant needs its `K10:czar-search` `payTo` for the 402 (`apps/merchants/src/search/route.ts:30,67`) and for the seller-proof header (`apps/merchants/src/facilitator.ts:115-131`).
  - The acceptance checker needs the K7 validator address (`apps/server/src/acceptance/types.ts` `validatorIdentity.address()`). SCR-122 says it "comes from the signer service".
- No spec or code path delivers these addresses:
  - The socket (SCR-126 §1, `apps/signer/src/socket.ts:130,168-171`) exposes only `sign` and `createPocketKey`. CZ-27 §4 also names `retirePocketKey` and `getSecret` (`server-autonomy-roi-keys.md:358-363`), and neither is on the socket. None of them returns an existing key's address. `backend.address(keyRef)` exists only inside the signer (`apps/signer/src/backend.ts:14`).
  - `create-merchant-keys.ts:55` prints the K10 address once and stores it nowhere.
  - `indexer.merchantPayoutAddresses` is an unlabeled indexer filter list.
- SCR-109 left `merchant-seller-proof`'s `payTo` semantics open. The signer fills `payTo` with its own K10 address (`apps/signer/src/policy.ts:554`).

## Evidence
- The verification reports cited here are architect working papers outside the repository; every claim also carries a repository file:line.
- File:line references above; verification report B §3–§4.

## Proposed change
- **CZ-27 §4** gains one row:
  - `keyAddress(keyRef) → Address`: returns the public address of a key **the calling service is already allowed to sign with**, under the existing caller-to-key map (`LOCAL_CALLERS`, `apps/signer/src/runtime-adapters.ts:8-15`):
    - `cz-20` → `K10:<service>` with `service` in the signer's merchant service list
    - `cz-16` → `K7`
    - `cz-15` → `K3`
    - `cz-17` → `K8`
    - `cz-24` → `K5`
  - Any other key ref is refused with `key-not-allowed`.
  - Returns public data only, derived from the signer backend. No key material and no keystore path crosses the socket.
  - Each call writes no signing audit row.
  - It has its own limit, a new key `signer.keyAddressPerMin` (default 60; reason: startup and port refresh need a handful of calls per minute, and the existing `kms.maxSignaturesPerMin` limits are per key and apply only to `sign`, `apps/signer/src/service.ts:83-138`).
  - `cz-15` may read K3 but deliberately not K4. Pocket addresses already come back from `createPocketKey` and are recorded in `plan_pocket_keys`.
- **SCR-126 §1** client surface: `createSignerClient` exposes `sign`, `createPocketKey` and `keyAddress`.
- **CZ-20 merchant startup:**
  - Before listening, the merchant calls `keyAddress("K10:<service>")` for each served service and uses the result as `payTo` for the 402 and the seller-proof header.
  - A signer error stops startup (`merchant_signer_unavailable`). The merchant never starts with a configured or cached `payTo`.
  - If `indexer.merchantPayoutAddresses` is non-empty and does not contain the address, the merchant logs `merchant_payout_unindexed` (address only) and starts. That list only filters indexing; it is never a `payTo` source.
- **SCR-109, `merchant-seller-proof` part only, resolved:**
  - The request shape stays `{service, purpose, method, bodyHash, network, nonce, expiry}`.
  - The signer sets `SellerRequest.payTo` to the K10 address of `service`. The merchant builds the header with the same address from `keyAddress`.
  - The `gateway-nano` part of SCR-109 stays open; it is not needed by the vault-direct path.
- **Not chosen:**
  - A public addresses file or config key as the `payTo` source. Duplicated metadata could redirect buyer funds in the 402 without failing.
  - Recovering the address from a minted seller proof. That mints a real 5-minute proof at every start.

## Affected tasks
- T-035/SCR-126 (signer client, Lane 1), T-043 (merchant `czar-search`), T-047 port wiring.
- New tasks TA-02 and TA-05 in the Track A plan.

## Decision
- Accepted by Zaryab on 2026-10-25 with the Track A replan (context and briefs in `docs/builder-prompts/track-a/`).

## Applied
- CZ-27 §4 `keyAddress` row
- CZ-20 startup bullet (`server-supply-side.md`), which also resolves the `merchant-seller-proof` part of SCR-109
- `@czar/config`: `signer.keyAddressPerMin`
