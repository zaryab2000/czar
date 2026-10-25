# SCR-109: Three signer kinds rest on typed data the specs do not pin

| Field | Value |
|---|---|
| ID | SCR-109 |
| Filed by | Czar builder (tier 2), 2026-10-19 |
| Spec and section | `docs/specs/04-components/server/server-autonomy-roi-keys.md` CZ-27 §5.2 (`gateway-nano`, `merchant-seller-proof`); `docs/specs/02-data-and-protocol/data-and-protocol.md` §6 |
| Status | Open |

## Problem
- **`gateway-nano`:** spec 00 G2 / A2-11 name the domain `GatewayWalletBatched` v1 and the EIP-3009 struct. No spec gives the domain's `chainId` and `verifyingContract`, and 02 §6.4 has no vector. The signer takes the whole domain from configuration (`SignerNetwork.nanoDomain`).
- **`gateway-nano` step choice:** "cumulative per step ≤ that step's `stepCap`" does not say which step applies when two `gateway-nano` steps share a `payTo`. The signer uses the first matching kind-1 leaf.
- **`merchant-seller-proof`:** the CZ-27 request shape `{service, purpose, method, bodyHash, network, nonce, expiry}` lacks the `SellerRequest` fields `payTo` and `issuedAt`. The type string and domain (`Circle Facilitator Seller Request` v1, chainId) appear only in `docs/research/evidence/experiments/a1-erc1271-usdc/x402-flow.mjs`, not in 02. The signer sets `payTo` to its K10 address and `issuedAt = expiry − 300`.

## Evidence
- `apps/signer/src/policy.ts` (`gatewayNano`, `merchantSellerProof`).
- `x402-flow.mjs` lines 49–80 (the A1 experiment that confirmed F4).

## Proposed change
- Add both typed-data definitions (type string, domain fields, one vector each) to 02 §6. Verify the nanopayment domain from `@circle-fin/x402-batching` 3.5.0 `createPaymentPayload`.
- In CZ-27 §5.2 `gateway-nano`, add `stepIndex` to the request shape so the cap check names its step.
- In CZ-27 §5.2 `merchant-seller-proof`, state that `payTo` is the signing key's address and `issuedAt = expiry − 300`.

## Affected tasks
- T-035, T-043, T-036

## Decision
- 

## Note (2026-10-25)
- The `merchant-seller-proof` part is resolved by SCR-129 (the signer sets `SellerRequest.payTo` to the service's K10 address; the merchant gets the same address from `keyAddress`). The `gateway-nano` part stays open.
